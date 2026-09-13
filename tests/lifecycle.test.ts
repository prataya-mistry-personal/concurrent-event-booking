import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redisClient } from '../src/db/redis';
import {
  getJson,
  postJson,
  resetState,
  seedEvent,
  startTestServer,
  stopTestServer,
} from './helpers/env';

describe('booking lifecycle endpoints', () => {
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

  it('releases a hold and frees the seat for the next user', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    expect(hold.status).toBe(201);

    const release = await postJson('/bookings/release', {
      bookingId: hold.body.booking.id,
      userId: 'user-A',
    });
    expect(release.status).toBe(200);

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    expect(seat.status).toBe('AVAILABLE');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: hold.body.booking.id } });
    expect(booking.status).toBe('CANCELLED');

    // The lock must be gone so the seat is immediately re-holdable.
    expect(await redisClient.get(`seat_lock:${seatId}`)).toBeNull();

    const bHold = await postJson('/bookings/hold', { userId: 'user-B', eventId, seatId });
    expect(bHold.status).toBe(201);
  });

  it('refuses to release someone else hold', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });

    const release = await postJson('/bookings/release', {
      bookingId: hold.body.booking.id,
      userId: 'user-B',
    });

    expect(release.status).toBe(403);

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    expect(seat.status).toBe('HELD');
  });

  it('refuses to release a confirmed booking', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    await postJson('/bookings/checkout', {
      bookingId: hold.body.booking.id,
      userId: 'user-A',
    });

    const release = await postJson('/bookings/release', {
      bookingId: hold.body.booking.id,
      userId: 'user-A',
    });

    expect(release.status).toBe(409);
  });

  it('exposes a single booking', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });

    const res = await getJson(`/bookings/${hold.body.booking.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(hold.body.booking.id);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.seat.id).toBe(seatId);
  });

  it('returns 404 for an unknown booking via AppError', async () => {
    const res = await getJson('/bookings/00000000-0000-0000-0000-000000000000');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Booking not found.');
  });

  it('returns 404 for an unmatched route', async () => {
    const res = await getJson('/no-such-route');

    expect(res.status).toBe(404);
    expect(res.body.error).toContain('/no-such-route');
  });

  it('reports event statistics with both invariant counters', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    await postJson('/bookings/checkout', {
      bookingId: hold.body.booking.id,
      userId: 'user-A',
    });
    await postJson('/bookings/hold', { userId: 'user-B', eventId, seatId: seatId + 1 });

    const res = await getJson(`/events/${eventId}/stats`);

    expect(res.status).toBe(200);
    expect(res.body.seats).toEqual({ AVAILABLE: 8, HELD: 1, BOOKED: 1, total: 10 });
    expect(res.body.bookings.CONFIRMED).toBe(1);
    expect(res.body.bookings.PENDING).toBe(1);
    expect(res.body.oversold_seats).toBe(0);
    expect(res.body.duplicate_pending_seats).toBe(0);
  });

  it('returns 404 stats for an unknown event', async () => {
    const res = await getJson('/events/00000000-0000-0000-0000-000000000000/stats');
    expect(res.status).toBe(404);
  });
});
