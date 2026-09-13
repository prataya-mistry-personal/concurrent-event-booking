import { PrismaClient } from '@prisma/client';
import { config } from '../config';

// The URL is passed explicitly rather than relying on Prisma's own env lookup so
// that test runs are guaranteed to hit TEST_DATABASE_URL.
export const prisma = new PrismaClient({
  datasources: { db: { url: config.databaseUrl } },
});
