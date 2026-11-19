import * as authService from '../services/auth.service.js';
import { AppError } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const moved = (req, res, next) =>
  next(
    new AppError(410, 'Sign-in and sign-out are handled by the account service. Use it to sign in, then send its token here.', {
      code: 'AUTH_MOVED_TO_ACCOUNT_SERVICE',
    })
  );

export const me = asyncHandler(async (req, res) => {
  const data = await authService.getCurrentUser(req.user);
  res.json({ status: 'success', data });
});
