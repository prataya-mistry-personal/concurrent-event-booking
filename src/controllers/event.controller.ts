import { Request, Response, NextFunction } from 'express';
import { prisma } from '../db/prisma';
import { notFound } from '../lib/errors';

export const getEvents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const events = await prisma.event.findMany({
      orderBy: { created_at: 'asc' },
      include: {
        _count: { select: { seats: { where: { status: 'AVAILABLE' } } } },
      },
    });

    // Destructured out rather than the previous `_count: undefined`, which only
    // disappeared because JSON.stringify drops undefined values.
    const formatted = events.map(({ _count, ...event }) => ({
      ...event,
      available_seats: _count.seats,
    }));

    res.json(formatted);
  } catch (error) {
    next(error);
  }
};

export const getEventSeats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const seats = await prisma.seat.findMany({
      where: { event_id: String(req.params.id) },
      orderBy: { id: 'asc' },
    });

    res.json(seats);
  } catch (error) {
    next(error);
  }
};

/**
 * GET /events/:id/stats
 *
 * Aggregates the numbers the seat-map UI displays and the load test asserts on.
 *
 * `oversold_seats` and `duplicate_pending_seats` are the two invariant counters:
 * the first must always be zero, and the second must be zero in safe mode while
 * naive mode is expected to produce a positive value.
 *
 * These use Prisma's groupBy rather than raw SQL deliberately. `expires_at` is
 * `timestamp without time zone` holding UTC values, and comparing it in raw SQL
 * against either `NOW()` or a bound JS Date makes Postgres apply an implicit cast
 * using the session timezone. On a server not set to UTC that silently reports
 * every live hold as already expired, which made this counter always read zero.
 */
export const getEventStats = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const eventId = String(req.params.id);

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      throw notFound('Event not found.');
    }

    const now = new Date();

    const [seatGroups, bookingGroups, oversoldGroups, duplicatePendingGroups] = await Promise.all([
      prisma.seat.groupBy({ by: ['status'], where: { event_id: eventId }, _count: true }),
      prisma.booking.groupBy({ by: ['status'], where: { event_id: eventId }, _count: true }),

      // Seats carrying more than one CONFIRMED booking. The partial unique index
      // makes this impossible, so a non-zero result means the index is missing.
      prisma.booking.groupBy({
        by: ['seat_id'],
        where: { event_id: eventId, status: 'CONFIRMED' },
        having: { seat_id: { _count: { gt: 1 } } },
      }),

      // Seats carrying more than one still-valid PENDING hold: several users each
      // believing the seat is theirs. This is what naive mode produces.
      prisma.booking.groupBy({
        by: ['seat_id'],
        where: { event_id: eventId, status: 'PENDING', expires_at: { gt: now } },
        having: { seat_id: { _count: { gt: 1 } } },
      }),
    ]);

    const seats = { AVAILABLE: 0, HELD: 0, BOOKED: 0 };
    for (const group of seatGroups) {
      seats[group.status] = group._count;
    }

    const bookings = { PENDING: 0, CONFIRMED: 0, EXPIRED: 0, CANCELLED: 0 };
    for (const group of bookingGroups) {
      bookings[group.status] = group._count;
    }

    res.json({
      event_id: eventId,
      seats: { ...seats, total: seats.AVAILABLE + seats.HELD + seats.BOOKED },
      bookings,
      oversold_seats: oversoldGroups.length,
      duplicate_pending_seats: duplicatePendingGroups.length,
    });
  } catch (error) {
    next(error);
  }
};
