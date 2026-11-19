import { AcademicSession, Assignment, Class, Student, Subject, Teacher } from '../models/index.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/AppError.js';
import { escapeRegex } from '../utils/search.js';
import { toAssignmentView } from '../utils/serializers.js';
import { registerAcademicRecordCheck } from './academicRecords.service.js';
import { getEnrolledClassIds, getTeacherScope, studentScope } from './access.service.js';
import { recordAudit } from './audit.service.js';
import { assertStudentCapability } from './lifecycle.service.js';
import { notifyUsers, recipientsForClass } from './notification.service.js';

// ASSIGNMENTS
//
//   teacher   creates assignments ONLY for a class and subject they are assigned to (and that
//             belong together), and sees and changes ONLY their own. Status: active, completed
//             or cancelled.
//   admin     sees every assignment in the school, can edit one, and can REMOVE an
//             inappropriate one (hidden from everyone but administrators, with the reason; it
//             can be restored). Nothing is ever deleted.
//   student   sees the assignments of their CURRENT class, from the issue date, while their
//             status allows assignments (transferred, graduated and inactive students get 403).
//   parent    sees the same for their linked, still-active children only.
//
// schoolId always comes from the signed-in user. Anything outside someone's scope is "not found".

registerAcademicRecordCheck(async ({ schoolId, sessionId, termId }) =>
  !termId && (await Assignment.exists({ schoolId, academicSessionId: sessionId })) ? 'assignments' : null
);

const idOf = (value) => String(value);
const startOfToday = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
};
const VISIBLE_TO_FAMILY = ['active', 'completed', 'cancelled'];

async function requireTeacher(auth) {
  const scope = await getTeacherScope(auth);
  if (!scope.teacher) throw forbidden('Your teacher account is not active. Contact your school administrator.', 'TEACHER_NOT_ACTIVE');
  return scope;
}

const assertDates = ({ issueDate, dueDate }, { checkPast }) => {
  const problems = [];
  if (dueDate < issueDate) problems.push({ field: 'dueDate', message: 'The deadline cannot be before the issue date.' });
  if (checkPast && dueDate < startOfToday()) problems.push({ field: 'dueDate', message: 'The deadline cannot be in the past.' });
  if (problems.length) throw badRequest('Invalid dates.', { code: 'VALIDATION_ERROR', details: problems });
};

// Names for the lists (one query per kind, not one per assignment).
async function referencesFor(schoolId, assignments) {
  const ids = (key) => [...new Set(assignments.map((a) => idOf(a[key])))];
  const [subjects, classes, teachers] = await Promise.all([
    Subject.find({ _id: { $in: ids('subjectId') }, schoolId }).select('name code'),
    Class.find({ _id: { $in: ids('classId') }, schoolId }).select('name arm'),
    Teacher.find({ _id: { $in: ids('teacherId') }, schoolId }).select('firstName middleName lastName'),
  ]);
  const byId = (docs) => new Map(docs.map((d) => [idOf(d._id), d]));
  return { subjects: byId(subjects), classes: byId(classes), teachers: byId(teachers) };
}

// ------------------------------------------------------------------- teachers

export async function createAssignment(auth, { classId, subjectId, title, description, issueDate, dueDate }) {
  const scope = await requireTeacher(auth);

  const klass = await Class.findOne({ _id: classId, schoolId: auth.schoolId });
  if (!klass) throw notFound('Class not found.');
  if (!scope.classIds.some((id) => idOf(id) === idOf(klass._id))) {
    throw forbidden('You are not assigned to this class.', 'NOT_ASSIGNED_TO_CLASS');
  }
  const subject = await Subject.findOne({ _id: subjectId, schoolId: auth.schoolId });
  if (!subject) throw notFound('Subject not found.');
  if (!scope.subjectIds.some((id) => idOf(id) === idOf(subject._id))) {
    throw forbidden('You are not assigned to teach this subject.', 'NOT_ASSIGNED_TO_SUBJECT');
  }
  if (!klass.subjectIds.some((id) => idOf(id) === idOf(subject._id))) {
    throw badRequest('This subject is not offered in this class.', { code: 'SUBJECT_NOT_IN_CLASS' });
  }
  if (klass.status !== 'active' || subject.status !== 'active') {
    throw new AppError(409, 'Assignments can only be set for an active class and an active subject.', { code: 'CLASS_OR_SUBJECT_INACTIVE' });
  }
  const session = await AcademicSession.findOne({ _id: klass.academicSessionId, schoolId: auth.schoolId });
  if (!session || session.status === 'closed') {
    throw new AppError(409, "This class's academic session is closed.", { code: 'SESSION_CLOSED' });
  }

  const issued = issueDate ?? new Date();
  assertDates({ issueDate: issued, dueDate }, { checkPast: true });

  const assignment = await Assignment.create({
    schoolId: auth.schoolId,
    classId: klass._id,
    subjectId: subject._id,
    academicSessionId: klass.academicSessionId,
    teacherId: scope.teacher._id,
    createdBy: auth.userId,
    title,
    description,
    issueDate: issued,
    dueDate,
  });
  await recordAudit(auth, {
    action: 'assignment.created',
    entityType: 'assignment',
    entityId: assignment._id,
    summary: `Assignment "${title}" set for ${klass.name}${klass.arm} (${subject.name})`,
    details: { classId: klass._id, subjectId: subject._id, issueDate: issued, dueDate },
  });

  // Students and parents are told when it opens (now, or on the issue date).
  await notifyUsers(auth.schoolId, await recipientsForClass(auth.schoolId, klass._id), {
    type: 'assignment.created',
    title: `New ${subject.name} assignment`,
    message: title,
    entityType: 'assignment',
    entityId: assignment._id,
    availableAt: issued > new Date() ? issued : new Date(),
  });
  return toAssignmentView(assignment, await referencesFor(auth.schoolId, [assignment]));
}

// A teacher's own assignment, or administrators' any. Removed ones can only be touched by
// administrators.
async function findManageable(auth, id) {
  const filter = { _id: id, schoolId: auth.schoolId };
  if (auth.role === 'teacher') Object.assign(filter, { createdBy: auth.userId, status: { $ne: 'removed' } });
  const assignment = await Assignment.findOne(filter);
  if (!assignment) throw notFound('Assignment not found.');
  return assignment;
}

export async function updateAssignment(auth, id, changes) {
  if (Object.keys(changes).length === 0) throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  const assignment = await findManageable(auth, id);
  if (assignment.status === 'removed') {
    throw new AppError(409, 'This assignment was removed by an administrator.', { code: 'ASSIGNMENT_REMOVED' });
  }
  if (auth.role === 'teacher') {
    // Still allowed to teach it? (A teacher moved off a class cannot keep changing its work.)
    const scope = await requireTeacher(auth);
    const stillAssigned =
      scope.classIds.some((c) => idOf(c) === idOf(assignment.classId)) &&
      scope.subjectIds.some((s) => idOf(s) === idOf(assignment.subjectId));
    if (!stillAssigned) throw forbidden('You are no longer assigned to this class and subject.', 'NOT_ASSIGNED_TO_CLASS');
  }

  const before = { status: assignment.status, dueDate: assignment.dueDate };
  const issueDate = changes.issueDate ?? assignment.issueDate;
  const dueDate = changes.dueDate ?? assignment.dueDate;
  assertDates({ issueDate, dueDate }, { checkPast: changes.dueDate !== undefined });

  for (const key of ['title', 'description', 'issueDate', 'dueDate']) if (changes[key] !== undefined) assignment.set(key, changes[key]);
  if (changes.status !== undefined && changes.status !== assignment.status) {
    assignment.status = changes.status;
    assignment.statusChangedAt = new Date();
  }
  assignment.updatedBy = auth.userId;
  await assignment.save();

  await recordAudit(auth, {
    action: changes.status !== undefined && changes.status !== before.status ? 'assignment.status_changed' : 'assignment.updated',
    entityType: 'assignment',
    entityId: assignment._id,
    summary: `Assignment "${assignment.title}" updated`,
    details: { fields: Object.keys(changes), from: before, to: { status: assignment.status, dueDate: assignment.dueDate } },
  });
  return toAssignmentView(assignment, await referencesFor(auth.schoolId, [assignment]), { admin: auth.role === 'admin' });
}

// A teacher deleting their own assignment: it is hidden from students and from the teacher's list
// (the record stays, and an administrator can restore it).
export async function deleteOwnAssignment(auth, id) {
  const assignment = await findManageable(auth, id);
  if (auth.role !== 'teacher') throw forbidden('Only the teacher who set an assignment can delete it.', 'FORBIDDEN');
  assignment.statusBeforeRemoval = assignment.status;
  assignment.status = 'removed';
  assignment.statusChangedAt = new Date();
  assignment.removedBy = auth.userId;
  assignment.removedAt = new Date();
  assignment.removalReason = 'Deleted by the teacher';
  await assignment.save();
  await recordAudit(auth, {
    action: 'assignment.deleted_by_teacher',
    entityType: 'assignment',
    entityId: assignment._id,
    summary: `Assignment "${assignment.title}" deleted by its teacher`,
  });
  return { removed: true };
}

// ------------------------------------------------------------------ administrators

export async function removeAssignment(auth, id, { reason }) {
  const assignment = await Assignment.findOne({ _id: id, schoolId: auth.schoolId });
  if (!assignment) throw notFound('Assignment not found.');
  if (assignment.status === 'removed') throw new AppError(409, 'This assignment is already removed.', { code: 'ASSIGNMENT_REMOVED' });
  assignment.statusBeforeRemoval = assignment.status;
  assignment.status = 'removed';
  assignment.statusChangedAt = new Date();
  assignment.removedBy = auth.userId;
  assignment.removedAt = new Date();
  assignment.removalReason = reason;
  await assignment.save();
  await recordAudit(auth, {
    action: 'assignment.removed',
    entityType: 'assignment',
    entityId: assignment._id,
    summary: `Assignment "${assignment.title}" removed`,
    details: { reason },
  });
  return toAssignmentView(assignment, await referencesFor(auth.schoolId, [assignment]), { admin: true });
}

export async function restoreAssignment(auth, id) {
  const assignment = await Assignment.findOne({ _id: id, schoolId: auth.schoolId });
  if (!assignment) throw notFound('Assignment not found.');
  if (assignment.status !== 'removed') throw new AppError(409, 'This assignment is not removed.', { code: 'ASSIGNMENT_NOT_REMOVED' });
  assignment.status = assignment.statusBeforeRemoval ?? 'active';
  assignment.statusChangedAt = new Date();
  assignment.updatedBy = auth.userId;
  await assignment.save();
  await recordAudit(auth, {
    action: 'assignment.restored',
    entityType: 'assignment',
    entityId: assignment._id,
    summary: `Assignment "${assignment.title}" restored`,
  });
  return toAssignmentView(assignment, await referencesFor(auth.schoolId, [assignment]), { admin: true });
}

// -------------------------------------------------------------------- reading

// Students and parents: the current, ACTIVE classes of the students they may act for.
async function familyClasses(auth, studentId) {
  const students = await Student.find({ ...(await studentScope(auth)), ...(studentId && { _id: studentId }) }).select('currentClassId status');
  const active = students.filter((s) => s.status === 'active' && s.currentClassId);
  return { students: active, classIds: active.map((s) => s.currentClassId) };
}

export async function listAssignments(auth, { classId, subjectId, studentId, status, q, page = 1, limit = 20 } = {}) {
  const filter = { schoolId: auth.schoolId };
  let family = null;

  if (auth.role === 'admin') {
    if (classId) filter.classId = classId;
  } else if (auth.role === 'teacher') {
    await requireTeacher(auth);
    filter.createdBy = auth.userId;
    filter.status = { $ne: 'removed' }; // removed by an administrator: gone from the working list
    if (classId) filter.classId = classId;
  } else {
    family = await familyClasses(auth, studentId);
    const allowed = family.classIds.map(idOf).filter((c) => !classId || c === classId);
    filter.classId = { $in: allowed };
    filter.status = { $in: VISIBLE_TO_FAMILY };
    filter.issueDate = { $lte: new Date() }; // not before the issue date
  }
  if (subjectId) filter.subjectId = subjectId;
  if (status) {
    if ((family || auth.role === 'teacher') && !VISIBLE_TO_FAMILY.includes(status)) filter.classId = { $in: [] };
    else filter.status = status;
  }
  if (q) filter.title = new RegExp(escapeRegex(q), 'i');

  const [items, total] = await Promise.all([
    Assignment.find(filter).sort({ issueDate: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Assignment.countDocuments(filter),
  ]);
  const refs = await referencesFor(auth.schoolId, items);
  const view = (a) => {
    const forStudentIds = family && auth.role === 'parent'
      ? family.students.filter((s) => idOf(s.currentClassId) === idOf(a.classId)).map((s) => idOf(s._id))
      : undefined;
    return toAssignmentView(a, refs, { admin: auth.role === 'admin', forStudentIds });
  };
  return { items: items.map(view), page, limit, total };
}

export async function getAssignment(auth, id) {
  const filter = { _id: id, schoolId: auth.schoolId };
  if (auth.role === 'teacher') {
    await requireTeacher(auth);
    Object.assign(filter, { createdBy: auth.userId, status: { $ne: 'removed' } });
  } else if (auth.role !== 'admin') {
    const { classIds } = await familyClasses(auth);
    filter.classId = { $in: classIds };
    filter.status = { $in: VISIBLE_TO_FAMILY };
    filter.issueDate = { $lte: new Date() };
  }
  const assignment = await Assignment.findOne(filter);
  if (!assignment) throw notFound('Assignment not found.');
  return toAssignmentView(assignment, await referencesFor(auth.schoolId, [assignment]), { admin: auth.role === 'admin' });
}

// For the route layer: the student's own status decides first (403 for students who left).
export async function assertStudentMayUseAssignments(auth) {
  if (auth.role !== 'student') return;
  const student = await Student.findOne(await studentScope(auth));
  if (!student) throw forbidden('No student record is linked to this account.', 'NO_STUDENT_RECORD');
  assertStudentCapability(student, 'assignments');
}

export { getEnrolledClassIds };
