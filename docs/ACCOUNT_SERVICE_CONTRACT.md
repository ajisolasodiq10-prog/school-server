# Account Management Backend: API contract expected by the School Management Backend

This is what the School backend calls and relies on. The Account backend must implement it as written (or the
two sides must agree a change and update `src/services/accountManagement.service.js` and
`test/support/fakeAccountService.js`, which follows this document).

## Ownership

| Account backend owns | School backend owns |
|---|---|
| credentials, password hashes, sign-in, activation, password setup, reset tokens and their expiry, token issuing and revocation, auth rate limiting, teacher activation / reset emails | student and teacher profiles, classes, subjects, results, assignments, announcements, school permissions, school audit log |

The School backend stores **no** password, hash, activation token or reset token. It stores `accountId` (a stable
reference) and a mirrored `accountStatus` on its `User` record. The reference the other way is
`externalRef = { schoolId, userId }` (the School backend's `User._id`), which the Account backend must store and keep unique.

## Transport and authentication

* HTTPS in production. JSON bodies. Responses `{ "status": "success", "data": ... }`; errors `{ "status": "error", "code": "...", "message": "..." }`.
* Every request carries `X-API-Key: <ACCOUNT_SERVICE_API_KEY>` (the shared secret, at least 32 random characters),
  `X-Service-Name: school-management-api` and `X-Request-Id: <uuid>`. Missing or wrong key: **401**. The Account backend must
  compare keys in constant time and must **not** follow or issue redirects.
* Writes that create things carry `Idempotency-Key`. The same key must return the same result and never create a second object.
* Base path: `/internal/v1/accounts`. These routes must not be reachable from the public internet.

## Tokens (sign-in happens at the Account backend)

The Account backend authenticates the person (login ID + password, with its own rate limiting) and returns a JWT signed with an
**asymmetric private key** (RS256 by default; PS*/ES*/EdDSA also accepted). The School backend holds only the public key
(`ACCOUNT_TOKEN_PUBLIC_KEY`).

Required claims: `iss` = `account-management-api` (configurable), `aud` = `school-management-api` (configurable), `sub` = **accountId**,
`exp`, `jti`. Optional `tv` (integer token version): when present and the status endpoint returns a `tokenVersion`, they must be equal,
so the Account backend can end sessions (logout, password change) by raising `tokenVersion`.
The token **must not** be relied on for role or school: the School backend ignores such claims and reads them from its own record.
Token lifetime should be short (minutes to an hour).

## Endpoints

### 1. Create account: `POST /internal/v1/accounts`
Header `Idempotency-Key: create-account:<school userId>` (required).
```json
{
  "externalRef": { "schoolId": "...", "userId": "..." },
  "role": "teacher | student | parent | admin",
  "loginId": "tch-0001",            // student ID for students (lower-case); unique per school
  "fullName": "Ada Obi",
  "email": "ada@school.example",      // required for teachers and admins when delivery = email; optional otherwise
  "profile": { "type": "teacher|student", "id": "...", "code": "TCH-0001" },   // informational
  "delivery": "email | link",
  "requestedBy": { "userId": "...", "role": "admin" }
}
```
* Creates the account in `pending_activation` with a password-less state; generates a CSPRNG activation token (store only its hash), valid for a limited time (recommended 48 h), single use.
* `delivery: "email"`: the Account backend emails the activation link to `email`. Response has no link.
* `delivery: "link"`: the link is returned once in the response.
* **201** `{ "data": { "accountId": "acc_...", "status": "pending_activation", "activation": { "expiresAt": "ISO", "link": "https://..." /* link delivery only */ } } }`
* **409** `LOGIN_ID_TAKEN` (same school) or `EMAIL_TAKEN`. Never create two accounts for one idempotency key or one `externalRef.userId`.

### 2. Void: `POST /internal/v1/accounts/void`
`{ "externalRef": { "schoolId", "userId" } }`. Removes (or permanently disables) the account created for that reference if it exists and is still
`pending_activation`; **200** also when nothing exists. Idempotent. Used when a create call timed out and its outcome is unknown, so no
orphaned account remains. The Account backend should additionally expire unactivated accounts it has never heard from again.

### 3. Read status: `GET /internal/v1/accounts/:accountId`
**200** `{ "data": { "accountId", "status": "pending_activation|active|deactivated|suspended", "tokenVersion": 3, "activatedAt": "ISO|null", "lastLoginAt": "ISO|null" } }`; **404** unknown. Called on every authenticated School API request (cached about 15 s), so it must be fast. An answer other than 200 means the School backend refuses the request.

### 4. Change status: `PUT /internal/v1/accounts/:accountId/status`
`{ "status": "active|deactivated|suspended", "reason": "...", "requestedBy": { "userId", "role" } }` → **200** `{ "data": { "accountId", "status" } }`.
**409** `ACCOUNT_PENDING_ACTIVATION` when asked to set `active` on an account that was never activated (only the activation link activates).
Deactivating/suspending must also invalidate the account's sessions (raise `tokenVersion`).

### 5. Update contact: `PATCH /internal/v1/accounts/:accountId`
`{ "email": "...", "fullName": "..." }` (either). Keeps the address that activation / reset emails use in step with the school record. **409** `EMAIL_TAKEN`.

### 6. New activation link: `POST /internal/v1/accounts/:accountId/activation-link`
`{ "requestedBy": {...} }` → **200** `{ "data": { "link", "expiresAt" } }`. Only while `pending_activation` (else **409** `ACCOUNT_ALREADY_ACTIVATED`). Invalidates earlier links.

### 7. Admin-assisted password reset: `POST /internal/v1/accounts/:accountId/password-reset-link`
`{ "requestedBy": { "userId", "role": "admin" }, "reason": "..." }` → **200** `{ "data": { "link", "expiresAt" } }`.
Rules the Account backend must enforce itself (the School backend also checks): only for **student** (and parent) accounts, never teacher/admin (**403** `ROLE_NOT_ALLOWED`);
**409** `ACCOUNT_PENDING_ACTIVATION` if never activated; **409** `ACCOUNT_NOT_ACTIVE` if deactivated or suspended (a reset must never reactivate an account);
the token is CSPRNG, stored hashed, expiring (recommended 1 h), single use; requesting a new one invalidates older ones; log `requestedBy` in its own audit trail.

### 8. Import (migration only): `POST /internal/v1/accounts/import`
Header `Idempotency-Key: import:<userId>`.
```json
{ "externalRef": {...}, "role": "...", "loginId": "...", "fullName": "...", "email": "...",
  "status": "active|deactivated|suspended",
  "credential": { "algorithm": "bcrypt", "hash": "$2b$..." } }
```
**201** `{ "data": { "accountId", "status" } }`. The hash is accepted only on this route and is never logged or echoed.

### Teacher forgotten password
Entirely inside the Account backend (public "forgot password" by email, same response whether or not the address exists, rate limited,
single-use expiring token). The School backend has **no** route for it and does not take part.

### Error mapping done by the School backend
Network error / timeout / 429 / 502-504: **503** `ACCOUNT_SERVICE_UNAVAILABLE`. 5xx: **502**. 401/403 from the Account backend (bad API key): **502** `ACCOUNT_SERVICE_AUTH_FAILED` (a configuration problem, never shown as the user's fault).
Only these `code`s are passed through to clients: `LOGIN_ID_TAKEN`, `EMAIL_TAKEN`, `ACCOUNT_NOT_ACTIVE`, `ACCOUNT_PENDING_ACTIVATION`, `ACCOUNT_ALREADY_ACTIVATED`, `ACCOUNT_NOT_FOUND`, `INVALID_STATUS_TRANSITION`.
