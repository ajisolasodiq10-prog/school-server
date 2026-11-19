// An error that is safe to show to the client: it carries an HTTP status, a message
// written for humans and an optional machine-readable `code` the frontend can react to.
export class AppError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message = 'Bad request.', options) => new AppError(400, message, options);
export const unauthorized = (message = 'Authentication required.', code = 'AUTH_REQUIRED') =>
  new AppError(401, message, { code });
export const forbidden = (message = 'You do not have permission to perform this action.', code = 'FORBIDDEN') =>
  new AppError(403, message, { code });
export const notFound = (message = 'Resource not found.') => new AppError(404, message, { code: 'NOT_FOUND' });
export const conflict = (message = 'Conflict.') => new AppError(409, message, { code: 'CONFLICT' });
export const tooManyRequests = (message = 'Too many requests. Please try again later.') =>
  new AppError(429, message, { code: 'RATE_LIMITED' });
