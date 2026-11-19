import { config } from '../config/env.js';
import { tooManyRequests } from '../utils/AppError.js';

// A small in-memory, fixed-window limiter. Each attempt is counted the moment it STARTS
// (so a burst of parallel requests cannot all slip through) and is refunded when it
// turns out not to be a failure. Once a key has used up its attempts, further requests
// get 429 until the window ends.
//
// Limits: state lives in this process only. It resets when the server restarts and is not
// shared between several server instances. That is fine for one server; if you later run
// several, move the counters to a shared store such as Redis.

export function createLimiter({ windowMs, max, keyFn, isFailure, message }) {
  const store = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) if (entry.resetAt <= now) store.delete(key);
  }, 60 * 1000);
  sweep.unref(); // never keep the process alive just for cleanup

  const middleware = (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();

    const now = Date.now();
    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }

    if (entry.count >= max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return next(tooManyRequests(message));
    }

    entry.count += 1;
    res.on('finish', () => {
      if (!isFailure(res.statusCode) && entry.count > 0) entry.count -= 1; // refund
    });
    return next();
  };

  middleware.clear = () => store.clear();
  return middleware;
}

// Activation / reset link requests by an administrator. Every request counts (each one issues a
// secret link at the account service), keyed by the signed-in administrator. Runs AFTER authenticate.
const links = config.accountLinkRateLimit;
export const accountLinkLimiter = createLimiter({
  windowMs: links.windowMs,
  max: links.maxPerAdmin,
  isFailure: () => true,
  message: 'Too many link requests. Please wait a while before requesting more.',
  keyFn: (req) => (req.auth?.userId ? `acct-link|${req.auth.userId}` : null),
});

// Result PIN redemption. These run AFTER authentication and validation, so the keys use the
// verified user and the validated student id. A failed attempt (any 4xx) is counted; a
// success is refunded. Three limits stack: per user, per student and per IP address.
const pin = config.pinRateLimit;
const PIN_MESSAGE = 'Too many incorrect PIN attempts. Please wait a while before trying again.';
const pinFailure = (status) => status >= 400 && status !== 429;

export const pinUserLimiter = createLimiter({
  windowMs: pin.windowMs,
  max: pin.maxFailuresPerUser,
  isFailure: pinFailure,
  message: PIN_MESSAGE,
  keyFn: (req) => (req.auth?.userId ? `pin-user|${req.auth.userId}` : null),
});

export const pinStudentLimiter = createLimiter({
  windowMs: pin.windowMs,
  max: pin.maxFailuresPerStudent,
  isFailure: pinFailure,
  message: PIN_MESSAGE,
  keyFn: (req) => (req.auth?.schoolId && req.validated?.body?.studentId ? `pin-student|${req.auth.schoolId}|${req.validated.body.studentId}` : null),
});

export const pinIpLimiter = createLimiter({
  windowMs: pin.windowMs,
  max: pin.maxFailuresPerIp,
  isFailure: pinFailure,
  message: PIN_MESSAGE,
  keyFn: (req) => `pin-ip|${req.ip}`,
});

// The public website's read-only endpoints: every request counts, per IP address.
export const publicReadLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  isFailure: () => true,
  message: 'Too many requests. Please wait a moment before trying again.',
  keyFn: (req) => `public|${req.ip}`,
});

// Report exports build a whole file, so they are limited per signed-in user (every request counts).
export const reportExportLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  isFailure: () => true,
  message: 'Too many report exports. Please wait a few minutes before exporting again.',
  keyFn: (req) => (req.auth?.userId ? `export|${req.auth.userId}` : null),
});

// Used by tests to start from a clean slate.
export const clearRateLimits = () => {
  reportExportLimiter.clear();
  pinUserLimiter.clear();
  pinStudentLimiter.clear();
  pinIpLimiter.clear();
  accountLinkLimiter.clear();
  publicReadLimiter.clear();
};
