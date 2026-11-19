import { badRequest } from './AppError.js';

// A tiny, dependency-free request validator.
//
// A "shape" maps allowed field names to rules. Anything NOT in the shape is rejected,
// which is the protection against mass assignment: a client can never slip in
// { role: 'admin' } or { schoolId: '...' } because those keys are simply not allowed.
// Every rule also insists on the right TYPE, so NoSQL-injection payloads such as
// { "email": { "$ne": null } } are rejected before they can reach a query.
//
// A rule is a function (raw) => ({ value }) | ({ error }).

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME = /^[a-z0-9][a-z0-9._/-]*$/;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export const rules = {
  text:
    (opts = {}) =>
    (raw) => {
      if (typeof raw !== 'string') return { error: 'must be text' };
      let value = opts.trim === false ? raw : raw.trim();
      if (opts.collapseSpaces) value = value.replace(/\s+/g, ' '); // "JSS   1" -> "JSS 1"
      if (opts.lowercase) value = value.toLowerCase();
      if (opts.uppercase) value = value.toUpperCase();
      const min = opts.min ?? 1;
      if (value.length < min) {
        return { error: min <= 1 ? 'must not be empty' : `must be at least ${min} characters` };
      }
      if (opts.max !== undefined && value.length > opts.max) {
        return { error: `must be at most ${opts.max} characters` };
      }
      if (opts.pattern && !opts.pattern.test(value)) {
        return { error: opts.patternMessage || 'has an invalid format' };
      }
      return { value };
    },

  email: () =>
    rules.text({
      lowercase: true,
      max: 254,
      pattern: EMAIL,
      patternMessage: 'must be a valid email address',
    }),

  username: () =>
    rules.text({
      lowercase: true,
      min: 3,
      max: 40,
      pattern: USERNAME,
      patternMessage: 'may only contain letters, numbers, dots, underscores, hyphens and slashes',
    }),

  objectId: () =>
    rules.text({ pattern: OBJECT_ID, patternMessage: 'must be a valid id', max: 24, min: 24 }),

  enumOf: (allowed) => (raw) =>
    typeof raw === 'string' && allowed.includes(raw)
      ? { value: raw }
      : { error: `must be one of: ${allowed.join(', ')}` },

  // Accepts "YYYY-MM-DD" (or a full ISO timestamp) and rejects impossible dates such as
  // 2026-02-31, which JavaScript would otherwise quietly turn into 3 March.
  date: () => (raw) => {
    const match = typeof raw === 'string' && /^(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/.exec(raw);
    if (!match) return { error: 'must be a date in YYYY-MM-DD format' };
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return { error: 'must be a valid date' };
    const [, year, month, day] = match.map(Number);
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      return { error: 'must be a real calendar date' };
    }
    return { value: date };
  },

  // A real JSON boolean (true / false). Strings such as "true" are rejected on purpose.
  bool: () => (raw) => (typeof raw === 'boolean' ? { value: raw } : { error: 'must be true or false' }),

  // A finite JSON number within bounds, rounded to two decimals (for scores).
  number:
    ({ min = -Infinity, max = Infinity } = {}) =>
    (raw) => {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return { error: 'must be a number' };
      if (raw < min || raw > max) return { error: `must be between ${min} and ${max}` };
      return { value: Math.round(raw * 100) / 100 };
    },

  // Whole-number query-string value ("2") within bounds.
  intString: ({ min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => (raw) => {
    if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return { error: 'must be a whole number' };
    const value = Number(raw);
    if (value < min || value > max) return { error: `must be between ${min} and ${max}` };
    return { value };
  },

  // A list of objects, each validated against its own shape (unknown fields rejected).
  objects:
    (shape, { max = 10 } = {}) =>
    (raw) => {
      if (!Array.isArray(raw)) return { error: 'must be a list' };
      if (raw.length > max) return { error: `must contain at most ${max} items` };
      const items = [];
      for (const [index, item] of raw.entries()) {
        try {
          items.push(parse(shape, item));
        } catch (error) {
          const problems = (error.details || [])
            .map((d) => `${d.field} ${d.message}`)
            .join('; ');
          return { error: `item ${index + 1}: ${problems || error.message}` };
        }
      }
      return { value: items };
    },

  // A list of object ids with duplicates removed.
  idList:
    ({ max = 100 } = {}) =>
    (raw) => {
      if (!Array.isArray(raw)) return { error: 'must be a list of ids' };
      if (raw.length > max) return { error: `must contain at most ${max} ids` };
      const check = rules.objectId();
      const ids = [];
      for (const item of raw) {
        const result = check(item);
        if (result.error) return { error: `contains an invalid id (${result.error})` };
        ids.push(result.value.toLowerCase());
      }
      return { value: [...new Set(ids)] };
    },
};

// Marks a rule as optional: when the field is absent it is simply left out of the result.
export const optional = (rule) => Object.assign((raw) => rule(raw), { optional: true });

// Lets a field be sent as null (used to clear a value, e.g. remove a class teacher).
export const nullable = (rule) =>
  Object.assign((raw) => (raw === null ? { value: null } : rule(raw)), { optional: rule.optional });

// Validates `input` against `shape`. Returns only whitelisted, cleaned values, or throws a
// 400 listing every problem.
export function parse(shape, input, { allowUnknown = false } = {}) {
  const source = input === undefined ? {} : input;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw badRequest('Request data must be a JSON object.', { code: 'VALIDATION_ERROR' });
  }

  const errors = [];
  const value = {};

  if (!allowUnknown) {
    for (const key of Object.keys(source)) {
      if (!hasOwn(shape, key)) errors.push({ field: key, message: 'is not an allowed field' });
    }
  }

  for (const [key, rule] of Object.entries(shape)) {
    const raw = hasOwn(source, key) ? source[key] : undefined;
    if (raw === undefined) {
      if (!rule.optional) errors.push({ field: key, message: 'is required' });
      continue;
    }
    const result = rule(raw);
    if (result.error) errors.push({ field: key, message: result.error });
    else value[key] = result.value;
  }

  if (errors.length > 0) {
    throw badRequest('Validation failed.', { code: 'VALIDATION_ERROR', details: errors });
  }
  return value;
}

// Express middleware: validates body / query / params and stores the CLEANED values on
// req.validated. Controllers must read from req.validated, never from req.body directly.
export const validate = ({ body, query, params } = {}) => (req, res, next) => {
  try {
    req.validated = {
      body: body ? parse(body, req.body) : undefined,
      // Unknown query-string keys are ignored (browsers/proxies sometimes add their own).
      query: query ? parse(query, req.query, { allowUnknown: true }) : undefined,
      params: params ? parse(params, req.params) : undefined,
    };
    next();
  } catch (error) {
    next(error);
  }
};
