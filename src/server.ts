import { createApp } from './app';
import { config } from './config';
import { prisma } from './db/prisma';
import { connectRedis, disconnectRedis } from './db/redis';
import { startHoldReaper } from './services/hold-reaper';

const startServer = async () => {
  // Fail fast. The original code logged a Redis connection failure and started
  // anyway, so every hold attempt then returned a 500 with no clue why.
  await connectRedis();
  console.log(`Connected to Redis at ${config.redisUrl}`);

  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
    console.log(`Seat map:  http://localhost:${config.port}/`);
    console.log(
      `Holds last ${config.holdDurationSeconds}s; reaper sweeps every ${config.reaperIntervalMs}ms`
    );
  });

  const reaper = startHoldReaper();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down gracefully...`);

    // Stop accepting new work first, then wind down dependencies. Without this
    // the process left Prisma and Redis connections dangling on every restart.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await reaper.stop();
    await prisma.$disconnect();
    await disconnectRedis();

    console.log('Shutdown complete.');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

startServer().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
