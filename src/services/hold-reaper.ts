import { config } from '../config';
import { prisma } from '../db/prisma';
import { releaseSeatLock } from '../lib/seat-lock';

/**
 * Reclaiming abandoned holds.
 *
 * A hold that is never checked out must not remove a seat from inventory
 * permanently. The original implementation had no path back: once the Redis key
 * lapsed the seat stayed HELD and the booking stayed PENDING forever.
 *
 * Expiry is driven by `Booking.expires_at` in the database rather than by the
 * Redis TTL. Both are set from the same instant with the same duration, but only
 * the database value survives a Redis restart, so it is the authoritative one.
 *
 * Two entry points share the same core:
 *  - `reclaimLapsedHoldsForSeat` runs inline when someone touches a seat, so the
 *    reclaim is immediate for the request that cares.
 *  - `reapExpiredHolds` sweeps periodically, so availability is corrected even
 *    for seats nobody is currently looking at.
 */

interface LapsedHold {
  id: string;
  seat_id: number;
  hold_token: string | null;
}

/**
 * Resolves a single lapsed hold: marks the booking EXPIRED and, if nothing else
 * legitimately holds the seat, returns the seat to AVAILABLE.
 *
 * Every write is guarded. A booking confirmed in the meantime is left alone
 * because the update requires `status: 'PENDING'`, and a seat that has since
 * been BOOKED is left alone because the update requires `status: 'HELD'`.
 */
async function resolveLapsedHold(hold: LapsedHold): Promise<boolean> {
  const now = new Date();

  const expired = await prisma.$transaction(async (tx) => {
    const marked = await tx.booking.updateMany({
      where: { id: hold.id, status: 'PENDING', expires_at: { lt: now } },
      data: { status: 'EXPIRED' },
    });

    // Lost the race: the booking was confirmed, cancelled, or already reaped.
    if (marked.count === 0) return false;

    // Another user may have taken a fresh, still-valid hold on this seat after
    // ours lapsed. Freeing the seat in that case would strand their hold.
    const liveHolds = await tx.booking.count({
      where: { seat_id: hold.seat_id, status: 'PENDING', expires_at: { gt: now } },
    });

    if (liveHolds === 0) {
      await tx.seat.updateMany({
        where: { id: hold.seat_id, status: 'HELD' },
        data: { status: 'AVAILABLE', version: { increment: 1 } },
      });
    }

    return true;
  });

  // Best effort, and owner-checked: if the token no longer owns the lock this is
  // a no-op rather than stealing someone else's.
  if (expired && hold.hold_token) {
    await releaseSeatLock(hold.seat_id, hold.hold_token);
  }

  return expired;
}

/** Reclaims any lapsed holds on one seat. Called inline before claiming a seat. */
export async function reclaimLapsedHoldsForSeat(seatId: number): Promise<number> {
  const lapsed = await prisma.booking.findMany({
    where: { seat_id: seatId, status: 'PENDING', expires_at: { lt: new Date() } },
    select: { id: true, seat_id: true, hold_token: true },
  });

  let reclaimed = 0;
  for (const hold of lapsed) {
    if (await resolveLapsedHold(hold)) reclaimed += 1;
  }
  return reclaimed;
}

/** Batch size per sweep, so one pass cannot monopolise the connection pool. */
const REAP_BATCH_SIZE = 500;

/**
 * Sweeps every lapsed hold in the system. Returns how many were reclaimed.
 * Uses the `Booking(status, expires_at)` index added in the hardening migration.
 */
export async function reapExpiredHolds(): Promise<number> {
  const lapsed = await prisma.booking.findMany({
    where: { status: 'PENDING', expires_at: { lt: new Date() } },
    select: { id: true, seat_id: true, hold_token: true },
    orderBy: { expires_at: 'asc' },
    take: REAP_BATCH_SIZE,
  });

  let reclaimed = 0;
  for (const hold of lapsed) {
    if (await resolveLapsedHold(hold)) reclaimed += 1;
  }
  return reclaimed;
}


export interface RunningReaper {
  /** Stops the schedule and waits for any in-flight sweep to finish. */
  stop: () => Promise<void>;
}

/**
 * Starts the periodic sweep.
 *
 * Lazy reclaim alone is not enough: it only fires when somebody touches a
 * specific seat, so an untouched seat's advertised availability would stay wrong
 * indefinitely. The sweeper is what makes inventory eventually correct without
 * anyone having to ask.
 */
export function startHoldReaper(intervalMs: number = config.reaperIntervalMs): RunningReaper {
  let sweeping = false;
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const sweep = async (): Promise<void> => {
    // A slow sweep must not overlap the next tick, or two passes would contend
    // over the same rows.
    if (sweeping || stopped) return;
    sweeping = true;
    try {
      const reclaimed = await reapExpiredHolds();
      if (reclaimed > 0) {
        console.log(`[hold-reaper] reclaimed ${reclaimed} expired hold(s)`);
      }
    } catch (error) {
      // A failed sweep must never take the process down; the next tick retries.
      console.error('[hold-reaper] sweep failed:', error);
    } finally {
      sweeping = false;
    }
  };

  const timer = setInterval(() => {
    inFlight = sweep();
  }, intervalMs);

  // The HTTP listener keeps the process alive, so the reaper should not by itself
  // prevent a clean exit.
  timer.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
