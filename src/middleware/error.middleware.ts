import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { AppError } from '../lib/errors';

/** Terminal handler for unmatched routes, so a typo returns 404 rather than HTML. */
export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Cannot ${req.method} ${req.originalUrl}` });
}

export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction) {
  // If the response has already started there is nothing useful left to send.
  if (res.headersSent) {
    next(err);
    return;
  }

  const status =
    err instanceof AppError
      ? err.status
      : typeof (err as any)?.status === 'number'
        ? (err as any).status
        : 500;

  // Only genuine server faults deserve a stack trace in the log.
  if (status >= 500) {
    console.error(err);
  }

  const message =
    status >= 500 ? 'Internal Server Error' : ((err as any)?.message ?? 'Request failed');

  const body: Record<string, unknown> = { error: message };

  // Never leak internals in production.
  if (status >= 500 && config.nodeEnv !== 'production') {
    body.detail = (err as any)?.message;
    body.stack = (err as any)?.stack;
  }

  res.status(status).json(body);
}
