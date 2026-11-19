import { AcademicSession, Class, Subject, Teacher, User } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { joinName, toTeacherView } from '../utils/serializers.js';
import { diffFields, pickFields, recordAudit } from './audit.service.js';
import { changeAccess, syncContact, undoAccess } from './accountAccess.service.js';

// Teacher management for school administrators.
//
// Teachers are NEVER deleted. Leaving the school (resigned, retired) or being deactivated
// only changes employmentStatus and the login status, so every class assignment, result and
// other record that points at the teacher stays intact.
//
// Every query filters on auth.schoolId, which comes from the authenticated administrator and
// never from the request, so another school's teachers cannot be found even with a valid id.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Access to protected teacher functions" follows employmentStatus:
//   active     login open, full access
//   on_leave   login open, but no class or student data (access.service.getTeacherScope)
//   inactive / resigned / retired   login closed: authenticate() refuses the account at once
const LOGIN_OPEN = new Set(['active', 'on_leave']);

async function findTeacher(auth, id) {
  const teacher = await Teacher.findOne({ _id: id, schoolId: auth.schoolId });
  if (!teacher) throw notFound('Teacher not found.');
  return teacher;
}

const accountOf = (user) =>
  user ? { id: String(user._id), username: user.username, email: user.email ?? null, status: user.status } : null;

const present = (teacher, user, extra = {}) => ({
  ...toTeacherView(teacher, { admin: true }),
  account: accountOf(user),
  ...extra,
});

// ------------------------------------------------------------ assignment checks

// Classes and subjects being ADDED to a teacher must exist in the school and be usable:
// classes active and in a session that is not closed, subjects active. Ones the teacher
// already has are only checked for existing, so history is never blocked from staying.
export async function assertTeachingAssignments(auth, { classIds, subjectIds } = {}, current = {}) {
  const problems = [];
  const added = (ids, existing = []) => {
    const had = new Set((existing || []).map(String));
    return (ids || []).filter((id) => !had.has(String(id)));
  };

  const newClassIds = added(classIds, current.classIds);
  if (newClassIds.length > 0) {
    const classes = await Class.find({ _id: { $in: newClassIds }, schoolId: auth.schoolId }).select(
      'status academicSessionId'
    );
    const sessions = await AcademicSession.find({
      _id: { $in: classes.map((c) => c.academicSessionId) },
      schoolId: auth.schoolId,
    }).select('status');
    const sessionStatus = new Map(sessions.map((s) => [String(s._id), s.status]));
    const found = new Map(classes.map((c) => [String(c._id), c]));

    for (const id of newClassIds) {
      const klass = found.get(String(id));
      if (!klass) problems.push({ field: 'classIds', message: `${id} is not a class in this school` });
      else if (klass.status !== 'active') problems.push({ field: 'classIds', message: `${id} is an inactive class` });
      else if (sessionStatus.get(String(klass.academicSessionId)) === 'closed') {
        problems.push({ field: 'classIds', message: `${id} belongs to a closed academic session` });
      }
    }
  }

  const newSubjectIds = added(subjectIds, current.subjectIds);
  if (newSubjectIds.length > 0) {
    const subjects = await Subject.find({ _id: { $in: newSubjectIds }, schoolId: auth.schoolId }).select('status');
    const found = new Map(subjects.map((s) => [String(s._id), s]));
    for (const id of newSubjectIds) {
      const subject = found.get(String(id));
      if (!subject) problems.push({ field: 'subjectIds', message: `${id} is not a subject in this school` });
      else if (subject.status !== 'active') problems.push({ field: 'subjectIds', message: `${id} is an inactive subject` });
    }
  }

  if (problems.length > 0) {
    throw badRequest('Some classes or subjects cannot be assigned to this teacher.', {
      code: 'VALIDATION_ERROR',
      details: problems,
    });
  }
}

// ----------------------------------------------------------------------- reading

export async function listTeachers(auth, { q, status, classId, subjectId, page = 1, limit = 20 } = {}) {
  const filter = { schoolId: auth.schoolId };
  if (status) filter.employmentStatus = status;
  if (classId) filter.classIds = classId;
  if (subjectId) filter.subjectIds = subjectId;

  // Every word typed must match the name, staff ID or department (so "ada obi" finds Ada Obi).
  const tokens = (q || '').split(' ').filter(Boolean);
  if (tokens.length > 0) {
    filter.$and = tokens.map((token) => {
      const pattern = new RegExp(escapeRegex(token), 'i');
      return { $or: ['firstName', 'middleName', 'lastName', 'teacherId', 'department'].map((f) => ({ [f]: pattern })) };
    });
  }

  const [teachers, total] = await Promise.all([
    Teacher.find(filter)
      .sort({ lastName: 1, firstName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Teacher.countDocuments(filter),
  ]);
  const users = await User.find({ _id: { $in: teachers.map((t) => t.userId) }, schoolId: auth.schoolId });
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return { items: teachers.map((t) => present(t, byId.get(String(t.userId)))), page, limit, total };
}

export async function getTeacher(auth, id) {
  const teacher = await findTeacher(auth, id);
  const [user, classTeacherOf] = await Promise.all([
    User.findOne({ _id: teacher.userId, schoolId: auth.schoolId }),
    Class.distinct('_id', { schoolId: auth.schoolId, classTeacherId: teacher._id }),
  ]);
  return present(teacher, user, { classTeacherOf: classTeacherOf.map(String) });
}

// ---------------------------------------------------------------------- updating

// Applies profile changes to a teacher and their login account together. Nothing is saved
// until BOTH documents validate, so a bad value cannot leave them half-updated. Also used
// by account.service.updateAccount, so the rules live in one place.
const TEACHER_PROFILE_KEYS = ['firstName', 'middleName', 'lastName', 'department', 'title', 'phone'];
const profileSnapshot = (teacher, user) => ({ ...pickFields(teacher, TEACHER_PROFILE_KEYS), email: user?.email ?? null, fullName: user?.fullName ?? null });

export async function applyTeacherChanges(teacher, user, changes, auth) {
  const before = profileSnapshot(teacher, user);
  for (const key of ['firstName', 'middleName', 'lastName', 'department', 'title', 'phone']) {
    if (changes[key] !== undefined) teacher.set(key, changes[key] ?? undefined); // null clears
  }
  if (changes.email !== undefined) {
    if (changes.email === null) {
      throw badRequest('A teacher must keep a registered email: it is where activation and password reset emails go.', {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'email', message: 'cannot be removed' }],
      });
    }
    user.set('email', changes.email);
  }
  user.fullName = joinName(teacher.firstName, teacher.middleName, teacher.lastName);

  await Promise.all([user.validate(), teacher.validate()]);
  // The account service holds the email the teacher's activation / reset mail is sent to: it is
  // updated first, so a failure leaves both sides unchanged.
  await syncContact(user, {
    email: changes.email !== undefined ? user.email : undefined,
    fullName: user.fullName !== before.fullName ? user.fullName : undefined,
  });
  await user.save();
  await teacher.save();

  if (auth) {
    const diff = diffFields(before, profileSnapshot(teacher, user), [...TEACHER_PROFILE_KEYS, 'email']);
    if (diff.changed.length > 0) {
      await recordAudit(auth, {
        action: 'teacher.updated',
        entityType: 'teacher',
        entityId: teacher._id,
        summary: `Teacher profile updated: ${diff.changed.join(', ')}`,
        details: { before: diff.before, after: diff.after },
      });
    }
  }
}

export async function updateTeacher(auth, id, changes) {
  if (Object.keys(changes).length === 0) {
    throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  }
  const teacher = await findTeacher(auth, id);
  const user = await User.findOne({ _id: teacher.userId, schoolId: auth.schoolId });
  if (!user) throw notFound('The login account for this teacher was not found.');
  await applyTeacherChanges(teacher, user, changes, auth);
  return present(teacher, user);
}

// One entry for a change of classes and/or subjects, listing what was added and removed.
export async function auditTeacherAssignments(auth, teacher, before) {
  const after = { classIds: [...teacher.classIds], subjectIds: [...teacher.subjectIds] };
  const diff = diffFields(before, after, ['classIds', 'subjectIds']);
  if (diff.changed.length === 0) return;
  const delta = (key) => {
    const had = new Set(before[key].map(String));
    const has = new Set(after[key].map(String));
    return { added: after[key].filter((id) => !had.has(String(id))), removed: before[key].filter((id) => !has.has(String(id))) };
  };
  await recordAudit(auth, {
    action: 'teacher.assignments_changed',
    entityType: 'teacher',
    entityId: teacher._id,
    summary: `Teacher ${diff.changed.map((k) => (k === 'classIds' ? 'classes' : 'subjects')).join(' and ')} changed`,
    details: {
      ...(diff.changed.includes('classIds') && { classes: delta('classIds') }),
      ...(diff.changed.includes('subjectIds') && { subjects: delta('subjectIds') }),
      before: diff.before,
      after: diff.after,
    },
  });
}

// Replaces the teacher's classes and/or subjects (whichever are sent). Anything left out is
// unchanged. Newly added classes/subjects must be usable; ones already assigned may stay.
export async function setTeacherAssignments(auth, id, { classIds, subjectIds }) {
  if (classIds === undefined && subjectIds === undefined) {
    throw badRequest('Send classIds, subjectIds or both.', { code: 'VALIDATION_ERROR' });
  }
  const teacher = await findTeacher(auth, id);
  await assertTeachingAssignments(auth, { classIds, subjectIds }, teacher);

  const before = { classIds: [...teacher.classIds], subjectIds: [...teacher.subjectIds] };
  if (classIds !== undefined) teacher.classIds = classIds;
  if (subjectIds !== undefined) teacher.subjectIds = subjectIds;
  await teacher.save();
  await auditTeacherAssignments(auth, teacher, before);
  const user = await User.findOne({ _id: teacher.userId, schoolId: auth.schoolId });
  return present(teacher, user);
}

// ------------------------------------------------------------------- employment

// Changes employment status and the login together, so a teacher who resigns, retires or is
// deactivated loses access at once (authenticate() reads the account status on every request,
// so even a token that has not expired stops working). Nothing is deleted.
export async function setTeacherEmploymentStatus(auth, id, employmentStatus) {
  const teacher = await findTeacher(auth, id);
  const user = await User.findOne({ _id: teacher.userId, schoolId: auth.schoolId });
  if (!user) throw notFound('The login account for this teacher was not found.');

  const desired = LOGIN_OPEN.has(employmentStatus) ? 'active' : 'deactivated';
  const nextLogin = desired === 'active' ? 'active' : 'inactive';
  if (teacher.employmentStatus === employmentStatus && user.status === nextLogin) {
    return present(teacher, user); // nothing to change; the original date is kept
  }

  const previous = { status: user.status, employmentStatus: teacher.employmentStatus, at: teacher.employmentStatusChangedAt };
  teacher.employmentStatus = employmentStatus;
  teacher.employmentStatusChangedAt = new Date();
  await teacher.validate();

  // Access follows employment: the account service is changed first (it owns the account status),
  // then the school record. A teacher who never activated their account stays pending_activation.
  const { previous: before } = await changeAccess(auth, user, desired, `employment status: ${employmentStatus}`);
  try {
    await user.save();
    await teacher.save();
  } catch (error) {
    // No transactions on a standalone MongoDB: put the account service and the login back as they were.
    await undoAccess(auth, user, before); // while user.accountStatus still holds the NEW value
    await User.updateOne(
      { _id: user._id, schoolId: auth.schoolId },
      { $set: { status: previous.status, accountStatus: before.accountStatus } }
    );
    throw error;
  }
  await recordAudit(auth, {
    action: 'teacher.employment_status_changed',
    entityType: 'teacher',
    entityId: teacher._id,
    summary: `Employment status changed from ${previous.employmentStatus} to ${employmentStatus}`,
    details: {
      before: { employmentStatus: previous.employmentStatus, loginStatus: previous.status },
      after: { employmentStatus: teacher.employmentStatus, loginStatus: user.status },
    },
  });
  return present(teacher, user);
}

export const deactivateTeacher = (auth, id) => setTeacherEmploymentStatus(auth, id, 'inactive');

// Reactivation is for teachers who were deactivated or on leave. Someone who resigned or
// retired is only brought back by deliberately setting their employment status to active.
export async function reactivateTeacher(auth, id) {
  const teacher = await findTeacher(auth, id);
  if (teacher.employmentStatus === 'resigned' || teacher.employmentStatus === 'retired') {
    throw new AppError(409, `This teacher is ${teacher.employmentStatus}. To re-employ them, set their employment status to active.`, {
      code: 'TEACHER_LEFT_SCHOOL',
    });
  }
  return setTeacherEmploymentStatus(auth, id, 'active');
}
