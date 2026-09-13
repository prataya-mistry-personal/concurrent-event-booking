import { randomUUID } from 'node:crypto';
import { redisClient } from '../db/redis';

/**
 * Distributed seat lock backed by Redis.
 *
 * Two properties matter here.
 *
 * 1. The lock value is a random per-hold token, not the user id. A user id is
 *    not unique to a hold, so a retry or a second hold by the same user could
 *    not be distinguished from the original owner.
 *
 * 2. Release is an atomic compare-and-delete. The natural implementation --
 *    `GET` the key, compare, then `DEL` -- has a race: if the TTL lapses between
 *    the GET and the DEL, and another request acquires the lock in that window,
 *    the DEL destroys a lock it never owned. Doing the comparison inside a Lua
 *    script makes the check and the delete a single atomic step.
 *
 * Scope note: this is a single-node lock. It is not a Redlock quorum, so it
 * assumes one Redis primary. The database-side guarded write and the partial
 * unique index are what actually guarantee correctness; this lock exists to make
 * contention cheap and to give losers a fast, clear rejection.
 */

export function seatLockKey(seatId: number): string {
  return `seat_lock:${seatId}`;
}

/** Generates a fresh fence token for a hold. */
export function newHoldToken(): string {
  return randomUUID();
}

/** Attempts to take the lock. Returns false if another token already holds it. */
export async function acquireSeatLock(
  seatId: number,
  token: string,
  ttlSeconds: number
): Promise<boolean> {
  const reply = await redisClient.set(seatLockKey(seatId), token, {
    NX: true,
    EX: ttlSeconds,
  });
  return reply === 'OK';
}

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

/**
 * Releases the lock only if `token` still owns it.
 * Returns false when the lock is absent or held by someone else.
 */
export async function releaseSeatLock(seatId: number, token: string): Promise<boolean> {
  const reply = await redisClient.eval(RELEASE_SCRIPT, {
    keys: [seatLockKey(seatId)],
    arguments: [token],
  });
  return Number(reply) === 1;
}

/** Returns the token currently holding the seat, or null if the seat is free. */
export async function readSeatLock(seatId: number): Promise<string | null> {
  return redisClient.get(seatLockKey(seatId));
}
