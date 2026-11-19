import { School, SchoolSettings } from '../models/index.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { recordAudit } from './audit.service.js';

// SCHOOL SETTINGS
//   administrators  change the school details, the score maximums, the grade boundaries and what
//                   a result shows.
//   everyone else   reads them (the dashboards need the maximums and grade boundaries).
// Before an administrator saves, the defaults below apply.

export const DEFAULT_BANDS = [
  { grade: 'A', remark: 'Excellent', min: 70 },
  { grade: 'B', remark: 'Very Good', min: 60 },
  { grade: 'C', remark: 'Good', min: 50 },
  { grade: 'D', remark: 'Fair', min: 45 },
  { grade: 'E', remark: 'Pass', min: 40 },
  { grade: 'F', remark: 'Fail', min: 0 },
];

const view = (s) => ({
  schoolName: s.schoolName,
  address: s.address ?? '',
  email: s.email ?? '',
  phone: s.phone ?? '',
  caMax: s.caMax,
  examMax: s.examMax,
  gradeBands: s.gradeBands.map((b) => ({ grade: b.grade, remark: b.remark ?? '', min: b.min })),
  display: { showGrade: s.showGrade, showClassAverage: s.showClassAverage, showRemarks: s.showRemarks },
});

export async function getSettings(schoolId) {
  const saved = await SchoolSettings.findOne({ schoolId });
  if (saved) return view(saved);
  const school = await School.findById(schoolId);
  if (!school) throw notFound('School not found.');
  return view({
    schoolName: school.name,
    address: school.address,
    email: school.contactEmail,
    phone: school.contactPhone,
    caMax: 40,
    examMax: 60,
    gradeBands: DEFAULT_BANDS,
    showGrade: true,
    showClassAverage: true,
    showRemarks: true,
  });
}

// The two maximums, for checking entered scores.
export async function scoreLimits(schoolId) {
  const { caMax, examMax } = await getSettings(schoolId);
  return { caMax, examMax };
}

const invalid = (field, message) => badRequest('Invalid settings.', { code: 'VALIDATION_ERROR', details: [{ field, message }] });

export async function saveSettings(auth, body) {
  if (body.caMax + body.examMax !== 100) throw invalid('examMax', `The CA and exam maximums must add up to 100 (they add up to ${body.caMax + body.examMax}).`);
  const bands = body.gradeBands;
  if (bands.length === 0) throw invalid('gradeBands', 'Add at least one grade.');
  if (bands[bands.length - 1].min !== 0) throw invalid('gradeBands', 'The lowest grade must start at 0.');
  for (let i = 1; i < bands.length; i += 1) {
    if (bands[i].min >= bands[i - 1].min) throw invalid('gradeBands', `Grade ${bands[i].grade} must start lower than grade ${bands[i - 1].grade}.`);
  }
  if (new Set(bands.map((b) => b.grade.toUpperCase())).size !== bands.length) throw invalid('gradeBands', 'Each grade can only appear once.');

  const { showGrade, showClassAverage, showRemarks, ...rest } = body;
  await SchoolSettings.findOneAndUpdate(
    { schoolId: auth.schoolId },
    { $set: { ...rest, showGrade, showClassAverage, showRemarks, updatedBy: auth.userId }, $setOnInsert: { schoolId: auth.schoolId } },
    { upsert: true, new: true, runValidators: true }
  );
  await recordAudit(auth, { action: 'settings.updated', entityType: 'settings', summary: 'School settings updated', details: { caMax: body.caMax, examMax: body.examMax } });
  return getSettings(auth.schoolId);
}

// Back to the defaults.
export async function resetSettings(auth) {
  await SchoolSettings.deleteOne({ schoolId: auth.schoolId });
  await recordAudit(auth, { action: 'settings.reset', entityType: 'settings', summary: 'School settings restored to defaults' });
  return getSettings(auth.schoolId);
}
