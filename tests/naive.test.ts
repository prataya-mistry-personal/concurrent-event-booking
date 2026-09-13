import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import {
  getJson,
  postJson,
  resetState,
  seedEvent,
  startTestServer,
  stopTestServer,
} from './helpers/env';

/**
 * These tests assert that the naive endpoint is broken. That is deliberate: the
 * naive-versus-safe comparison in the demo is only credible if the broken
 * behaviour is pinned down by a test rather than described in prose. If a future
 * change accidentally made the naive path safe, the demo would silently stop
 * demonstrating anything, and this suite would catch that.
 */
describe('naive versus safe booking under contention', () => {
  const CONCURRENCY = 30;

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
    const seeded = await seedEvent(10);
    eventId = seeded.eventId;
    seatId = seeded.seatId;
  });

  function stormHolds(path: string) {
    return Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        postJson(path, { userId: `user-${i}`, eventId, seatId })
      )
    );
  }

  it('naive mode hands the same seat to many users at once', async () => {
    const results = await stormHolds('/bookings/hold-naive');

    const accepted = results.filter((r) => r.status === 201);

    // The read-then-write race lets many requests through the availability check.
    expect(accepted.length).toBeGreaterThan(1);

    const livePending = await prisma.booking.count({
      where: { seat_id: seatId, status: 'PENDING', expires_at: { gt: new Date() } },
    });
    expect(livePending).toBe(accepted.length);

    const stats = await getJson(`/events/${eventId}/stats`);
    expect(stats.body.duplicate_pending_seats).toBe(1);
  });

  it('safe mode admits exactly one holder for the same seat', async () => {
    const results = await stormHolds('/bookings/hold');

    const accepted = results.filter((r) => r.status === 201);
    expect(accepted).toHaveLength(1);

    const stats = await getJson(`/events/${eventId}/stats`);
    expect(stats.body.duplicate_pending_seats).toBe(0);
    expect(stats.body.oversold_seats).toBe(0);
  });

  it('the database still refuses to confirm a naive oversell twice', async () => {
    const holds = await stormHolds('/bookings/hold-naive');
    const accepted = holds.filter((r) => r.status === 201);
    expect(accepted.length).toBeGreaterThan(1);

    const checkouts = await Promise.all(
      accepted.map((h) => postJson('/bookings/checkout-naive', { bookingId: h.body.booking.id }))
    );

    const succeeded = checkouts.filter((r) => r.status === 200);

    // Application logic let them all through; the partial unique index is the
    // only reason this does not become a real double-booking.
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const confirmed = await prisma.booking.count({
      where: { seat_id: seatId, status: 'CONFIRMED' },
    });
    expect(confirmed).toBe(1);

    const stats = await getJson(`/events/${eventId}/stats`);
    expect(stats.body.oversold_seats).toBe(0);
  });

  it('safe mode survives a full hold-then-checkout storm with one winner', async () => {
    const holds = await stormHolds('/bookings/hold');
    const accepted = holds.filter((r) => r.status === 201);

    const checkouts = await Promise.all(
      accepted.map((h) =>
        postJson('/bookings/checkout', {
          bookingId: h.body.booking.id,
          userId: h.body.booking.user_id,
        })
      )
    );

    expect(checkouts.filter((r) => r.status === 200)).toHaveLength(1);

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    expect(seat.status).toBe('BOOKED');

    expect(
      await prisma.booking.count({ where: { seat_id: seatId, status: 'CONFIRMED' } })
    ).toBe(1);
  });
});
