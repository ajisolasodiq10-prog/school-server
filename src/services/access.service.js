import { AcademicSession, Class, Student, Teacher } from '../models/index.js';
import { forbidden } from '../utils/AppError.js';

// The one place that decides WHICH records each role may see.
//
// Each function returns a MongoDB filter. Services add it to every query, so a record
// outside the user's scope is simply never found (the API answers 404, so it does not
// even confirm the record exists). Two rules apply to every scope:
//   1. schoolId always comes from the authenticated user's database record, never from
//      the request. A document id from another school therefore matches nothing.
//   2. a missing id can never widen a scope: the guard below refuses to build one.

const assertAuth = (auth) => {
  if (!auth?.userId || !auth?.schoolId || !auth?.role) {
    throw forbidden('Authentication context is incomplete.');
  }
};

const NOTHING = { _id: { $in: [] } };

// Classes and subjects a teacher is responsible for. Only teachers whose employment is
// 'active' get any access, so setting a teacher to inactive/resigned/on leave removes their
// access to class data even if their login account were still active.
export async function getTeacherScope(auth) {
  assertAuth(auth);
  const teacher = await Teacher.findOne({
    schoolId: auth.schoolId,
    userId: auth.userId,
    employmentStatus: 'active',
  }).select('subjectIds classIds');

  if (!teacher) return { teacher: null, classIds: [], subjectIds: [] };

  // Assigned classes, plus any class this teacher is the class teacher of.
  const classTeacherOf = await Class.distinct('_id', {
    schoolId: auth.schoolId,
    classTeacherId: teacher._id,
  });
  const unique = new Map();
  for (const id of [...teacher.classIds, ...classTeacherOf]) unique.set(String(id), id);

  return { teacher, classIds: [...unique.values()], subjectIds: teacher.subjectIds };
}

// Classes the user's own class membership gives them. Student: their class, and ONLY while
// their status is 'active' (transferred/graduated students get no current class access).
// Parent: the classes of their linked children who are still active.
export async function getEnrolledClassIds(auth) {
  assertAuth(auth);
  const base = { schoolId: auth.schoolId, status: 'active', currentClassId: { $ne: null } };
  if (auth.role === 'student') {
    return Student.distinct('currentClassId', { ...base, userId: auth.userId });
  }
  if (auth.role === 'parent') {
    return Student.distinct('currentClassId', { ...base, guardianUserIds: auth.userId });
  }
  return [];
}

// Which student records the user may see.
export async function studentScope(auth) {
  assertAuth(auth);
  const base = { schoolId: auth.schoolId };
  switch (auth.role) {
    case 'admin':
      return base; // every student in their own school
    case 'teacher': {
      const { classIds } = await getTeacherScope(auth);
      return { ...base, currentClassId: { $in: classIds } }; // students in their classes
    }
    case 'student':
      return { ...base, userId: auth.userId }; // only their own record, whatever their status
    case 'parent':
      return { ...base, guardianUserIds: auth.userId }; // only explicitly linked children
    default:
      return { ...base, ...NOTHING };
  }
}

// Which classes the user may see.
export async function classScope(auth) {
  assertAuth(auth);
  const base = { schoolId: auth.schoolId };
  switch (auth.role) {
    case 'admin':
      return base;
    case 'teacher': {
      const { classIds } = await getTeacherScope(auth);
      return { ...base, _id: { $in: classIds } };
    }
    case 'student':
    case 'parent':
      return { ...base, _id: { $in: await getEnrolledClassIds(auth) } };
    default:
      return { ...base, ...NOTHING };
  }
}

// Which subjects the user may see.
//   admin    every subject in the school
//   teacher  the subjects they are assigned to teach
//   student / parent  the subjects offered in the (active) class of the student
export async function subjectScope(auth) {
  assertAuth(auth);
  const base = { schoolId: auth.schoolId };
  switch (auth.role) {
    case 'admin':
      return base;
    case 'teacher': {
      const { subjectIds } = await getTeacherScope(auth);
      return { ...base, _id: { $in: subjectIds } };
    }
    case 'student':
    case 'parent': {
      const classIds = await getEnrolledClassIds(auth);
      const subjectIds = await Class.distinct('subjectIds', { schoolId: auth.schoolId, _id: { $in: classIds } });
      return { ...base, _id: { $in: subjectIds } };
    }
    default:
      return { ...base, ...NOTHING };
  }
}

// Which academic sessions the user may see. Administrators see all of them (history
// included). Everyone else sees the current session plus the sessions of classes they can see.
export async function sessionScope(auth) {
  assertAuth(auth);
  const base = { schoolId: auth.schoolId };
  if (auth.role === 'admin') return base;

  const [fromClasses, current] = await Promise.all([
    Class.distinct('academicSessionId', await classScope(auth)),
    AcademicSession.distinct('_id', { ...base, isCurrent: true }),
  ]);
  return { ...base, _id: { $in: [...fromClasses, ...current] } };
}
