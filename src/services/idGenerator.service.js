import { AppError } from '../utils/AppError.js';

// Generates the next school-issued ID, such as STU-2026-0007 or TCH-0012.
//
// Nothing is stored in a counter. The next number is "highest existing number with this
// prefix, in this school, plus one". Two administrators registering at the same moment can
// compute the same number; the unique index (schoolId + ID) then rejects the second save,
// and withGeneratedId() simply tries again with a fresh number.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function nextSequentialId(Model, field, schoolId, prefix, width = 4) {
  const last = await Model.findOne({ schoolId, [field]: new RegExp(`^${escapeRegex(prefix)}\\d+$`) })
    .collation({ locale: 'en', numericOrdering: true })
    .sort({ [field]: -1 })
    .select(field)
    .lean();
  const lastNumber = last ? Number.parseInt(String(last[field]).slice(prefix.length), 10) : 0;
  return `${prefix}${String(lastNumber + 1).padStart(width, '0')}`;
}

const isDuplicate = (error) => error?.code === 11000 || (error instanceof AppError && error.status === 409);

// Runs create(id) with a freshly generated ID. Retries only when the ID was generated here;
// an ID typed by the administrator that already exists is reported as a conflict at once.
export async function withGeneratedId({ supplied, generate, create, attempts = 5 }) {
  if (supplied) return create(supplied);
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await create(await generate());
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
