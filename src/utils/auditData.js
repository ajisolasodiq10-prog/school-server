// Pure helpers for audit entries (no database): keeping secrets out, and before/after diffs.

// Keys whose values must never be written to the trail, whatever a caller passes in:
// passwords and hashes, tokens, PINs (plaintext or hashed), salts and similar secrets.
// Matching is on the key NAME, so ordinary ids and counts (pinsGenerated, termId) are kept.
const SECRET_KEY =
  /^(pass(word)?|passwd|pwd|pin|pins|pincode|pinvalue|plainpin|salt|secret|jwt|token|authorization|cookie|apikey|api_key|credentials?|otp)$|(hash|token|secret|password|passwd)$/i;
const JWT_LIKE = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const HASH_LIKE = /^\$2[aby]\$\d{2}\$|^scrypt\$/i;
const REMOVED = '[removed]';
const MAX_DEPTH = 6;
const MAX_ITEMS = 200;
const MAX_TEXT = 500;

const isIdOrDate = (value) => value instanceof Date || typeof value?.toHexString === 'function' || value?._bsontype != null;

// A cleaned copy of `value`: secret-named keys and secret-looking strings removed, long text
// and lists cut, nothing but plain data left. Used on every entry before it is stored.
export function sanitizeAuditDetails(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (JWT_LIKE.test(value) || HASH_LIKE.test(value)) return REMOVED;
    return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (isIdOrDate(value)) return value;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return REMOVED;
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => sanitizeAuditDetails(item, depth + 1));

  const plain = typeof value.toObject === 'function' ? value.toObject() : value;
  const clean = {};
  for (const [key, inner] of Object.entries(plain)) {
    if (key.startsWith('$')) continue; // never store operator-looking keys
    clean[key] = SECRET_KEY.test(key) ? REMOVED : sanitizeAuditDetails(inner, depth + 1);
  }
  return clean;
}

const same = (a, b) => {
  const norm = (v) => (v instanceof Date ? v.getTime() : Array.isArray(v) ? JSON.stringify(v.map(String).sort()) : v == null ? null : String(v));
  return norm(a) === norm(b);
};

// The values of `keys` on a document (or plain object), as plain data, for "before" snapshots.
export function pickFields(source, keys) {
  const out = {};
  for (const key of keys) out[key] = source?.[key] ?? null;
  return out;
}

// Before/after of only the fields that actually changed: { changed: [...], before, after }.
// `changed` is empty when nothing differs, so callers can skip writing an entry.
export function diffFields(before, after, keys) {
  const changed = keys.filter((key) => !same(before?.[key], after?.[key]));
  return {
    changed,
    before: Object.fromEntries(changed.map((key) => [key, before?.[key] ?? null])),
    after: Object.fromEntries(changed.map((key) => [key, after?.[key] ?? null])),
  };
}

export const cut = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text);

