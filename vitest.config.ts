import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],

    // Every test file shares one Postgres database and one Redis logical
    // database, so files must not run concurrently with each other.
    fileParallelism: false,
    sequence: { concurrent: false },

    // Concurrency tests fire hundreds of real HTTP requests and some wait on
    // hold expiry, so the default 5s timeout is far too tight.
    testTimeout: 30_000,
    hookTimeout: 30_000,

    env: { NODE_ENV: 'test' },
  },
});
