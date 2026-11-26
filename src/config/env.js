import dotenv from 'dotenv';

// Loads server/.env into process.env (does nothing if the file is missing,
// so real environment variables on a host still work).
dotenv.config();

const fail = (message) => {
  console.error(`[config] ${message}`);
  process.exit(1);
};

const nodeEnv = process.env.NODE_ENV || 'development';

// The school backend never signs tokens or checks passwords: it trusts the Account Management
// Backend for that. These settings say where that backend is and how to verify its tokens.
const required = ['MONGODB_URI', 'ACCOUNT_SERVICE_URL', 'ACCOUNT_SERVICE_API_KEY', 'ACCOUNT_TOKEN_PUBLIC_KEY'];
const missing = required.filter((name) => !process.env[name]?.trim());

if (missing.length > 0) {
  fail(
    `Missing required environment variable(s): ${missing.join(', ')}.\n` +
      '         Copy server/.env.example to server/.env and fill in the values.'
  );
}

const accountServiceUrl = process.env.ACCOUNT_SERVICE_URL.trim().replace(/\/+$/, '');
if (!/^https?:\/\//.test(accountServiceUrl)) fail('ACCOUNT_SERVICE_URL must start with http:// or https://.');
if (nodeEnv === 'production' && !accountServiceUrl.startsWith('https://')) {
  fail('ACCOUNT_SERVICE_URL must use https:// in production.');
}
const accountApiKey = process.env.ACCOUNT_SERVICE_API_KEY.trim();
if (accountApiKey.length < 32) fail('ACCOUNT_SERVICE_API_KEY must be at least 32 characters long.');

// PEM text; "\n" written as two characters (common in hosting dashboards) is turned into real newlines.
const accountPublicKey = process.env.ACCOUNT_TOKEN_PUBLIC_KEY.trim().replace(/\\n/g, '\n');
if (!accountPublicKey.includes('BEGIN PUBLIC KEY')) {
  fail('ACCOUNT_TOKEN_PUBLIC_KEY must be a PEM public key ("-----BEGIN PUBLIC KEY-----"). Never put a private key here.');
}

// Reads an integer environment variable, or exits with a clear message if it is invalid.
const int = (name, fallback, { min, max } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    fail(`${name} must be a whole number between ${min ?? '-∞'} and ${max ?? '∞'} (got "${raw}").`);
  }
  return value;
};

const port = Number(process.env.PORT) || 5000;

// CLIENT_ORIGIN may hold several origins separated by commas.
const clientOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const tokenAlgorithms = (process.env.ACCOUNT_TOKEN_ALGORITHMS || 'RS256').split(',').map((a) => a.trim()).filter(Boolean);
if (tokenAlgorithms.length === 0 || tokenAlgorithms.some((a) => !/^(RS|PS|ES)(256|384|512)$|^EdDSA$/.test(a))) {
  fail('ACCOUNT_TOKEN_ALGORITHMS may only list asymmetric algorithms (RS256, PS256, ES256, EdDSA, ...). Shared-secret (HS*) and "none" are refused.');
}

export const config = {
  nodeEnv,
  port,
  mongoUri: process.env.MONGODB_URI.trim(),
  clientOrigins,

  // Account Management Backend (separate service, same database, separate ownership).
  accountService: {
    url: accountServiceUrl,
    apiKey: accountApiKey,
    timeoutMs: int('ACCOUNT_SERVICE_TIMEOUT_MS', 5000, { min: 500, max: 180000 }),
    // Extra tries for READ calls only. Writes carry an idempotency key and are not retried blindly.
    readRetries: int('ACCOUNT_SERVICE_READ_RETRIES', 1, { min: 0, max: 3 }),
    // How long a "this account is active" answer may be reused (seconds). 0 = ask on every request.
    statusCacheSeconds: int('ACCOUNT_STATUS_CACHE_SECONDS', 15, { min: 0, max: 300 }),
  },

  // How tokens issued by the Account Management Backend are verified (public key only).
  accountToken: {
    publicKey: accountPublicKey,
    algorithms: tokenAlgorithms,
    issuer: (process.env.ACCOUNT_TOKEN_ISSUER || 'account-management-api').trim(),
    audience: (process.env.ACCOUNT_TOKEN_AUDIENCE || 'school-management-api').trim(),
    clockToleranceSeconds: int('ACCOUNT_TOKEN_CLOCK_TOLERANCE_SECONDS', 5, { min: 0, max: 60 }),
  },

  // Student reset / activation link requests per administrator.
  accountLinkRateLimit: {
    windowMs: int('ACCOUNT_LINK_RATE_WINDOW_MINUTES', 15, { min: 1, max: 1440 }) * 60 * 1000,
    maxPerAdmin: int('ACCOUNT_LINK_MAX_REQUESTS', 30, { min: 1 }),
  },

  // Result PIN redemption. Only FAILED attempts are counted (a success is refunded).
  pinRateLimit: {
    windowMs: int('PIN_RATE_WINDOW_MINUTES', 15, { min: 1, max: 1440 }) * 60 * 1000,
    // Failed attempts per signed-in user.
    maxFailuresPerUser: int('PIN_MAX_FAILED_ATTEMPTS', 5, { min: 1 }),
    // Failed attempts per student, whoever sends them (several parents plus the student).
    maxFailuresPerStudent: int('PIN_MAX_FAILED_ATTEMPTS_PER_STUDENT', 10, { min: 1 }),
    // Failed attempts per IP address (a school may share one).
    maxFailuresPerIp: int('PIN_MAX_FAILED_ATTEMPTS_PER_IP', 100, { min: 1 }),
  },

  // Optional. For a single-school install: the school the public website endpoints use when the
  // request does not name one.
  defaultSchoolCode: (process.env.DEFAULT_SCHOOL_CODE || '').trim().toUpperCase() || undefined,

  // Number of reverse-proxy hops in front of the API (0 = none). Needed for correct client
  // IPs, and therefore correct rate limiting, when deployed behind nginx, a load balancer, etc.
  trustProxy: int('TRUST_PROXY', 0, { min: 0, max: 10 }),
};
