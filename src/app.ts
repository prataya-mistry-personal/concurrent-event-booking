import path from 'node:path';
import express, { type Express } from 'express';
import cors from 'cors';
import eventRoutes from './routes/event.routes';
import healthRoutes from './routes/health.routes';
import bookingRoutes from './routes/booking.routes';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';

/**
 * Builds the Express application without binding a port.
 *
 * Keeping construction separate from listening lets the integration tests boot
 * the real app on an ephemeral port and drive it over real HTTP, which is the
 * only way to observe genuine request concurrency.
 *
 * SECURITY NOTE: there is no authentication. `userId` is taken from the request
 * body, so any caller can act as any user, and CORS is fully open. That is a
 * deliberate scope decision for a concurrency demo, not an oversight -- see the
 * limitations section of the README. Do not expose this to a network you do not
 * control.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Seat-map demo UI. Resolved from the working directory rather than __dirname,
  // because __dirname differs between `ts-node src/server.ts` and the compiled
  // `dist/src/server.js`. Both npm scripts run from the project root.
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use('/health', healthRoutes);
  app.use('/events', eventRoutes);
  app.use('/bookings', bookingRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
