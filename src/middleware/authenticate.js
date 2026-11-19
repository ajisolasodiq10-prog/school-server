import { School, User } from '../models/index.js';
import { getLiveStatus } from '../services/accountManagement.service.js';
import { verifyAccountToken } from '../services/token.service.js';
import { forbidden, unauthorized } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Protects a route. On success it sets:
//   req.auth = { userId, schoolId, role, accountId, jti, exp }   <- use this for permission checks
//   req.user = the full User document
//
// Sign-in itself happens at the Account Management Backend, which issues the token. Here the
// token is only VERIFIED (signature, issuer, audience, expiry) with the account service's public
// key. It says which account is calling; everything else comes from this backend:
//   * role and school  -> this backend's own user record (never the token, never the client)
//   * school access    -> the user's school-side status and the school's status
//   * account status   -> asked from the account service (short cache, fails closed), so a
//                         deactivated, suspended or not-yet-activated account gets no access
//                         even while its token is still unexpired.
export const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const [scheme, token, ...extra] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || extra.length > 0) {
    throw unauthorized('Authentication required.', 'AUTH_REQUIRED');
  }

  let payload;
  try {
    payload = verifyAccountToken(token);
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      throw unauthorized('Your session has expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw unauthorized('Invalid token.', 'TOKEN_INVALID');
  }

  if (typeof payload?.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 100) {
    throw unauthorized('Invalid token.', 'TOKEN_INVALID');
  }

  const user = await User.findOne({ accountId: payload.sub });
  if (!user) throw unauthorized('Invalid token.', 'TOKEN_INVALID');

  const school = await School.findById(user.schoolId).select('status');
  if (!school || school.status !== 'active') {
    throw forbidden('This school account is not active.', 'SCHOOL_INACTIVE');
  }
  if (user.status !== 'active') {
    throw forbidden('This account is not active. Please contact your school administrator.', 'ACCOUNT_INACTIVE');
  }

  const live = await getLiveStatus(user.accountId); // throws 503 when the account service cannot be reached
  if (live.status === 'pending_activation') {
    throw forbidden('This account has not been activated yet.', 'ACCOUNT_NOT_ACTIVATED');
  }
  if (live.status !== 'active') {
    throw forbidden('This account is not active. Please contact your school administrator.', 'ACCOUNT_INACTIVE');
  }
  // The account service bumps tokenVersion on logout-everywhere and password change.
  if (Number.isInteger(payload.tv) && live.tokenVersion !== null && payload.tv !== live.tokenVersion) {
    throw unauthorized('Your session has ended. Please sign in again.', 'TOKEN_REVOKED');
  }
  if (user.accountStatus !== live.status) {
    // Keep the mirror in step; a failure here must never block the request.
    User.updateOne({ _id: user._id }, { $set: { accountStatus: live.status, accountStatusSyncedAt: new Date() } }).catch(() => {});
  }

  req.user = user;
  req.auth = {
    userId: user._id,
    schoolId: user.schoolId,
    role: user.role,
    accountId: user.accountId,
    jti: payload.jti,
    exp: payload.exp,
  };
  return next();
});
