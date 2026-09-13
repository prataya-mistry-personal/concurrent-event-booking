import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redisClient } from '../src/db/redis';
import { armQueryLatch, disarmAllLatches } from './helpers/latch';
import { reapExpiredHolds } from '../src/services/hold-reaper';
import {
  getJson,
  postJson,
  resetState,
  seedEvent,
  startTestServer,
  stopTestServer,
} from './helpers/env';

/**
 * Each test here corresponds to a concrete defect found in the original
 * implementation. They are written to fail against that implementation and to
 * pass once the corresponding fix lands, so every fix is backed by a test that
 * provably failed beforehand.
 */
describe('seat booking races', () => {
  let eventId: string;
  let seatId: number;

  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetState();
    const seeded = await seedEvent(20);
    eventId = seeded.eventId;
    seatId = seeded.seatId;
  });

  afterEach(() => {
    disarmAllLatches();
  });

  /**
   * BUG: holdSeat writes `status: 'HELD'` with an unconditional update, so a
   * request whose seat read happened before a confirmation can overwrite a
   * BOOKED seat back to HELD. The version check in checkoutSeat then matches and
   * confirms a second booking for the same seat.
   *
   * Interleaving forced below:
   *   B.read(AVAILABLE) -> A.hold -> A.checkout(BOOKED) -> B.acquire -> B.write(HELD) -> B.checkout
   */
  it('never confirms two bookings for one seat, even when a hold races a confirmation', async () => {
    // Park the very first seat read (B's) immediately after it returns, leaving
    // B holding a stale view of the seat while A completes an entire booking.
    const latch = armQueryLatch('Seat', 'findUnique');

    const bHoldInFlight = postJson('/bookings/hold', {
      userId: 'user-B',
      eventId,
      seatId,
    });
    await latch.reached;

    // A books the seat outright while B is parked on its stale read.
    const aHold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    expect(aHold.status).toBe(201);
    const aCheckout = await postJson('/bookings/checkout', {
      bookingId: aHold.body.booking.id,
      userId: 'user-A',
    });
    expect(aCheckout.status).toBe(200);

    // Release B. The seat is now BOOKED and A's lock has been released.
    latch.release();
    const bHold = await bHoldInFlight;

    if (bHold.status === 201) {
      await postJson('/bookings/checkout', {
        bookingId: bHold.body.booking.id,
        userId: 'user-B',
      });
    }

    const confirmed = await prisma.booking.count({
      where: { seat_id: seatId, status: 'CONFIRMED' },
    });
    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });

    expect(confirmed).toBe(1);
    expect(seat.status).toBe('BOOKED');
  });

  /**
   * Baseline: Redis SET NX already serialises simultaneous holds on a seat that
   * starts out AVAILABLE. This passes before the fixes too and is kept as a
   * regression guard so later changes cannot weaken the fast path.
   */
  it('admits exactly one winner when many users hold the same seat at once', async () => {
    const attempts = 50;
    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        postJson('/bookings/hold', { userId: `user-${i}`, eventId, seatId })
      )
    );

    const created = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(attempts - 1);

    const pending = await prisma.booking.count({
      where: { seat_id: seatId, status: 'PENDING' },
    });
    expect(pending).toBe(1);
  });

  /**
   * BUG: nothing reclaims a hold once its Redis key lapses. The seat stays HELD
   * and the booking stays PENDING forever, so a seat can accumulate several
   * live-looking PENDING holds and the availability count never recovers.
   */
  it('reclaims an abandoned hold instead of leaving a second live PENDING booking', async () => {
    const aHold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    expect(aHold.status).toBe(201);

    // Simulate the hold lapsing: its deadline passes and the Redis key expires.
    await prisma.booking.update({
      where: { id: aHold.body.booking.id },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });
    await redisClient.del(`seat_lock:${seatId}`);

    const bHold = await postJson('/bookings/hold', { userId: 'user-B', eventId, seatId });
    expect(bHold.status).toBe(201);

    const stale = await prisma.booking.findUniqueOrThrow({
      where: { id: aHold.body.booking.id },
    });
    const pending = await prisma.booking.count({
      where: { seat_id: seatId, status: 'PENDING' },
    });

    // The abandoned hold must be resolved, not left indistinguishable from a live one.
    expect(String(stale.status)).toBe('EXPIRED');
    expect(pending).toBe(1);
  });

  /**
   * BUG: checkoutSeat trusts Redis exclusively and never reads
   * `Booking.expires_at`, so a hold that is past its deadline still confirms
   * whenever the Redis key happens to survive.
   */
  it('rejects checkout once the hold deadline has passed', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    expect(hold.status).toBe(201);

    // Deadline passes while the Redis key is deliberately left in place.
    await prisma.booking.update({
      where: { id: hold.body.booking.id },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });
    expect(await redisClient.get(`seat_lock:${seatId}`)).not.toBeNull();

    const checkout = await postJson('/bookings/checkout', {
      bookingId: hold.body.booking.id,
      userId: 'user-A',
    });

    expect(checkout.status).toBe(409);

    const booking = await prisma.booking.findUniqueOrThrow({
      where: { id: hold.body.booking.id },
    });
    expect(String(booking.status)).not.toBe('CONFIRMED');
  });

  /**
   * BUG: checkoutSeat's ownership check is `if (userId && ...)`, so omitting
   * userId skips it entirely and any caller can confirm someone else's hold.
   */
  it('does not let an unidentified caller confirm another user booking', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    expect(hold.status).toBe(201);

    const checkout = await postJson('/bookings/checkout', {
      bookingId: hold.body.booking.id,
    });

    expect(checkout.status).toBe(403);
  });

  /**
   * BUG: an abandoned hold permanently removes a seat from the advertised
   * inventory because nothing returns it to AVAILABLE.
   */
  it('restores advertised availability after a hold is abandoned', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    expect(hold.status).toBe(201);

    const during = await getJson('/events');
    expect(during.body[0].available_seats).toBe(19);

    await prisma.booking.update({
      where: { id: hold.body.booking.id },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });
    await redisClient.del(`seat_lock:${seatId}`);

    await reapExpiredHolds();

    const after = await getJson('/events');
    expect(after.body[0].available_seats).toBe(20);
  });
});
