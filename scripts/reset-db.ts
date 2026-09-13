/**
 * Clears bookings and returns every seat to AVAILABLE, and flushes the seat locks
 * in Redis. Used before a demo run so the numbers start from a known state.
 *
 * Deliberately does not drop the schema: it truncates bookings and resets seat
 * state, leaving events and seats intact so seat ids stay stable across runs.
 */
import { config } from '../src/config';
import { prisma } from '../src/db/prisma';
import { connectRedis, disconnectRedis, redisClient } from '../src/db/redis';

async function main() {
  console.log(`Resetting booking state (${config.envFile} -> ${maskUrl(config.databaseUrl)})`);

  const deleted = await prisma.booking.deleteMany({});
  const reset = await prisma.seat.updateMany({
    where: { status: { not: 'AVAILABLE' } },
    data: { status: 'AVAILABLE', version: 1 },
  });

  await connectRedis();
  // Only the seat locks, so an unrelated key in the same database survives.
  const lockKeys = await redisClient.keys('seat_lock:*');
  if (lockKeys.length > 0) {
    await redisClient.del(lockKeys);
  }

  console.log(
    `Deleted ${deleted.count} booking(s), freed ${reset.count} seat(s), cleared ${lockKeys.length} lock(s).`
  );
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await disconnectRedis();
  });
