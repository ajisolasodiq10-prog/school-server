// Wraps an async route handler so a rejected promise reaches the central error handler
// (needed on Express 4, harmless on Express 5).
export const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
