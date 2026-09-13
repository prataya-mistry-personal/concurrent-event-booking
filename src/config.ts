import dotenv from 'dotenv';

// Which env file to load. Read from the real process environment *before* dotenv
// runs, so a caller can select a different profile, e.g.
// `ENV_FILE=.env.demo npm start`.
const envFile = process.env.ENV_FILE ?? '.env';

// `override: true` is deliberate. Stale DATABASE_URL / REDIS_URL values are
// commonly left in a developer's shell environment, and dotenv's default
// behaviour is to let those win over the file. That silently points the app at
// the wrong database -- it cost real debugging time on this project. The chosen
// file is therefore authoritative, and switching profiles is done explicitly via
// ENV_FILE rather than by ambient environment variables.
dotenv.config({ path: envFile, override: true });

const isTest = process.env.NODE_ENV === 'test';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got "${raw}".`);
  }
  return parsed;
}

export const config = {
  isTest,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  envFile,

  port: numberFromEnv('PORT', 3000),

  // Tests run against a physically separate database and a separate Redis
  // logical database so a test run can never truncate development data.
  databaseUrl: isTest ? required('TEST_DATABASE_URL') : required('DATABASE_URL'),
  redisUrl: isTest ? required('TEST_REDIS_URL') : required('REDIS_URL'),

  /** How long a seat hold stays valid before it can be reclaimed. */
  holdDurationSeconds: numberFromEnv('HOLD_DURATION_SECONDS', 300),

  /** How often the expired-hold reaper sweeps. */
  reaperIntervalMs: numberFromEnv('REAPER_INTERVAL_MS', 60_000),
} as const;
