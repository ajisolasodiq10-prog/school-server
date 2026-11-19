import { config } from '../config/env.js';
import { School } from '../models/index.js';
import { badRequest, notFound } from '../utils/AppError.js';

// The public website has no signed-in user, so the school comes from a school code in the
// request (or DEFAULT_SCHOOL_CODE for a single-school installation). Only an active school
// is ever found; an unknown, inactive or mistyped code all give the same "not found".
export async function resolvePublicSchool(schoolCode) {
  const code = schoolCode ?? config.defaultSchoolCode;
  if (!code) throw badRequest('School code is required.', { code: 'SCHOOL_CODE_REQUIRED' });
  const school = await School.findOne({ code, status: 'active' });
  if (!school) throw notFound('School not found.');
  return school;
}
