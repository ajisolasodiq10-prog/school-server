import { forbidden } from '../utils/AppError.js';

// Student lifecycle policy: what a student (and, through them, a parent) may use, decided
// by the student's status. This is the single source of truth. Routes, services and the
// future assignments / materials / results / announcements features must ask it, instead
// of re-implementing the rules.
//
//   active       everything: profile, current classes and subjects, assignments, learning
//                materials, results, public and private announcements
//   transferred  profile, previously published results, public announcements.
//   graduated    (same as transferred) No new class updates, assignments, materials or
//                private student announcements.
//   inactive     profile only. The brief does not define this status; the restrictive
//                choice is made on purpose, and one line below changes it.
//
// Nothing here ever deletes or hides stored records. A transferred or graduated student's
// account, class history and results all stay in the database.

export const CAPABILITIES = [
  'profile',
  'currentAcademics', // current class, subjects and class updates
  'assignments',
  'learningMaterials',
  'results',
  'publicAnnouncements',
  'privateAnnouncements',
];

const ALL = Object.fromEntries(CAPABILITIES.map((name) => [name, true]));
const PROFILE_ONLY = Object.fromEntries(CAPABILITIES.map((name) => [name, name === 'profile']));
const LEFT_SCHOOL = {
  ...PROFILE_ONLY,
  results: true, // previously published results only (see resultsAccess below)
  publicAnnouncements: true,
};

const POLICY = {
  active: ALL,
  transferred: LEFT_SCHOOL,
  graduated: LEFT_SCHOOL,
  inactive: PROFILE_ONLY,
};

const hasLeft = (status) => status === 'transferred' || status === 'graduated';

// Everything the policy says about one student record.
export function getStudentAccess(student) {
  const capabilities = { ...(POLICY[student.status] ?? PROFILE_ONLY) };
  return {
    status: student.status,
    capabilities,
    // How results may be read. Active students: every published result. Students who have
    // left: only results published up to the day they left (publishedBefore), never anything
    // new. The results feature must apply these two values to its queries.
    resultsAccess: {
      allowed: capabilities.results,
      publishedOnly: true,
      publishedBefore: hasLeft(student.status) ? (student.statusChangedAt ?? null) : null,
    },
  };
}

export const canStudentAccess = (student, capability) =>
  getStudentAccess(student).capabilities[capability] === true;

// Throws 403 with a clear, machine-readable code when the student's status does not allow it.
export function assertStudentCapability(student, capability) {
  if (!CAPABILITIES.includes(capability)) {
    throw new Error(`Unknown student capability: ${capability}`); // a programming error
  }
  if (!canStudentAccess(student, capability)) {
    throw forbidden(
      `Students with status "${student.status}" cannot access this. Contact your school administrator.`,
      'STUDENT_STATUS_RESTRICTED'
    );
  }
}

// For the future results feature: may this student's account open a result published at
// `publishedAt`? Active students: yes. Students who have left: only results published up to
// the day they left; anything published afterwards stays closed. If the leaving date or the
// publish date is unknown the answer is no (fail closed). Students who are inactive: no.
export function canViewPublishedResult(student, publishedAt) {
  const { capabilities, resultsAccess } = getStudentAccess(student);
  if (!capabilities.results) return false;
  if (student.status === 'active') return true;
  const cutoff = resultsAccess.publishedBefore;
  if (!cutoff || !publishedAt) return false;
  return new Date(publishedAt) <= new Date(cutoff);
}
