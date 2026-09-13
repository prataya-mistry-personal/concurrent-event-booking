import { Prisma } from '@prisma/client';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { prisma } from '../db/prisma';
import { acquireSeatLock, newHoldToken, readSeatLock, releaseSeatLock } from '../lib/seat-lock';
import { notFound } from '../lib/errors';
import { reclaimLapsedHoldsForSeat } from '../services/hold-reaper';

/** Raised when the guarded claim finds the seat is no longer available. */
class SeatUnavailableError extends Error {}
/** Raised when the optimistic version check loses its race. */
class OptimisticLockError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * POST /bookings/hold
 *
 * Claims a seat for a bounded period. Correctness rests on the guarded
 * conditional write in step 4, not on the Redis lock: the lock only makes
 * contention cheap and gives losers a fast rejection.
 */
export const holdSeat = async (req: Request, res: Response, next: NextFunction) => {
  const { userId, eventId, seatId } = req.body;

  if (!userId || !eventId || seatId === undefined || seatId === null) {
    res.status(400).json({ error: 'userId, eventId, and seatId are required.' });
    return;
  }

  const parsedSeatId = Number(seatId);
  if (!Number.isInteger(parsedSeatId)) {
    res.status(400).json({ error: 'seatId must be a valid integer.' });
    return;
  }

  // Normalised up front. The original code compared a raw body value against a
  // string column, so a numeric eventId produced a spurious 404.
  const eventIdValue = String(eventId);
  const userIdValue = String(userId);

  try {
    // 1. Confirm the seat exists and belongs to the event.
    const seat = await prisma.seat.findUnique({ where: { id: parsedSeatId } });

    if (!seat || seat.event_id !== eventIdValue) {
      res.status(404).json({ error: 'Seat not found for the specified event.' });
      return;
    }

    if (seat.status === 'BOOKED') {
      res.status(409).json({ error: 'Seat is already permanently booked.' });
      return;
    }

    // 2. Lazy reclaim. If the seat is HELD by a hold that has already lapsed,
    //    resolve it now so this request can proceed instead of being blocked by
    //    an abandoned hold.
    if (seat.status === 'HELD') {
      await reclaimLapsedHoldsForSeat(parsedSeatId);
    }

    // 3. Take the distributed lock with a per-hold fence token.
    const holdToken = newHoldToken();
    const acquired = await acquireSeatLock(
      parsedSeatId,
      holdToken,
      config.holdDurationSeconds
    );

    if (!acquired) {
      res.status(409).json({ error: 'Seat currently held by another user.' });
      return;
    }

    const expiresAt = new Date(Date.now() + config.holdDurationSeconds * 1000);

    try {
      const booking = await prisma.$transaction(async (tx) => {
        // 4. The actual correctness boundary: claim the seat only if it is
        //    AVAILABLE *at write time*. The original code issued an
        //    unconditional `update`, so a request holding a stale read could
        //    overwrite a BOOKED seat back to HELD and then confirm a second
        //    booking for it.
        //
        //    Deliberately predicated on status rather than on the version read
        //    in step 1. A version predicate would also reject the benign case
        //    where another user held and released the seat in between, leaving
        //    it genuinely AVAILABLE. Version is what guards the *confirm*.
        const claimed = await tx.seat.updateMany({
          where: { id: parsedSeatId, event_id: eventIdValue, status: 'AVAILABLE' },
          data: { status: 'HELD', version: { increment: 1 } },
        });

        if (claimed.count === 0) {
          throw new SeatUnavailableError();
        }

        return tx.booking.create({
          data: {
            user_id: userIdValue,
            event_id: eventIdValue,
            seat_id: parsedSeatId,
            status: 'PENDING',
            hold_token: holdToken,
            expires_at: expiresAt,
          },
        });
      });

      res.status(201).json({
        message: 'Seat held successfully.',
        booking,
        expires_at: expiresAt.toISOString(),
      });
    } catch (error) {
      // Never leave the lock behind on a failed claim. Owner-checked, so this
      // cannot delete a lock that has since been taken by someone else.
      await releaseSeatLock(parsedSeatId, holdToken);

      if (error instanceof SeatUnavailableError) {
        res.status(409).json({ error: 'Seat is no longer available.' });
        return;
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * POST /bookings/checkout
 *
 * Converts a live hold into a confirmed booking.
 */
export const checkoutSeat = async (req: Request, res: Response, next: NextFunction) => {
  const { bookingId, userId } = req.body;

  if (!bookingId) {
    res.status(400).json({ error: 'bookingId is required.' });
    return;
  }

  try {
    const booking = await prisma.booking.findUnique({
      where: { id: String(bookingId) },
      include: { seat: true },
    });

    if (!booking) {
      res.status(404).json({ error: 'Booking not found.' });
      return;
    }

    // Ownership is mandatory. The original check was `if (userId && ...)`, so
    // omitting userId skipped it altogether and any caller could confirm anyone's
    // hold. There is no real authentication here (see README limitations), but an
    // unidentified caller must still be refused rather than trusted.
    if (!userId || booking.user_id !== String(userId)) {
      res.status(403).json({ error: 'User does not match the booking owner.' });
      return;
    }

    if (booking.status === 'CONFIRMED') {
      res.status(409).json({ error: 'Booking is already confirmed.' });
      return;
    }

    if (booking.status !== 'PENDING') {
      res
        .status(409)
        .json({ error: `Booking is ${booking.status.toLowerCase()} and can no longer be confirmed.` });
      return;
    }

    // Database-side deadline check, independent of Redis. The original code
    // trusted Redis exclusively and never read expires_at, so a hold past its
    // deadline still confirmed whenever its Redis key happened to survive.
    if (!booking.expires_at || booking.expires_at.getTime() <= Date.now()) {
      // Free the seat immediately rather than waiting for the next sweep.
      await reclaimLapsedHoldsForSeat(booking.seat_id);
      res.status(409).json({
        error: 'Seat hold has expired. Please hold the seat again before checkout.',
      });
      return;
    }

    // Fence token check. Comparing against the per-hold token rather than the
    // user id means a different hold by the same user cannot be mistaken for
    // this one.
    const lockToken = await readSeatLock(booking.seat_id);

    if (!lockToken) {
      res.status(409).json({
        error: 'Seat hold has expired. Please hold the seat again before checkout.',
      });
      return;
    }

    if (!booking.hold_token || lockToken !== booking.hold_token) {
      res.status(409).json({ error: 'Seat hold is invalid or owned by another user.' });
      return;
    }

    const currentVersion = booking.seat.version;

    try {
      const confirmedBooking = await prisma.$transaction(async (tx) => {
        // Optimistic concurrency control: confirm only if the seat is still the
        // exact HELD row this hold observed.
        const updateResult = await tx.seat.updateMany({
          where: { id: booking.seat_id, version: currentVersion, status: 'HELD' },
          data: { status: 'BOOKED', version: { increment: 1 } },
        });

        if (updateResult.count === 0) {
          throw new OptimisticLockError();
        }

        return tx.booking.update({
          where: { id: booking.id },
          data: { status: 'CONFIRMED' },
          include: { seat: true, event: true },
        });
      });

      await releaseSeatLock(booking.seat_id, booking.hold_token);

      res.status(200).json({
        message: 'Booking confirmed successfully.',
        booking: confirmedBooking,
      });
    } catch (transactionError) {
      if (transactionError instanceof OptimisticLockError) {
        res.status(409).json({
          error: 'Version mismatch / race condition lost. Seat state was modified concurrently.',
        });
        return;
      }

      // The partial unique index refused a second CONFIRMED booking for this
      // seat. Application logic should have prevented reaching here, so this is
      // the storage-level backstop doing its job.
      if (isUniqueViolation(transactionError)) {
        res.status(409).json({ error: 'Seat has already been booked by another user.' });
        return;
      }

      throw transactionError;
    }
  } catch (error) {
    next(error);
  }
};


/**
 * POST /bookings/release
 *
 * Lets a user give up a hold before it lapses, returning the seat to inventory
 * immediately. Without this the only way out of a hold was to wait for expiry.
 */
export const releaseSeat = async (req: Request, res: Response, next: NextFunction) => {
  const { bookingId, userId } = req.body;

  if (!bookingId) {
    res.status(400).json({ error: 'bookingId is required.' });
    return;
  }

  try {
    const booking = await prisma.booking.findUnique({ where: { id: String(bookingId) } });

    if (!booking) {
      res.status(404).json({ error: 'Booking not found.' });
      return;
    }

    if (!userId || booking.user_id !== String(userId)) {
      res.status(403).json({ error: 'User does not match the booking owner.' });
      return;
    }

    if (booking.status !== 'PENDING') {
      res.status(409).json({
        error: `Booking is ${booking.status.toLowerCase()} and cannot be released.`,
      });
      return;
    }

    const released = await prisma.$transaction(async (tx) => {
      // Guarded: a hold confirmed or reaped a moment ago must not be cancelled.
      const cancelled = await tx.booking.updateMany({
        where: { id: booking.id, status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });

      if (cancelled.count === 0) return false;

      // Only free the seat if no other still-valid hold owns it.
      const liveHolds = await tx.booking.count({
        where: { seat_id: booking.seat_id, status: 'PENDING', expires_at: { gt: new Date() } },
      });

      if (liveHolds === 0) {
        await tx.seat.updateMany({
          where: { id: booking.seat_id, status: 'HELD' },
          data: { status: 'AVAILABLE', version: { increment: 1 } },
        });
      }

      return true;
    });

    if (!released) {
      res.status(409).json({ error: 'Booking is no longer releasable.' });
      return;
    }

    if (booking.hold_token) {
      await releaseSeatLock(booking.seat_id, booking.hold_token);
    }

    res.status(200).json({ message: 'Hold released.', bookingId: booking.id });
  } catch (error) {
    next(error);
  }
};

/** GET /bookings/:id — lets the UI and the load test poll a booking's outcome. */
export const getBooking = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const booking = await prisma.booking.findUnique({
      where: { id: String(req.params.id) },
      include: { seat: true },
    });

    if (!booking) {
      throw notFound('Booking not found.');
    }

    res.status(200).json(booking);
  } catch (error) {
    next(error);
  }
};
