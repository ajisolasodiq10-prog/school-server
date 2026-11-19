import { forbidden, unauthorized } from '../utils/AppError.js';

// Allows the request only if the authenticated user has one of the given roles.
// Always place it AFTER `authenticate`:
//   router.post('/x', authenticate, requireRole('admin'), handler)
export const requireRole =
  (...roles) =>
  (req, res, next) => {
    if (!req.auth) return next(unauthorized());
    if (!roles.includes(req.auth.role)) return next(forbidden());
    return next();
  };
