import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { resetState, seedEvent, startTestServer, stopTestServer } from './helpers/env';

/**
 * These tests bypass the API entirely and write through Prisma directly. The
 * point is that the guarantee survives even if every line of controller logic is
 * wrong: the database itself refuses to record two confirmed bookings for one
 * seat.
 */
describe('database invariants', () => {
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
    const seeded = await seedEvent(5);
    eventId = seeded.eventId;
    seatId = seeded.seatId;
  });

  it('refuses a second CONFIRMED booking for the same seat', async () => {
    await prisma.booking.create({
      data: { user_id: 'user-A', event_id: eventId, seat_id: seatId, status: 'CONFIRMED' },
    });

    let code: string | undefined;
    try {
      await prisma.booking.create({
        data: { user_id: 'user-B', event_id: eventId, seat_id: seatId, status: 'CONFIRMED' },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) code = error.code;
    }

    // P2002 is Prisma's unique constraint violation.
    expect(code).toBe('P2002');

    const confirmed = await prisma.booking.count({
      where: { seat_id: seatId, status: 'CONFIRMED' },
    });
    expect(confirmed).toBe(1);
  });

  it('refuses to promote a second booking to CONFIRMED', async () => {
    await prisma.booking.create({
      data: { user_id: 'user-A', event_id: eventId, seat_id: seatId, status: 'CONFIRMED' },
    });
    const second = await prisma.booking.create({
      data: { user_id: 'user-B', event_id: eventId, seat_id: seatId, status: 'PENDING' },
    });

    let code: string | undefined;
    try {
      await prisma.booking.update({ where: { id: second.id }, data: { status: 'CONFIRMED' } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) code = error.code;
    }

    expect(code).toBe('P2002');
  });

  it('still allows many non-confirmed bookings for one seat', async () => {
    // The index is scoped to CONFIRMED, so holds and terminal states are
    // unconstrained. This is what keeps the naive-mode oversell demo meaningful.
    await prisma.booking.create({
      data: { user_id: 'user-A', event_id: eventId, seat_id: seatId, status: 'PENDING' },
    });
    await prisma.booking.create({
      data: { user_id: 'user-B', event_id: eventId, seat_id: seatId, status: 'PENDING' },
    });
    await prisma.booking.create({
      data: { user_id: 'user-C', event_id: eventId, seat_id: seatId, status: 'EXPIRED' },
    });
    await prisma.booking.create({
      data: { user_id: 'user-D', event_id: eventId, seat_id: seatId, status: 'CANCELLED' },
    });

    expect(await prisma.booking.count({ where: { seat_id: seatId } })).toBe(4);
  });

  it('rejects duplicate seat labels within an event', async () => {
    let code: string | undefined;
    try {
      await prisma.seat.create({ data: { event_id: eventId, label: 'Seat 1' } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) code = error.code;
    }

    expect(code).toBe('P2002');
  });
});
