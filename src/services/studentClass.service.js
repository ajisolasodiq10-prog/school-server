import { AcademicSession, Class } from '../models/index.js';
import { AppError, badRequest } from '../utils/AppError.js';

// Class placement rules and class-history bookkeeping for students. Shared by student
// registration (account.service.js) and student management (student.service.js).

// The class must exist in the administrator's school, be active, and belong to a session
// that is not closed (a closed session is read-only history, nobody is placed into it).
export async function findAssignableClass(auth, classId) {
  const klass = await Class.findOne({ _id: classId, schoolId: auth.schoolId });
  if (!klass) {
    throw badRequest('That class was not found in this school.', {
      code: 'VALIDATION_ERROR',
      details: [{ field: 'classId', message: 'is not a class in this school' }],
    });
  }
  if (klass.status !== 'active') {
    throw new AppError(409, 'That class is inactive, so students cannot be placed in it.', { code: 'CLASS_INACTIVE' });
  }
  const session = await AcademicSession.findOne({ _id: klass.academicSessionId, schoolId: auth.schoolId }).select('status');
  if (!session || session.status === 'closed') {
    throw new AppError(409, "That class belongs to a closed academic session, so students cannot be placed in it.", {
      code: 'SESSION_CLOSED',
    });
  }
  return klass;
}

const openEntry = (student) => [...student.classHistory].reverse().find((entry) => !entry.endedAt);

// Ends the student's current class period (if any). Records saved before class history
// existed have a currentClassId but no entries: the old class is added so it is not lost.
export function closeClassEntry(student, endedAt, endedReason) {
  if (student.classHistory.length === 0 && student.currentClassId) {
    student.classHistory.push({
      classId: student.currentClassId,
      startedAt: student.admissionDate ?? endedAt,
      reason: 'admission',
    });
  }
  const entry = openEntry(student);
  if (entry) {
    // Never end a period before it began (a leaving date can pre-date a later class change).
    entry.endedAt = entry.startedAt > endedAt ? entry.startedAt : endedAt;
    entry.endedReason = endedReason;
  }
}

const EXIT_FOR = { promoted: 'promoted', repeated: 'repeated', adjusted: 'adjusted' };

// Places the student in `klass` from `startedAt`, keeping the previous class in history.
// `by` (user id) and `note` record who made a manual or promotion move, and why.
export function placeInClass(student, klass, reason, startedAt = new Date(), { by, note } = {}) {
  if (student.currentClassId) closeClassEntry(student, startedAt, EXIT_FOR[reason] ?? 'reassigned');
  student.classHistory.push({
    classId: klass._id,
    startedAt,
    reason,
    ...(by && { changedBy: by }),
    ...(note && { note }),
  });
  student.currentClassId = klass._id;
}

// Re-enrolling a student who had left: the last class is opened again from `startedAt`.
export function reopenLastClass(student, startedAt = new Date()) {
  if (!student.currentClassId || openEntry(student)) return;
  student.classHistory.push({ classId: student.currentClassId, startedAt, reason: 'reenrolled' });
}
