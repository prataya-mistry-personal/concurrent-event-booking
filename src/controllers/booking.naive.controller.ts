/* ===========================================================================
 * INTENTIONALLY UNSAFE. DO NOT COPY THIS PATTERN.
 * ===========================================================================
 *
 * This module exists only so the demo can run the same load test against a
 * naive implementation and a hardened one, and show the difference. It is the
 * "obvious" way to write seat booking:
 *
 *     read the seat -> is it free? -> write it as taken
 *
 * That read-then-write is not atomic, so any number of concurrent requests can
 * all pass the check before any of them writes. There is no distributed lock and
 * no conditional write, which is exactly what makes it oversell.
 *
 * Two things are deliberately still true here:
 *
 *  - It writes to the same tables as the real path, so the numbers in
 *    /events/:id/stats are directly comparable.
 *  - It cannot corrupt the confirmed-booking invariant, because the partial
 *    unique index added in the hardening migration is enforced by Postgres
 *    regardless of application logic. Naive checkout therefore fails with a
 *    conflict instead of double-booking. That is the point: the demo shows the
 *    storage layer catching what the application logic missed.
 *
 * The observable damage is at the hold stage: many users are each told they hold
 * the same seat, and all but one of them later discover that was a lie.
 * ===========================================================================
 */

import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { prisma } from '../db/prisma';

/**
 * Widens the read-to-write window so the race is reliably observable at modest
 * concurrency. It does not create the bug; it only makes an existing bug
 * reproducible in a demo instead of appearing once every few thousand requests.
 */
const RACE_WINDOW_MS = 15;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** POST /bookings/hold-naive — no lock, no conditional write. */
export const holdSeatNaive = async (req: Request, res: Response, next: NextFunction) => {
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

  try {
    // 1. Read.
    const seat = await prisma.seat.findUnique({ where: { id: parsedSeatId } });

    if (!seat || seat.event_id !== String(eventId)) {
      res.status(404).json({ error: 'Seat not found for the specified event.' });
      return;
    }

    if (seat.status !== 'AVAILABLE') {
      res.status(409).json({ error: 'Seat is not available.' });
      return;
    }

    // 2. The window. Every concurrent request is now past the check above.
    await sleep(RACE_WINDOW_MS);

    // 3. Write, unconditionally. Whatever the seat's real state is by now, it is
    //    overwritten.
    await prisma.seat.update({
      where: { id: parsedSeatId },
      data: { status: 'HELD' },
    });

    const expiresAt = new Date(Date.now() + config.holdDurationSeconds * 1000);

    const booking = await prisma.booking.create({
      data: {
        user_id: String(userId),
        event_id: String(eventId),
        seat_id: parsedSeatId,
        status: 'PENDING',
        expires_at: expiresAt,
      },
    });

    res.status(201).json({
      message: 'Seat held successfully (naive mode).',
      booking,
      expires_at: expiresAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

/** POST /bookings/checkout-naive — no ownership check, no version check, no lock. */
export const checkoutSeatNaive = async (req: Request, res: Response, next: NextFunction) => {
  const { bookingId } = req.body;

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

    await sleep(RACE_WINDOW_MS);

    // Unconditional: no version predicate, no status predicate, no lock check.
    await prisma.seat.update({
      where: { id: booking.seat_id },
      data: { status: 'BOOKED' },
    });

    // This is where the database's partial unique index intervenes if another
    // booking for this seat is already CONFIRMED. Left uncaught deliberately so
    // the failure is visible rather than quietly swallowed.
    const confirmed = await prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'CONFIRMED' },
    });

    res.status(200).json({
      message: 'Booking confirmed successfully (naive mode).',
      booking: confirmed,
    });
  } catch (error) {
    next(error);
  }
};
