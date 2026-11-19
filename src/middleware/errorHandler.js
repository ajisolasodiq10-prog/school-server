import { config } from '../config/env.js';

// Runs when no route matched the request.
export const notFound = (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
};

// Turns the many kinds of errors thrown in the app into one consistent, safe response.
const describe = (err) => {
  // Errors we threw on purpose (AppError) are safe to show as they are.
  if (err.name === 'AppError') {
    return { status: err.status, message: err.message, code: err.code, details: err.details };
  }

  // Mongoose schema validation (required field missing, bad enum value, ...).
  if (err.name === 'ValidationError' && err.errors) {
    return {
      status: 400,
      message: 'Validation failed.',
      code: 'VALIDATION_ERROR',
      details: Object.values(err.errors).map((e) => ({
        field: e.path,
        message: e.name === 'CastError' ? `${e.path} has an invalid value.` : e.message,
      })),
    };
  }

  if (err.name === 'CastError') {
    return { status: 400, message: `Invalid value for ${err.path}.`, code: 'VALIDATION_ERROR' };
  }

  // MongoDB duplicate-key error (a unique index was violated).
  if (err.code === 11000) {
    return {
      status: 409,
      message: 'A record with the same unique value already exists.',
      code: 'CONFLICT',
    };
  }

  // Body-parser problems.
  if (err.type === 'entity.parse.failed') {
    return { status: 400, message: 'Request body is not valid JSON.', code: 'INVALID_JSON' };
  }
  if (err.type === 'entity.too.large') {
    return { status: 413, message: 'Request body is too large.', code: 'PAYLOAD_TOO_LARGE' };
  }

  const status = err.status || err.statusCode || 500;
  return {
    status,
    // Never leak internals of unexpected (500) errors.
    message: status >= 500 ? 'Internal server error.' : err.message,
  };
};

// Central error handler (must keep all four arguments).
// eslint-disable-next-line no-unused-vars
export const errorHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  const { status, message, code, details } = describe(err);

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl} -> ${status}:`, err);
  } else if (status !== 401 && status !== 404) {
    console.warn(`[error] ${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  }

  res.status(status).json({
    status: 'error',
    message,
    ...(code && { code }),
    ...(details && { details }),
    ...(config.nodeEnv === 'development' && status >= 500 && { stack: err.stack }),
  });
};
