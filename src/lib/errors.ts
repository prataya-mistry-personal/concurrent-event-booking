/**
 * An error that carries the HTTP status it should produce.
 *
 * The original error handler collapsed everything to 500, which hid genuine
 * client errors and made failures indistinguishable from bugs.
 */
export class AppError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (message: string) => new AppError(message, 404);
