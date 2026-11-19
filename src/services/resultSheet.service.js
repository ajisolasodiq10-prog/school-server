import { AcademicSession, Class, ResultAccess, ResultSheet, Student, Subject, Teacher, User } from '../models/index.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/AppError.js';
import { toSheetView } from '../utils/serializers.js';
import { scoreLimits } from './settings.service.js';
import { registerAcademicRecordCheck } from './academicRecords.service.js';
import { getTeacherScope, studentScope } from './access.service.js';
import { recordAudit } from './audit.service.js';
import { canViewPublishedResult } from './lifecycle.service.js';
import { notifyUsers, recipientsForStudent } from './notification.service.js';

// RESULT SHEETS: the per-subject workflow the teacher and admin dashboards use.
//
//   teacher         enters the CA and exam scores of a class for the subject they teach in it,
//                   saves drafts and submits (only for classes and subjects assigned to them)
//   administrator   approves, returns (with a reason) or publishes a submitted sheet
//   student/parent  see PUBLISHED sheets only, for terms unlocked with a result PIN
//
// A sheet is never deleted. Every step writes an audit entry.

registerAcademicRecordCheck(async ({ schoolId, sessionId, termId }) =>
  (await ResultSheet.exists({ schoolId, academicSessionId: sessionId, ...(termId && { termId }) })) ? 'results' : null
);

const idOf = (value) => String(value);
const EDITABLE = new Set(['draft', 'returned']);
const invalidStep = (message) => new AppError(409, message, { code: 'INVALID_RESULT_TRANSITION' });

async function save(sheet) {
  try {
    await sheet.save();
  } catch (error) {
    if (error?.name === 'VersionError' || error?.code === 11000) {
      throw new AppError(409, 'This result sheet was changed by someone else at the same time. Reload it and try again.', { code: 'CONFLICT' });
    }
    throw error;
  }
}

const audit = (auth, sheet, action, summary, details = {}) =>
  recordAudit(auth, {
    action,
    entityType: 'result_sheet',
    entityId: sheet._id,
    summary,
    details: { classId: sheet.classId, subjectId: sheet.subjectId, academicSessionId: sheet.academicSessionId, termId: sheet.termId, ...details },
  });

const nameOfUser = async (auth) => (await User.findOne({ _id: auth.userId, schoolId: auth.schoolId }).select('fullName'))?.fullName || 'Administrator';

async function requireTeacher(auth) {
  const scope = await getTeacherScope(auth);
  if (!scope.teacher) throw forbidden('Your teacher account is not active. Contact your school administrator.', 'TEACHER_NOT_ACTIVE');
  return scope;
}

// Does this teacher teach this subject in this class? The exact pairing set on the class wins;
// a class with no pairing for the subject falls back to the teacher's own classes and subjects.
function teaches(klass, teacher, subjectId) {
  const pair = (klass.subjectTeachers || []).find((st) => idOf(st.subjectId) === idOf(subjectId));
  if (pair) return idOf(pair.teacherId) === idOf(teacher._id);
  return teacher.classIds.some((c) => idOf(c) === idOf(klass._id)) && teacher.subjectIds.some((s) => idOf(s) === idOf(subjectId));
}

async function findSheet(auth, id) {
  const sheet = await ResultSheet.findOne({ _id: id, schoolId: auth.schoolId });
  if (!sheet) throw notFound('Result sheet not found.');
  if (auth.role === 'teacher') {
    const scope = await requireTeacher(auth);
    if (!scope.classIds.some((c) => idOf(c) === idOf(sheet.classId))) throw notFound('Result sheet not found.');
  }
  return sheet;
}

// ------------------------------------------------------------------ teacher: save and submit

export async function saveSheet(auth, { classId, subjectId, academicSessionId, termId, scores }) {
  const scope = await requireTeacher(auth);
  const [klass, subject, session] = await Promise.all([
    Class.findOne({ _id: classId, schoolId: auth.schoolId }),
    Subject.findOne({ _id: subjectId, schoolId: auth.schoolId }),
    AcademicSession.findOne({ _id: academicSessionId, schoolId: auth.schoolId }),
  ]);
  if (!klass) throw notFound('Class not found.');
  if (!subject) throw notFound('Subject not found.');
  if (!session) throw notFound('Academic session not found.');
  const term = session.terms.id(termId);
  if (!term) throw notFound('Term not found.');
  if (!teaches(klass, scope.teacher, subjectId)) throw forbidden('You are not assigned to teach this subject in this class.', 'NOT_ASSIGNED');
  if (idOf(klass.academicSessionId) !== idOf(session._id)) {
    throw badRequest('That class does not belong to this academic session.', { code: 'VALIDATION_ERROR' });
  }
  if (session.status === 'closed') throw new AppError(409, 'That academic session is closed.', { code: 'SESSION_CLOSED' });
  if (term.status !== 'open') throw new AppError(409, 'Results can only be entered while the term is open.', { code: 'TERM_NOT_OPEN' });

  const students = await Student.find({ schoolId: auth.schoolId, currentClassId: klass._id }).select('_id');
  const inClass = new Set(students.map((s) => idOf(s._id)));
  const seen = new Set();
  const problems = [];
  for (const row of scores) {
    if (!inClass.has(row.studentId)) problems.push({ field: 'scores', message: `${row.studentId} is not a student of this class` });
    if (seen.has(row.studentId)) problems.push({ field: 'scores', message: `${row.studentId} appears twice` });
    seen.add(row.studentId);
  }
  if (problems.length > 0) throw badRequest('Some students cannot be used on this sheet.', { code: 'VALIDATION_ERROR', details: problems });

  // The score maximums are the school's settings (CA and exam).
  const { caMax, examMax } = await scoreLimits(auth.schoolId);
  const over = [];
  for (const row of scores) {
    if (row.ca != null && row.ca > caMax) over.push({ field: 'scores', message: `CA cannot be more than ${caMax}` });
    if (row.exam != null && row.exam > examMax) over.push({ field: 'scores', message: `exam cannot be more than ${examMax}` });
  }
  if (over.length > 0) throw badRequest('Some scores are above the maximum.', { code: 'VALIDATION_ERROR', details: over.slice(0, 5) });

  const key = { schoolId: auth.schoolId, classId: klass._id, subjectId: subject._id, academicSessionId: session._id, termId: term._id };
  const clean = scores.map((row) => ({ studentId: row.studentId, ...(row.ca != null && { ca: row.ca }), ...(row.exam != null && { exam: row.exam }) }));

  let sheet = await ResultSheet.findOne(key);
  if (!sheet) {
    sheet = new ResultSheet({ ...key, teacherId: scope.teacher._id, teacherUserId: auth.userId, status: 'draft', scores: clean });
    await save(sheet);
    await audit(auth, sheet, 'result_sheet.created', 'Result sheet draft created');
    return { sheet: toSheetView(sheet) };
  }
  if (!EDITABLE.has(sheet.status)) {
    throw new AppError(409, `This result sheet is ${sheet.status} and can no longer be edited here.`, { code: 'RESULT_NOT_EDITABLE' });
  }
  sheet.teacherId = scope.teacher._id;
  sheet.teacherUserId = auth.userId;
  sheet.scores = clean;
  await save(sheet);
  return { sheet: toSheetView(sheet) };
}

export async function submitSheet(auth, id) {
  const scope = await requireTeacher(auth);
  const sheet = await findSheet(auth, id);
  if (!EDITABLE.has(sheet.status)) throw invalidStep(`Only a draft or returned sheet can be submitted; this one is ${sheet.status}.`);
  const klass = await Class.findOne({ _id: sheet.classId, schoolId: auth.schoolId });
  if (!klass || !teaches(klass, scope.teacher, sheet.subjectId)) throw forbidden('You are not assigned to teach this subject in this class.', 'NOT_ASSIGNED');

  const students = await Student.find({ schoolId: auth.schoolId, currentClassId: sheet.classId, status: 'active' }).select('_id');
  const byStudent = new Map(sheet.scores.map((x) => [idOf(x.studentId), x]));
  const missing = students.filter((s) => {
    const row = byStudent.get(idOf(s._id));
    return !row || row.ca == null || row.exam == null;
  });
  if (students.length === 0) throw badRequest('This class has no active students.', { code: 'VALIDATION_ERROR' });
  if (missing.length > 0) {
    throw badRequest(`Enter the CA and exam score for every student before submitting (${missing.length} missing).`, { code: 'VALIDATION_ERROR' });
  }
  sheet.status = 'submitted';
  sheet.submittedAt = new Date();
  sheet.feedback = undefined;
  await save(sheet);
  await audit(auth, sheet, 'result_sheet.submitted', 'Result sheet submitted for review');
  return { sheet: toSheetView(sheet) };
}

// ------------------------------------------------------------------ administrator: review

export async function approveSheet(auth, id) {
  const sheet = await findSheet(auth, id);
  if (sheet.status !== 'submitted') throw invalidStep(`Only a submitted sheet can be approved; this one is ${sheet.status}.`);
  sheet.status = 'approved';
  sheet.reviewedAt = new Date();
  sheet.reviewedBy = auth.userId;
  sheet.reviewedByName = await nameOfUser(auth);
  sheet.feedback = undefined;
  await save(sheet);
  await audit(auth, sheet, 'result_sheet.approved', 'Result sheet approved');
  return { sheet: toSheetView(sheet) };
}

export async function returnSheet(auth, id, { reason }) {
  const sheet = await findSheet(auth, id);
  if (sheet.status !== 'submitted') throw invalidStep(`Only a submitted sheet can be returned; this one is ${sheet.status}.`);
  const name = await nameOfUser(auth);
  sheet.status = 'returned';
  sheet.reviewedAt = new Date();
  sheet.reviewedBy = auth.userId;
  sheet.reviewedByName = name;
  sheet.feedback = { message: reason, at: new Date(), byName: name };
  await save(sheet);
  await audit(auth, sheet, 'result_sheet.returned', 'Result sheet returned to the teacher', { reason });
  return { sheet: toSheetView(sheet) };
}

export async function publishSheet(auth, id) {
  const sheet = await findSheet(auth, id);
  if (sheet.status !== 'approved') throw invalidStep(`Only an approved sheet can be published; this one is ${sheet.status}.`);
  sheet.status = 'published';
  sheet.publishedAt = new Date();
  sheet.publishedBy = auth.userId;
  sheet.publishedByName = await nameOfUser(auth);
  await save(sheet);
  await audit(auth, sheet, 'result_sheet.published', 'Result sheet published');
  // An in-app alert for each student and their linked parents. It never carries scores and
  // never stops the publication.
  try {
    for (const row of sheet.scores) {
      await notifyUsers(auth.schoolId, await recipientsForStudent(auth.schoolId, row.studentId), {
        type: 'result.published',
        title: 'Results published',
        message: 'Open the results page. If this term is not unlocked yet, enter the result PIN.',
        entityType: 'result_sheet',
        entityId: sheet._id,
      });
    }
  } catch (error) {
    console.error('Could not create result notifications:', error.message);
  }
  return { sheet: toSheetView(sheet) };
}

// ------------------------------------------------------------------ staff: reading

export async function listSheets(auth, { academicSessionId, termId, classId, subjectId, status, page = 1, limit = 20 } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(academicSessionId && { academicSessionId }),
    ...(termId && { termId }),
    ...(subjectId && { subjectId }),
    ...(status && { status }),
  };
  if (auth.role === 'teacher') {
    const scope = await requireTeacher(auth);
    filter.classId = { $in: scope.classIds.filter((c) => !classId || idOf(c) === classId) };
  } else if (classId) {
    filter.classId = classId;
  }
  const [items, total] = await Promise.all([
    ResultSheet.find(filter).sort({ updatedAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit),
    ResultSheet.countDocuments(filter),
  ]);
  return { items: items.map(toSheetView), page, limit, total };
}

export async function getSheet(auth, id) {
  return { sheet: toSheetView(await findSheet(auth, id)) };
}

// ------------------------------------------------------------------ student / parent: reading

async function familyStudents(auth, studentId) {
  const students = await Student.find({ ...(await studentScope(auth)), ...(studentId && { _id: studentId }) });
  if (studentId && students.length === 0) throw notFound('Student not found.');
  return students;
}

const accessKey = (studentId, sessionId, termId) => `${idOf(studentId)}|${idOf(sessionId)}|${idOf(termId)}`;

// The terms that have published results for the student (or the parent's children), and whether
// each is unlocked yet. A term with no published sheet is not listed at all.
export async function listPublishedTerms(auth, { studentId } = {}) {
  const students = await familyStudents(auth, studentId);
  if (students.length === 0) return { items: [] };
  const byId = new Map(students.map((s) => [idOf(s._id), s]));
  const ids = students.map((s) => s._id);

  const [sheets, access] = await Promise.all([
    ResultSheet.find({ schoolId: auth.schoolId, status: 'published', 'scores.studentId': { $in: ids } }),
    ResultAccess.find({ schoolId: auth.schoolId, studentId: { $in: ids } }),
  ]);
  const unlocked = new Set(access.map((a) => accessKey(a.studentId, a.academicSessionId, a.termId)));

  const groups = new Map();
  for (const sheet of sheets) {
    for (const row of sheet.scores) {
      const student = byId.get(idOf(row.studentId));
      if (!student || !canViewPublishedResult(student, sheet.publishedAt)) continue;
      const key = accessKey(student._id, sheet.academicSessionId, sheet.termId);
      if (!groups.has(key)) groups.set(key, { studentId: idOf(student._id), academicSessionId: idOf(sheet.academicSessionId), termId: idOf(sheet.termId), classId: idOf(sheet.classId), unlocked: unlocked.has(key) });
    }
  }
  const items = [...groups.values()];
  if (items.length === 0) return { items: [] };

  const [sessions, classes] = await Promise.all([
    AcademicSession.find({ _id: { $in: [...new Set(items.map((i) => i.academicSessionId))] }, schoolId: auth.schoolId }),
    Class.find({ _id: { $in: [...new Set(items.map((i) => i.classId))] }, schoolId: auth.schoolId }),
  ]);
  const sessionById = new Map(sessions.map((s) => [idOf(s._id), s]));
  const classById = new Map(classes.map((c) => [idOf(c._id), c]));
  const out = items.map((i) => {
    const session = sessionById.get(i.academicSessionId);
    const term = session?.terms.id(i.termId);
    const klass = classById.get(i.classId);
    return {
      ...i,
      sessionName: session?.name ?? '',
      termName: term?.name ?? '',
      termStart: term?.startDate ?? null,
      current: Boolean(term?.isCurrent),
      className: klass ? `${klass.name}${klass.arm}` : '',
    };
  });
  out.sort((a, b) => new Date(b.termStart || 0) - new Date(a.termStart || 0));
  return { items: out };
}

// The published scores of one student for one term. Locked terms answer 403 RESULT_LOCKED.
export async function getPublishedTerm(auth, { studentId, academicSessionId, termId }) {
  const students = await familyStudents(auth, studentId);
  const student = studentId ? students[0] : students.length === 1 ? students[0] : null;
  if (!student) throw badRequest('Choose which student to show.', { code: 'VALIDATION_ERROR' });

  const open = await ResultAccess.exists({ schoolId: auth.schoolId, studentId: student._id, academicSessionId, termId });
  if (!open) throw forbidden('These results are locked. Enter the result PIN for this term to unlock them.', 'RESULT_LOCKED');

  const sheets = await ResultSheet.find({ schoolId: auth.schoolId, status: 'published', academicSessionId, termId, 'scores.studentId': student._id });
  const visible = sheets.filter((s) => canViewPublishedResult(student, s.publishedAt));
  if (visible.length === 0) throw notFound('No published results were found for this term.');

  const [subjects, session, klass] = await Promise.all([
    Subject.find({ _id: { $in: visible.map((s) => s.subjectId) }, schoolId: auth.schoolId }).select('name'),
    AcademicSession.findOne({ _id: academicSessionId, schoolId: auth.schoolId }),
    Class.findOne({ _id: visible[0].classId, schoolId: auth.schoolId }),
  ]);
  const subjectName = new Map(subjects.map((s) => [idOf(s._id), s.name]));
  const rows = visible
    .map((sheet) => {
      const mine = sheet.scores.find((x) => idOf(x.studentId) === idOf(student._id));
      const totals = sheet.scores.filter((x) => x.ca != null && x.exam != null).map((x) => x.ca + x.exam);
      return {
        subjectId: idOf(sheet.subjectId),
        subject: subjectName.get(idOf(sheet.subjectId)) || 'Subject',
        ca: mine.ca ?? null,
        exam: mine.exam ?? null,
        classAverage: totals.length ? Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100 : null,
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));
  return {
    studentId: idOf(student._id),
    sessionName: session?.name ?? '',
    termName: session?.terms.id(termId)?.name ?? '',
    className: klass ? `${klass.name}${klass.arm}` : '',
    subjects: rows,
  };
}
