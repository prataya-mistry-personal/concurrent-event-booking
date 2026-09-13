import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma';
import { redisClient } from '../src/db/redis';
import { startHoldReaper, type RunningReaper } from '../src/services/hold-reaper';
import {
  getJson,
  postJson,
  resetState,
  seedEvent,
  sleep,
  startTestServer,
  stopTestServer,
} from './helpers/env';

describe('expired hold reaper', () => {
  let eventId: string;
  let seatId: number;
  let reaper: RunningReaper | null = null;

  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    if (reaper) {
      await reaper.stop();
      reaper = null;
    }
    await resetState();
    const seeded = await seedEvent(10);
    eventId = seeded.eventId;
    seatId = seeded.seatId;
  });

  /** Holds a seat then backdates its deadline, simulating an abandoned hold. */
  async function abandonedHold(userId = 'user-A') {
    const hold = await postJson('/bookings/hold', { userId, eventId, seatId });
    expect(hold.status).toBe(201);

    await prisma.booking.update({
      where: { id: hold.body.booking.id },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });

    return hold.body.booking.id as string;
  }

  it('reclaims an abandoned hold on its own schedule', async () => {
    const bookingId = await abandonedHold();

    expect((await getJson('/events')).body[0].available_seats).toBe(9);

    reaper = startHoldReaper(50);

    // Poll rather than sleeping a fixed amount, so the test is not timing-fragile.
    let seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    for (let i = 0; i < 40 && seat.status !== 'AVAILABLE'; i += 1) {
      await sleep(50);
      seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    }

    expect(seat.status).toBe('AVAILABLE');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe('EXPIRED');

    expect((await getJson('/events')).body[0].available_seats).toBe(10);

    // The stale Redis lock must be gone too, so the seat can be re-held.
    expect(await redisClient.get(`seat_lock:${seatId}`)).toBeNull();
  });

  it('leaves a confirmed booking untouched', async () => {
    const hold = await postJson('/bookings/hold', { userId: 'user-A', eventId, seatId });
    const checkout = await postJson('/bookings/checkout', {
      bookingId: hold.body.booking.id,
      userId: 'user-A',
    });
    expect(checkout.status).toBe(200);

    // Backdate the deadline of an already-confirmed booking. A naive sweep keyed
    // only on expires_at would wrongly release the seat.
    await prisma.booking.update({
      where: { id: hold.body.booking.id },
      data: { expires_at: new Date(Date.now() - 60_000) },
    });

    reaper = startHoldReaper(50);
    await sleep(300);

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: hold.body.booking.id } });

    expect(seat.status).toBe('BOOKED');
    expect(booking.status).toBe('CONFIRMED');
  });

  it('does not free a seat that a newer live hold owns', async () => {
    // A's hold lapses, B then takes a fresh hold on the same seat. Reaping A's
    // hold must not strand B's.
    const staleId = await abandonedHold('user-A');
    await redisClient.del(`seat_lock:${seatId}`);

    const bHold = await postJson('/bookings/hold', { userId: 'user-B', eventId, seatId });
    expect(bHold.status).toBe(201);

    reaper = startHoldReaper(50);
    await sleep(300);

    const seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    const stale = await prisma.booking.findUniqueOrThrow({ where: { id: staleId } });
    const fresh = await prisma.booking.findUniqueOrThrow({ where: { id: bHold.body.booking.id } });

    expect(stale.status).toBe('EXPIRED');
    expect(fresh.status).toBe('PENDING');
    expect(seat.status).toBe('HELD');

    // B must still be able to complete checkout.
    const checkout = await postJson('/bookings/checkout', {
      bookingId: bHold.body.booking.id,
      userId: 'user-B',
    });
    expect(checkout.status).toBe(200);
  });

  it('re-holding a reclaimed seat works end to end', async () => {
    await abandonedHold('user-A');

    reaper = startHoldReaper(50);

    let seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    for (let i = 0; i < 40 && seat.status !== 'AVAILABLE'; i += 1) {
      await sleep(50);
      seat = await prisma.seat.findUniqueOrThrow({ where: { id: seatId } });
    }
    expect(seat.status).toBe('AVAILABLE');

    const bHold = await postJson('/bookings/hold', { userId: 'user-B', eventId, seatId });
    expect(bHold.status).toBe(201);

    const checkout = await postJson('/bookings/checkout', {
      bookingId: bHold.body.booking.id,
      userId: 'user-B',
    });
    expect(checkout.status).toBe(200);

    expect(
      await prisma.booking.count({ where: { seat_id: seatId, status: 'CONFIRMED' } })
    ).toBe(1);
  });
});
