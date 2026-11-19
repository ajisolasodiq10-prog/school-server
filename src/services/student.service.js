import { AcademicSession, Class, Student, User } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { joinName, toClassView, toStudentView } from '../utils/serializers.js';
import { studentScope } from './access.service.js';
import { getStudentAccess } from './lifecycle.service.js';
import { diffFields, pickFields, recordAudit } from './audit.service.js';
import { syncContact } from './accountAccess.service.js';
import { closeClassEntry, findAssignableClass, placeInClass, reopenLastClass } from './studentClass.service.js';

// Student management. Reads are limited to what the requester's role may see (access.service
// scopes); every write is administrator-only and filters on auth.schoolId, which comes from
// the authenticated user and never from the request.
//
// Students are NEVER deleted. Transfer, graduation and deactivation change status and
// record dates; the login account, class history and results all stay.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const viewFor = (auth) => ({ admin: auth.role === 'admin' });
const sameId = (a, b) => String(a) === String(b);

// ------------------------------------------------------------------------ reading

export async function listStudents(auth, { q, classId, status, needsReview, page = 1, limit = 20 } = {}) {
  const conditions = [await studentScope(auth)];
  if (classId) conditions.push({ currentClassId: classId });
  if (status) conditions.push({ status });
  if (needsReview) conditions.push({ 'reviewFlag.reason': { $exists: true } });

  // Every word typed must match the name or student ID ("ada obi" finds Ada Obi).
  for (const token of (q || '').split(' ').filter(Boolean)) {
    const pattern = new RegExp(escapeRegex(token), 'i');
    conditions.push({ $or: ['firstName', 'middleName', 'lastName', 'studentId'].map((f) => ({ [f]: pattern })) });
  }
  const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };

  const [students, total] = await Promise.all([
    Student.find(filter)
      .sort({ lastName: 1, firstName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Student.countDocuments(filter),
  ]);
  return { items: students.map((s) => toStudentView(s, viewFor(auth))), page, limit, total };
}

async function findInScope(auth, id) {
  const scope = await studentScope(auth);
  const student = await Student.findOne({ $and: [scope, { _id: id }] });
  // Same answer whether the record does not exist, belongs to another school, or is simply
  // not theirs: nothing is revealed about records the user may not see.
  if (!student) throw notFound('Student not found.');
  return student;
}

export async function getStudent(auth, id) {
  return toStudentView(await findInScope(auth, id), viewFor(auth));
}

// What this student may use right now, according to their lifecycle status. The student's
// own profile is always available, whatever the status.
export async function getStudentAccessInfo(auth, id) {
  const student = await findInScope(auth, id);
  return { studentId: String(student._id), ...getStudentAccess(student) };
}

// A student's history: admission, every class they have been in (with the class and session
// names as they were), and how and when they left. Visible to whoever may see the student.
export async function getStudentHistory(auth, id) {
  const student = await findInScope(auth, id);

  const classIds = [...new Set([student.currentClassId, ...student.classHistory.map((e) => e.classId)].filter(Boolean).map(String))];
  const classes = await Class.find({ _id: { $in: classIds }, schoolId: auth.schoolId });
  const sessions = await AcademicSession.find({
    _id: { $in: classes.map((c) => c.academicSessionId) },
    schoolId: auth.schoolId,
  }).select('name');
  const sessionName = new Map(sessions.map((s) => [String(s._id), s.name]));
  const classInfo = new Map(
    classes.map((c) => [
      String(c._id),
      { ...toClassView(c), academicSessionName: sessionName.get(String(c.academicSessionId)) ?? null },
    ])
  );
  const describe = (classId) => {
    const info = classInfo.get(String(classId));
    return info ? { classId: info.id, className: info.displayName, academicSessionId: info.academicSessionId, academicSessionName: info.academicSessionName } : { classId: String(classId), className: null };
  };

  const admin = auth.role === 'admin';
  return {
    student: toStudentView(student, viewFor(auth)),
    admissionDate: student.admissionDate,
    status: student.status,
    leftSchoolAt: student.status === 'graduated' || student.status === 'transferred' ? (student.statusChangedAt ?? null) : null,
    ...(admin && { statusNote: student.statusNote ?? null }),
    currentClass: student.currentClassId ? describe(student.currentClassId) : null,
    classHistory: student.classHistory.map((entry) => ({
      ...describe(entry.classId),
      startedAt: entry.startedAt,
      endedAt: entry.endedAt ?? null,
      reason: entry.reason,
      endedReason: entry.endedReason ?? null,
    })),
  };
}

// --------------------------------------------------------------------- profile updates

// Applies profile changes to a student and, when they have one, their login account. Nothing
// is saved until both validate. Also used by account.service.updateAccount.
const STUDENT_PROFILE_KEYS = ['firstName', 'middleName', 'lastName', 'gender', 'dateOfBirth', 'admissionDate', 'house', 'guardianName', 'guardianPhone', 'guardianEmail', 'address'];
const profileSnapshot = (student, user) => ({ ...pickFields(student, STUDENT_PROFILE_KEYS), email: user?.email ?? null, fullName: user?.fullName ?? null });

// `auth` (the administrator) is given by every caller so the change is written to the audit
// trail with before/after values of the fields that actually changed.
export async function applyStudentChanges(student, user, changes, auth) {
  const before = profileSnapshot(student, user);
  for (const key of STUDENT_PROFILE_KEYS) {
    if (changes[key] !== undefined) student.set(key, changes[key] ?? undefined); // null clears
  }
  if (changes.email !== undefined) {
    if (!user) {
      throw badRequest('This student has no login account, so there is no email to change. Create the account first.', {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'email', message: 'the student has no login account' }],
      });
    }
    user.set('email', changes.email ?? undefined);
  }
  if (user) user.fullName = joinName(student.firstName, student.middleName, student.lastName);

  await Promise.all([student.validate(), user?.validate()]);
  if (user) {
    // The account service keeps the contact email and display name: updated first.
    await syncContact(user, {
      email: changes.email !== undefined ? user.email : undefined,
      fullName: user.fullName !== before.fullName ? user.fullName : undefined,
    });
    await user.save();
  }
  await student.save();

  if (auth) {
    const diff = diffFields(before, profileSnapshot(student, user), [...STUDENT_PROFILE_KEYS, 'email']);
    if (diff.changed.length > 0) {
      await recordAudit(auth, {
        action: 'student.updated',
        entityType: 'student',
        entityId: student._id,
        studentId: student._id,
        summary: `Student profile updated: ${diff.changed.join(', ')}`,
        details: { before: diff.before, after: diff.after },
      });
    }
  }
}

export async function updateStudent(auth, id, changes) {
  if (Object.keys(changes).length === 0) {
    throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  }
  const student = await Student.findOne({ _id: id, schoolId: auth.schoolId });
  if (!student) throw notFound('Student not found.');
  const user = student.userId ? await User.findOne({ _id: student.userId, schoolId: auth.schoolId }) : null;
  await applyStudentChanges(student, user, changes, auth);
  return toStudentView(student, { admin: true });
}

// ------------------------------------------------------------- class assignment

async function findManagedStudent(auth, id) {
  const student = await Student.findOne({ _id: id, schoolId: auth.schoolId });
  if (!student) throw notFound('Student not found.');
  return student;
}

const notActive = (student) =>
  new AppError(409, `This student is ${student.status}. Only active students can be placed in a class; re-enrol them first.`, {
    code: 'STUDENT_NOT_ACTIVE',
  });

// Manual class adjustment by an administrator (for example JSS 2A -> JSS 2B, or placing a
// student whom a session rollover could not place). A reason is required. The previous class
// stays in the student's history, who/when/why is recorded on that history entry and in the
// audit log, and results already recorded are untouched (they keep the class they were
// entered for).
export async function assignStudentToClass(auth, id, { classId, reason }) {
  const student = await findManagedStudent(auth, id);
  if (student.status !== 'active') throw notActive(student);
  const klass = await findAssignableClass(auth, classId);

  if (!sameId(student.currentClassId, klass._id)) {
    const previousClassId = student.currentClassId ?? null;
    const hadClass = Boolean(previousClassId);
    placeInClass(student, klass, hadClass ? 'adjusted' : 'assigned', new Date(), { by: auth.userId, note: reason });
    student.reviewFlag = undefined; // a person has now decided
    await student.save();
    await recordAudit(auth, {
      action: 'student.class_changed',
      entityType: 'student',
      entityId: student._id,
      studentId: student._id,
      summary: `Class changed: ${reason}`,
      details: { fromClassId: previousClassId, toClassId: klass._id, reason, source: 'manual' },
    });
  }
  return toStudentView(student, { admin: true });
}

// Moves several active students to another class in one step (end-of-year promotion).
// Everything is checked first; if any student cannot be promoted nobody is moved.
export async function promoteStudents(auth, { studentIds, classId, reason }) {
  if (studentIds.length === 0) {
    throw badRequest('Choose at least one student to promote.', { code: 'VALIDATION_ERROR' });
  }
  const klass = await findAssignableClass(auth, classId);
  const students = await Student.find({ _id: { $in: studentIds }, schoolId: auth.schoolId });

  const found = new Set(students.map((s) => String(s._id)));
  const missing = studentIds.filter((sid) => !found.has(String(sid)));
  if (missing.length > 0) {
    throw badRequest('One or more students were not found in this school.', {
      code: 'VALIDATION_ERROR',
      details: missing.map((sid) => ({ field: 'studentIds', message: `${sid} is not a student in this school` })),
    });
  }

  const problems = [];
  for (const student of students) {
    if (student.status !== 'active') problems.push({ field: String(student._id), message: `is ${student.status}, not active` });
    else if (!student.currentClassId) problems.push({ field: String(student._id), message: 'has no class to be promoted from; assign a class instead' });
    else if (sameId(student.currentClassId, klass._id)) problems.push({ field: String(student._id), message: 'is already in that class' });
  }
  if (problems.length > 0) {
    throw new AppError(409, 'Some students cannot be promoted, so nobody was moved.', { code: 'PROMOTION_BLOCKED', details: problems });
  }

  const note = reason ?? 'Bulk promotion';
  for (const student of students) {
    const fromClassId = student.currentClassId;
    placeInClass(student, klass, 'promoted', new Date(), { by: auth.userId, note });
    student.reviewFlag = undefined;
    await student.save();
    await recordAudit(auth, {
      action: 'student.class_changed',
      entityType: 'student',
      entityId: student._id,
      studentId: student._id,
      summary: `Promoted: ${note}`,
      details: { fromClassId, toClassId: klass._id, reason: note, source: 'bulk_promotion' },
    });
  }
  return { class: toClassView(klass), promoted: students.map((s) => toStudentView(s, { admin: true })) };
}

// ------------------------------------------------------------------ lifecycle status

const STATUS_ACTION = {
  graduated: 'student.graduated',
  transferred: 'student.transferred',
  inactive: 'student.deactivated',
  active: 'student.reactivated',
  same: 'student.status_updated',
};

// Administrator action: active / inactive / graduated / transferred.
// Nothing is deleted. The login account, the class history and every result stay exactly
// as they were; only what the student may do from now on changes (lifecycle.service.js).
//   - leaving (graduated / transferred) records the effective date (default: now), closes
//     the current class period and keeps currentClassId, so the last class is never lost
//   - results published AFTER that date stay unreachable from the student's account
//   - re-enrolling clears the leaving date and opens the last class again
export async function setStudentStatus(auth, id, { status, effectiveDate, note }) {
  const student = await findManagedStudent(auth, id);

  const leaving = status === 'graduated' || status === 'transferred';
  if (effectiveDate !== undefined) {
    if (!leaving) {
      throw badRequest('effectiveDate only applies to graduated or transferred students.', { code: 'VALIDATION_ERROR' });
    }
    if (effectiveDate > new Date()) {
      throw badRequest('effectiveDate cannot be in the future.', { code: 'VALIDATION_ERROR' });
    }
    if (student.admissionDate && effectiveDate < student.admissionDate) {
      throw badRequest('effectiveDate cannot be before the admission date.', { code: 'VALIDATION_ERROR' });
    }
  }
  if (note !== undefined && status === 'active') {
    throw badRequest('A note only applies when a student leaves or is made inactive.', { code: 'VALIDATION_ERROR' });
  }

  // Sending the same status again changes nothing (so the original leaving date is kept).
  if (student.status === status && effectiveDate === undefined && note === undefined) {
    return toStudentView(student, { admin: true });
  }

  const at = leaving ? (effectiveDate ?? new Date()) : new Date();
  const wasActive = student.status === 'active';
  const before = { status: student.status, statusChangedAt: student.statusChangedAt ?? null, statusNote: student.statusNote ?? null };

  if (status === 'active') {
    reopenLastClass(student, at);
    student.statusChangedAt = undefined;
    student.statusNote = undefined;
  } else {
    if (wasActive) {
      closeClassEntry(student, at, status);
    } else if (leaving) {
      // Changing between transferred and graduated (or correcting the date): the class
      // period that ended when they left is corrected to match.
      const last = [...student.classHistory].reverse().find((e) => e.endedReason === 'transferred' || e.endedReason === 'graduated');
      if (last) {
        last.endedReason = status;
        last.endedAt = last.startedAt > at ? last.startedAt : at;
      }
    }
    student.statusChangedAt = leaving ? at : undefined;
    if (note !== undefined) student.statusNote = note;
  }
  student.status = status;
  await student.save();
  await recordAudit(auth, {
    action: STATUS_ACTION[status === before.status ? 'same' : status],
    entityType: 'student',
    entityId: student._id,
    studentId: student._id,
    summary: status === before.status ? `Student ${status} details updated` : `Student status changed from ${before.status} to ${status}`,
    details: {
      before,
      after: { status: student.status, statusChangedAt: student.statusChangedAt ?? null, statusNote: student.statusNote ?? null },
      ...(note !== undefined && { note }),
    },
  });
  return toStudentView(student, { admin: true });
}
