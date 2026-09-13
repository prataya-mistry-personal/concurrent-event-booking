import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../src/app';
import { config } from '../../src/config';
import { prisma } from '../../src/db/prisma';
import { connectRedis, disconnectRedis, redisClient } from '../../src/db/redis';

let server: Server | null = null;
let baseUrl = '';

/**
 * Refuses to run destructive helpers unless we are demonstrably pointed at the
 * throwaway test database. Without this guard a misconfigured TEST_DATABASE_URL
 * would let `resetState()` truncate real development data.
 */
function assertTestTargets(): void {
  if (!config.isTest) {
    throw new Error('Test helpers require NODE_ENV=test.');
  }
  if (!/event_booking_test/.test(config.databaseUrl)) {
    throw new Error(
      `Refusing to run destructive test helpers: TEST_DATABASE_URL must point at ` +
        `the "event_booking_test" database, got "${config.databaseUrl}".`
    );
  }
  const redisDb = new URL(config.redisUrl).pathname.replace(/^\//, '');
  if (!redisDb || redisDb === '0') {
    throw new Error(
      `Refusing to run destructive test helpers: TEST_REDIS_URL must select a ` +
        `non-default Redis logical database (e.g. redis://localhost:6379/1), got "${config.redisUrl}".`
    );
  }
}

/** Boots the real app on an ephemeral port so tests exercise genuine HTTP concurrency. */
export async function startTestServer(): Promise<string> {
  assertTestTargets();

  if (server) return baseUrl;

  await connectRedis();

  // connectRedis resolves even for a lazily-established connection, so prove the
  // link is actually usable before any test depends on it.
  const pong = await redisClient.ping();
  if (pong !== 'PONG') {
    throw new Error(`Redis did not respond to PING (got ${String(pong)}).`);
  }

  const app = createApp();

  await new Promise<void>((resolve, reject) => {
    const created = app.listen(0);
    created.once('listening', () => {
      server = created;
      const address = created.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    created.once('error', reject);
  });

  return baseUrl;
}

export async function stopTestServer(): Promise<void> {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((err) => (err ? reject(err) : resolve()));
    });
    server = null;
    baseUrl = '';
  }
  await prisma.$disconnect();
  await disconnectRedis();
}

/** Truncates all tables and clears the test Redis database. */
export async function resetState(): Promise<void> {
  assertTestTargets();

  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Booking", "Seat", "Event" RESTART IDENTITY CASCADE;'
  );

  if (redisClient.isOpen) {
    await redisClient.flushDb();
  }
}

export interface SeededEvent {
  eventId: string;
  seatIds: number[];
  /** Convenience handle on the first seat, which most tests contend over. */
  seatId: number;
}

/** Creates one event with `seatCount` AVAILABLE seats. */
export async function seedEvent(seatCount = 100): Promise<SeededEvent> {
  const event = await prisma.event.create({
    data: {
      name: 'Concurrency Test Event',
      total_seats: seatCount,
      start_time: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  await prisma.seat.createMany({
    data: Array.from({ length: seatCount }, (_, i) => ({
      event_id: event.id,
      label: `Seat ${i + 1}`,
      status: 'AVAILABLE' as const,
      version: 1,
    })),
  });

  const seats = await prisma.seat.findMany({
    where: { event_id: event.id },
    orderBy: { id: 'asc' },
    select: { id: true },
  });

  const seatIds = seats.map((s) => s.id);
  return { eventId: event.id, seatIds, seatId: seatIds[0]! };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

async function parse<T>(res: Response): Promise<ApiResponse<T>> {
  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

export async function getJson<T = any>(path: string): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`);
  return parse<T>(res);
}

export async function postJson<T = any>(path: string, body: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}

export function getBaseUrl(): string {
  return baseUrl;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
