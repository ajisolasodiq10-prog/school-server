import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

// Client for the Account Management Backend (a separate service that owns credentials,
// activation, password reset and authentication). Every call is server-to-server and
// authenticated with ACCOUNT_SERVICE_API_KEY. This file is the ONLY place that talks to it.
//
// The full contract is in docs/ACCOUNT_SERVICE_CONTRACT.md. In short:
//   POST /internal/v1/accounts                        create an account (pending_activation)
//   POST /internal/v1/accounts/void                   undo a create whose outcome is unknown
//   GET  /internal/v1/accounts/:accountId             read status
//   PUT  /internal/v1/accounts/:accountId/status      activate / deactivate / suspend
//   PATCH /internal/v1/accounts/:accountId            keep email / name in step
//   POST /internal/v1/accounts/:accountId/activation-link
//   POST /internal/v1/accounts/:accountId/password-reset-link   (students only, admin-assisted)
//   POST /internal/v1/accounts/import                 migration of existing accounts
//
// Secrets: links and tokens are returned to the caller ONCE and are never logged, stored or
// put in an error message here. Error messages never contain the response body.

const PREFIX = '/internal/v1/accounts';
export const ACCOUNT_STATUSES = ['pending_activation', 'active', 'deactivated', 'suspended'];

// Error codes the account service may send that are safe and useful to pass on to the client.
const PASS_THROUGH = new Set([
  'LOGIN_ID_TAKEN',
  'EMAIL_TAKEN',
  'ACCOUNT_NOT_ACTIVE',
  'ACCOUNT_PENDING_ACTIVATION',
  'ACCOUNT_ALREADY_ACTIVATED',
  'ACCOUNT_NOT_FOUND',
  'INVALID_STATUS_TRANSITION',
]);

const unavailable = (message = 'The account service is not reachable. Nothing was changed. Please try again shortly.', ambiguous = false, detail = undefined) => {
  const error = new AppError(503, message, { code: 'ACCOUNT_SERVICE_UNAVAILABLE' });
  error.detail = detail; // short technical reason for the operator (e.g. ECONNREFUSED, HTTP 503); never a secret
  error.ambiguous = ambiguous; // true when a write may have been applied although no answer arrived
  return error;
};
const badGateway = (message, code = 'ACCOUNT_SERVICE_ERROR', ambiguous = false) => {
  const error = new AppError(502, message, { code });
  error.ambiguous = ambiguous;
  return error;
};

async function send(method, path, { body, idempotencyKey, retries = 0, signal } = {}) {
  const { url, apiKey, timeoutMs } = config.accountService;
  const headers = {
    Accept: 'application/json',
    'X-API-Key': apiKey,
    'X-Service-Name': 'school-management-api',
    'X-Request-Id': crypto.randomUUID(),
    ...(body !== undefined && { 'Content-Type': 'application/json' }),
    ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
  };
  const isWrite = method !== 'GET';

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: signal ?? AbortSignal.timeout(timeoutMs),
        redirect: 'error', // never follow a redirect with the API key attached
      });
    } catch (cause) {
      if (attempt < retries) continue;
      throw unavailable(undefined, isWrite, cause?.cause?.code ?? cause?.cause?.message ?? cause?.name ?? 'network error');
    }

    let json = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }

    if (response.ok) return { status: response.status, data: json?.data ?? null };

    if (response.status >= 500 && attempt < retries) continue;
    if (response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) {
      throw unavailable(undefined, isWrite, `HTTP ${response.status} from ${url}${path.split('?')[0].replace(/\/[0-9a-f]{24}/g, '/:id')}`);
    }
    if (response.status >= 500) throw badGateway('The account service failed to complete the request. Nothing was changed.', 'ACCOUNT_SERVICE_ERROR', isWrite);
    if (response.status === 401 || response.status === 403) {
      // Our API key was refused: a configuration problem, never the end user's fault.
      throw badGateway('This server is not authorised by the account service. Contact the system operator.', 'ACCOUNT_SERVICE_AUTH_FAILED');
    }
    const code = typeof json?.code === 'string' && PASS_THROUGH.has(json.code) ? json.code : null;
    if (response.status === 404) {
      throw new AppError(404, 'The login account was not found at the account service.', { code: code ?? 'ACCOUNT_NOT_FOUND' });
    }
    if (response.status === 409) {
      throw new AppError(409, conflictMessage(code), { code: code ?? 'ACCOUNT_CONFLICT' });
    }
    throw badGateway('The account service rejected the request.', code ?? 'ACCOUNT_SERVICE_REJECTED');
  }
}

function conflictMessage(code) {
  switch (code) {
    case 'LOGIN_ID_TAKEN': return 'That login ID is already in use.';
    case 'EMAIL_TAKEN': return 'That email is already used by another account.';
    case 'ACCOUNT_NOT_ACTIVE': return 'This account is not active, so a password reset cannot be issued. Reactivate the account first.';
    case 'ACCOUNT_PENDING_ACTIVATION': return 'This account has not been activated yet. Give the person their activation link instead.';
    case 'ACCOUNT_ALREADY_ACTIVATED': return 'This account is already activated.';
    case 'INVALID_STATUS_TRANSITION': return 'The account cannot change to that status.';
    default: return 'The account service could not apply this change.';
  }
}

const isString = (v) => typeof v === 'string' && v.length > 0 && v.length <= 2000;
const bad = () => badGateway('The account service sent an unexpected answer. Nothing was assumed to have worked.', 'ACCOUNT_SERVICE_BAD_RESPONSE', true);

function readLink(data) {
  if (!data || !isString(data.link) || !/^https?:\/\//.test(data.link)) throw bad();
  const expiresAt = new Date(data.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) throw bad();
  return { link: data.link, expiresAt };
}

// ------------------------------------------------------------------ operations

// Asks the account service to create a login account in `pending_activation`.
// `delivery`: 'email' (the account service emails the activation link) or 'link' (the link is
// returned here so the administrator can pass it on). `idempotencyKey` makes a repeat safe.
export async function createAccount({ idempotencyKey, schoolId, schoolCode, userId, role, loginId, fullName, email, profile, delivery, requestedBy }) {
  const { data } = await send('POST', PREFIX, {
    idempotencyKey,
    body: {
      externalRef: { schoolId: String(schoolId), userId: String(userId) },
      // The school code lets the person sign in with it (the website sends it with every login).
      ...(schoolCode && { schoolCode }),
      role,
      loginId,
      fullName,
      ...(email && { email }),
      profile: profile ? { type: profile.type, id: String(profile.id), code: profile.code } : undefined,
      delivery,
      requestedBy: requestedBy ? { userId: String(requestedBy.userId), role: requestedBy.role } : undefined,
    },
  });
  if (!data || !isString(data.accountId) || data.status !== 'pending_activation') throw bad();
  const result = { accountId: data.accountId, status: data.status };
  if (delivery === 'link') result.activation = readLink(data.activation);
  else if (data.activation?.expiresAt) result.activation = { expiresAt: new Date(data.activation.expiresAt) };
  return result;
}

// Undoes a create whose outcome is not known (timeout). Safe to call when nothing was created.
export async function voidAccount({ schoolId, userId }) {
  await send('POST', `${PREFIX}/void`, {
    body: { externalRef: { schoolId: String(schoolId), userId: String(userId) } },
    idempotencyKey: `void:${userId}`,
  });
}

export async function getAccountStatus(accountId, { retries } = {}) {
  const { data } = await send('GET', `${PREFIX}/${encodeURIComponent(accountId)}`, {
    retries: retries ?? config.accountService.readRetries,
  });
  if (!data || data.accountId !== accountId || !ACCOUNT_STATUSES.includes(data.status)) throw bad();
  return {
    accountId,
    status: data.status,
    tokenVersion: Number.isInteger(data.tokenVersion) ? data.tokenVersion : null,
    activatedAt: data.activatedAt ? new Date(data.activatedAt) : null,
    lastLoginAt: data.lastLoginAt ? new Date(data.lastLoginAt) : null,
  };
}

// Moves an account to 'active', 'deactivated' or 'suspended'. The account service refuses to
// activate an account that was never activated (pending_activation): that needs the link.
export async function setAccountStatus(accountId, status, { requestedBy, reason, idempotencyKey } = {}) {
  const { data } = await send('PUT', `${PREFIX}/${encodeURIComponent(accountId)}/status`, {
    idempotencyKey,
    body: {
      status,
      ...(reason && { reason }),
      requestedBy: requestedBy ? { userId: String(requestedBy.userId), role: requestedBy.role } : undefined,
    },
  });
  if (!data || data.status !== status) throw bad();
  invalidateStatus(accountId);
  return { accountId, status };
}

// Keeps the contact email / display name at the account service in step with the profile.
export async function updateAccountContact(accountId, { email, fullName }) {
  await send('PATCH', `${PREFIX}/${encodeURIComponent(accountId)}`, {
    body: { ...(email !== undefined && { email }), ...(fullName !== undefined && { fullName }) },
  });
}

// (Re)issues an activation link for an account that is still pending_activation. Issuing a new
// link invalidates the previous one. Returned once; the caller must not store it.
export async function issueActivationLink(accountId, { requestedBy }) {
  const { data } = await send('POST', `${PREFIX}/${encodeURIComponent(accountId)}/activation-link`, {
    body: { requestedBy: { userId: String(requestedBy.userId), role: requestedBy.role } },
  });
  return readLink(data);
}

// Admin-assisted reset for a STUDENT (or parent) account: a secure, expiring, single-use link.
// The account service must refuse (409) for any account that is not currently active.
export async function issuePasswordResetLink(accountId, { requestedBy, reason }) {
  const { data } = await send('POST', `${PREFIX}/${encodeURIComponent(accountId)}/password-reset-link`, {
    body: { requestedBy: { userId: String(requestedBy.userId), role: requestedBy.role }, ...(reason && { reason }) },
  });
  return readLink(data);
}

// Migration only: hands an existing account (with its bcrypt hash) to the account service.
export async function importAccount(record) {
  const { data } = await send('POST', `${PREFIX}/import`, {
    idempotencyKey: `import:${record.externalRef.userId}`,
    body: record,
  });
  if (!data || !isString(data.accountId) || !ACCOUNT_STATUSES.includes(data.status)) throw bad();
  return { accountId: data.accountId, status: data.status };
}

// ---------------------------------------------------- status cache for authenticate()

// A short-lived cache, so that every API request does not need a network call. It is
// per-process and holds nothing but the account status. Only "found" answers are cached;
// failures are never cached, and when the service cannot be reached (and no fresh answer is
// held) the request is REFUSED (fail closed).
const cache = new Map();

export const invalidateStatus = (accountId) => cache.delete(accountId);
export const clearStatusCache = () => cache.clear();

export async function getLiveStatus(accountId) {
  const ttl = config.accountService.statusCacheSeconds * 1000;
  const now = Date.now();
  const hit = cache.get(accountId);
  if (ttl > 0 && hit && hit.until > now) return hit.value;
  const value = await getAccountStatus(accountId);
  if (ttl > 0) {
    cache.set(accountId, { value, until: now + ttl });
    if (cache.size > 5000) for (const [key, entry] of cache) if (entry.until <= now) cache.delete(key);
  }
  return value;
}
