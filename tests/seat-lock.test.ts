import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { redisClient } from '../src/db/redis';
import {
  acquireSeatLock,
  readSeatLock,
  releaseSeatLock,
  seatLockKey,
} from '../src/lib/seat-lock';
import { resetState, sleep, startTestServer, stopTestServer } from './helpers/env';

/**
 * The original implementation released holds with a bare `DEL` issued after a
 * separate `GET`. If the TTL lapsed between those two calls the `DEL` would
 * destroy the *next* holder's lock. A correct release must be an atomic
 * compare-and-delete keyed on a token only the owner knows.
 */
describe('seat lock primitive', () => {
  const seatId = 4242;

  beforeAll(async () => {
    await startTestServer();
  });

  afterAll(async () => {
    await stopTestServer();
  });

  beforeEach(async () => {
    await resetState();
  });

  it('grants the lock to exactly one token', async () => {
    expect(await acquireSeatLock(seatId, 'token-a', 30)).toBe(true);
    expect(await acquireSeatLock(seatId, 'token-b', 30)).toBe(false);
    expect(await readSeatLock(seatId)).toBe('token-a');
  });

  it('refuses to release a lock held by someone else', async () => {
    await acquireSeatLock(seatId, 'token-a', 30);

    expect(await releaseSeatLock(seatId, 'token-b')).toBe(false);

    // The rightful owner's lock must survive the impostor's release attempt.
    expect(await readSeatLock(seatId)).toBe('token-a');
  });

  it('releases the lock for its owner', async () => {
    await acquireSeatLock(seatId, 'token-a', 30);

    expect(await releaseSeatLock(seatId, 'token-a')).toBe(true);
    expect(await readSeatLock(seatId)).toBeNull();
  });

  it('treats releasing an absent lock as a no-op rather than an error', async () => {
    expect(await releaseSeatLock(seatId, 'token-a')).toBe(false);
  });

  it('lets a new token acquire once the previous lock has expired', async () => {
    expect(await acquireSeatLock(seatId, 'token-a', 1)).toBe(true);

    await sleep(1200);

    expect(await acquireSeatLock(seatId, 'token-b', 30)).toBe(true);
    expect(await readSeatLock(seatId)).toBe('token-b');
  });

  it('sets a bounded TTL so a crashed holder cannot wedge a seat forever', async () => {
    await acquireSeatLock(seatId, 'token-a', 30);

    const ttl = await redisClient.ttl(seatLockKey(seatId));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });
});
