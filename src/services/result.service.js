import { AcademicSession, Result, ResultAccess, Student } from '../models/index.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/AppError.js';
import { toResultPublishedView, toResultStaffView } from '../utils/serializers.js';
import { registerAcademicRecordCheck } from './academicRecords.service.js';
import { getTeacherScope, studentScope } from './access.service.js';
import { recordAudit } from './audit.service.js';
import { classForSession } from './enrolment.service.js';
import { canViewPublishedResult } from './lifecycle.service.js';
import { notifyUsers, recipientsForStudent } from './notification.service.js';
import { recommendPromotion } from './promotion.service.js';
import { accessKey } from './resultPin.service.js';

// RESULT WORKFLOW FOUNDATION (not the full result management module).
//
//   Draft --submit--> Submitted --approve--> Approved --publish--> Published
//     ^                  |  |                                         |
//     +------ return ----+--+ (administrator)                       recall (administrator, with reason)
//                                                                      v
//   a teacher starts a CORRECTION: a NEW version (draft) --> submit --> approve --> publish
//
//   teacher         enters drafts, submits, starts corrections - only for classes they teach
//   administrator   returns, approves, publishes, recalls. Never the author of a result.
//   student/parent  read the PUBLISHED version only (see lifecycle.service for students who left),
//                   and only for terms they have unlocked with a result PIN (ResultAccess, see
//                   resultPin.service). The unlock belongs to student + session + term, so it
//                   outlives logins, covers a corrected republication, and never makes a
//                   recalled result visible: the published version is what is checked first.
//
// A version's figures can only change while it is a draft. Publishing, recalling and
// correcting never overwrite anything: a correction is a new version, and the version that
// was recalled stays on record exactly as it was published. Each step is audited.

registerAcademicRecordCheck(async ({ schoolId, sessionId, termId }) =>
  (await Result.exists({ schoolId, academicSessionId: sessionId, ...(termId && { termId }) })) ? 'results' : null
);

const idOf = (value) => String(value);
const latest = (result) => result.versions.find((v) => v.number === result.currentVersion);

const invalidStep = (message) => new AppError(409, message, { code: 'INVALID_RESULT_TRANSITION' });

async function save(result) {
  try {
    await result.save();
  } catch (error) {
    if (error?.name === 'VersionError' || error?.code === 11000) {
      throw new AppError(409, 'This result was changed by someone else at the same time. Reload it and try again.', { code: 'CONFLICT' });
    }
    throw error;
  }
}

async function requireTeacher(auth) {
  const scope = await getTeacherScope(auth);
  if (!scope.teacher) throw forbidden('Your teacher account is not active. Contact your school administrator.', 'TEACHER_NOT_ACTIVE');
  return scope;
}

const inClasses = (scope, classId) => scope.classIds.some((id) => idOf(id) === idOf(classId));

// A result a teacher may work on: it must belong to one of their classes. Anything else is
// answered "not found", so other classes' results are never revealed.
async function findForTeacher(auth, id) {
  const scope = await requireTeacher(auth);
  const result = await Result.findOne({ _id: id, schoolId: auth.schoolId, classId: { $in: scope.classIds } });
  if (!result) throw notFound('Result not found.');
  return result;
}

async function findForAdmin(auth, id) {
  const result = await Result.findOne({ _id: id, schoolId: auth.schoolId });
  if (!result) throw notFound('Result not found.');
  return result;
}

const audit = (auth, result, action, summary, details) =>
  recordAudit(auth, {
    action,
    entityType: 'result',
    entityId: result._id,
    studentId: result.studentId,
    summary,
    details: { academicSessionId: result.academicSessionId, termId: result.termId, classId: result.classId, ...details },
  });

// ------------------------------------------------------------------ teacher: drafts

export async function saveDraft(auth, { studentId, academicSessionId, termId, entries, remarks, promotionRecommendation }) {
  const scope = await requireTeacher(auth);
  const student = await Student.findOne({ _id: studentId, schoolId: auth.schoolId });
  if (!student) throw notFound('Student not found.');
  const session = await AcademicSession.findOne({ _id: academicSessionId, schoolId: auth.schoolId });
  if (!session) throw notFound('Academic session not found.');
  const term = session.terms.id(termId);
  if (!term) throw notFound('Term not found.');

  const key = { schoolId: auth.schoolId, studentId: student._id, academicSessionId: session._id, termId: term._id };
  let result = await Result.findOne(key);

  // A correction of an already published result may be finished after the term or session has
  // closed, or after the student has left; ordinary new drafts may not.
  const existingVersion = result ? latest(result) : null;
  const isCorrection = Boolean(existingVersion && existingVersion.status === 'draft' && existingVersion.correctionOf != null);

  if (!isCorrection) {
    if (session.status === 'closed') {
      throw new AppError(409, 'That academic session is closed. Published results of a closed session can only be corrected after a recall.', { code: 'SESSION_CLOSED' });
    }
    if (term.status !== 'open') {
      throw new AppError(409, 'Results can only be entered while the term is open.', { code: 'TERM_NOT_OPEN' });
    }
  }
  const klass = await classForSession(auth.schoolId, student, session._id);
  if (!klass) throw new AppError(409, 'This student is not enrolled in a class for that session.', { code: 'STUDENT_NOT_ENROLLED' });
  if (!inClasses(scope, klass._id)) throw notFound('Student not found.');
  if (student.status !== 'active' && !isCorrection) {
    throw new AppError(409, `This student is ${student.status}; new results cannot be entered.`, { code: 'STUDENT_NOT_ACTIVE' });
  }

  const offered = new Set(klass.subjectIds.map(idOf));
  const seen = new Set();
  const problems = [];
  for (const entry of entries) {
    if (seen.has(entry.subjectId)) problems.push({ field: 'entries', message: `${entry.subjectId} appears twice` });
    seen.add(entry.subjectId);
    if (!offered.has(entry.subjectId)) problems.push({ field: 'entries', message: `${entry.subjectId} is not a subject of ${klass.name}${klass.arm}` });
  }
  if (problems.length > 0) throw badRequest('Some subjects cannot be used for this student.', { code: 'VALIDATION_ERROR', details: problems });
  if (promotionRecommendation !== undefined && term.name !== 'Third Term') {
    throw badRequest('A promotion recommendation can only be given with Third Term results.', { code: 'VALIDATION_ERROR' });
  }

  // The recommendation goes first: if it is refused (already confirmed) nothing is saved.
  if (promotionRecommendation !== undefined) {
    await recommendPromotion(auth, { studentId, academicSessionId, recommendation: promotionRecommendation });
  }

  const now = new Date();

  if (!result) {
    result = new Result({
      ...key,
      classId: klass._id,
      status: 'draft',
      currentVersion: 1,
      publishedVersion: null,
      versions: [{ number: 1, status: 'draft', entries, ...(remarks && { remarks }), createdBy: auth.userId, createdAt: now }],
    });
    await save(result);
    await audit(auth, result, 'result.created', 'Result draft created', { version: 1 });
    return toResultStaffView(result);
  }

  const version = latest(result);
  if (version.status !== 'draft') {
    const hint = {
      published: 'It is published. An administrator must recall it before it can be corrected.',
      recalled: 'It was recalled. Start a correction to enter the corrected figures.',
      submitted: 'It is waiting for approval. An administrator must return it to draft to change it.',
      approved: 'It is approved. An administrator must return it to draft to change it.',
    }[version.status];
    throw new AppError(409, `This result cannot be edited. ${hint}`, { code: 'RESULT_NOT_EDITABLE' });
  }
  if (idOf(version.createdBy) !== idOf(auth.userId)) {
    throw forbidden("This draft belongs to another teacher.", 'DRAFT_OWNED_BY_OTHER');
  }
  version.entries = entries;
  if (remarks !== undefined) version.remarks = remarks ?? undefined;
  await save(result);
  return toResultStaffView(result);
}

export async function submitResult(auth, id) {
  const result = await findForTeacher(auth, id);
  const version = latest(result);
  if (version.status !== 'draft') throw invalidStep(`Only a draft can be submitted; this version is ${version.status}.`);
  if (idOf(version.createdBy) !== idOf(auth.userId)) throw forbidden('Only the teacher who wrote this draft can submit it.', 'DRAFT_OWNED_BY_OTHER');
  if (version.entries.length === 0) throw badRequest('Add at least one subject score before submitting.', { code: 'VALIDATION_ERROR' });

  version.status = 'submitted';
  version.submittedBy = auth.userId;
  version.submittedAt = new Date();
  result.status = 'submitted';
  await save(result);
  await audit(auth, result, 'result.submitted', `Version ${version.number} submitted`, { version: version.number });
  return toResultStaffView(result);
}

// A teacher of the class starts the corrected version of a RECALLED result. The recalled
// version is left exactly as it was; the correction is a new draft that starts as a copy.
export async function startCorrection(auth, id) {
  const result = await findForTeacher(auth, id);
  const version = latest(result);
  if (result.status !== 'recalled') throw invalidStep('Only a recalled result can be corrected.');

  result.versions.push({
    number: version.number + 1,
    status: 'draft',
    entries: version.entries.map((e) => ({ subjectId: e.subjectId, score: e.score })),
    ...(version.remarks && { remarks: version.remarks }),
    correctionOf: version.number,
    createdBy: auth.userId,
    createdAt: new Date(),
  });
  result.currentVersion = version.number + 1;
  result.status = 'draft';
  await save(result);
  await audit(auth, result, 'result.correction_started', `Correction of version ${version.number} started`, {
    fromVersion: version.number,
    newVersion: version.number + 1,
    recallReason: version.recallReason ?? null,
  });
  return toResultStaffView(result);
}

// ----------------------------------------------------------- administrator: review

function assertNotOwn(auth, version) {
  if ([version.createdBy, version.submittedBy].some((id) => id && idOf(id) === idOf(auth.userId))) {
    throw forbidden('You cannot approve or publish a result you wrote or submitted.', 'SELF_APPROVAL');
  }
}

export async function returnResult(auth, id, { reason }) {
  const result = await findForAdmin(auth, id);
  const version = latest(result);
  if (version.status !== 'submitted' && version.status !== 'approved') {
    throw invalidStep(`Only a submitted or approved result can be returned; this version is ${version.status}.`);
  }
  version.status = 'draft';
  version.returnedBy = auth.userId;
  version.returnedAt = new Date();
  version.returnReason = reason;
  result.status = 'draft';
  await save(result);
  await audit(auth, result, 'result.returned', `Version ${version.number} returned to the teacher`, { version: version.number, reason });
  return toResultStaffView(result);
}

export async function approveResult(auth, id) {
  const result = await findForAdmin(auth, id);
  const version = latest(result);
  if (version.status !== 'submitted') throw invalidStep(`Only a submitted result can be approved; this version is ${version.status}.`);
  assertNotOwn(auth, version);

  version.status = 'approved';
  version.approvedBy = auth.userId;
  version.approvedAt = new Date();
  result.status = 'approved';
  await save(result);
  await audit(auth, result, 'result.approved', `Version ${version.number} approved`, { version: version.number, isCorrection: version.correctionOf != null });
  return toResultStaffView(result);
}

// An in-app alert for the student and linked parents. It never carries any figures, and
// never stops the publication if it cannot be created.
async function tellFamily(auth, result, isCorrection) {
  try {
    await notifyUsers(auth.schoolId, await recipientsForStudent(auth.schoolId, result.studentId), {
      type: 'result.published',
      title: isCorrection ? 'Corrected results published' : 'Results published',
      message: 'Open the results page. If this term is not unlocked yet, enter the result PIN.',
      entityType: 'result',
      entityId: result._id,
    });
  } catch (error) {
    console.error('Could not create result notifications:', error.message);
  }
}

export async function publishResult(auth, id) {
  const result = await findForAdmin(auth, id);
  const version = latest(result);
  if (version.status !== 'approved') throw invalidStep(`Only an approved result can be published; this version is ${version.status}.`);
  assertNotOwn(auth, version);

  version.status = 'published';
  version.publishedBy = auth.userId;
  version.publishedAt = new Date();
  result.status = 'published';
  result.publishedVersion = version.number;
  await save(result);
  await audit(auth, result, 'result.published', `Version ${version.number} published`, { version: version.number, isCorrection: version.correctionOf != null });
  await tellFamily(auth, result, version.correctionOf != null);
  return toResultStaffView(result);
}

// Takes a published result away from students and parents while an error is corrected. The
// published version is kept exactly as it was, with the reason and the administrator.
export async function recallResult(auth, id, { reason }) {
  const result = await findForAdmin(auth, id);
  const version = latest(result);
  if (result.status !== 'published' || version.status !== 'published') {
    throw invalidStep(`Only a published result can be recalled; this version is ${version.status}.`);
  }
  version.status = 'recalled';
  version.recalledBy = auth.userId;
  version.recalledAt = new Date();
  version.recallReason = reason;
  result.status = 'recalled';
  result.publishedVersion = null; // hidden from students and parents from this moment
  await save(result);
  await audit(auth, result, 'result.recalled', `Version ${version.number} recalled`, { version: version.number, reason });
  return toResultStaffView(result);
}

// ------------------------------------------------------------------------- reading

const isStaff = (auth) => auth.role === 'admin' || auth.role === 'teacher';

export async function listResults(auth, { academicSessionId, termId, classId, studentId, status, page = 1, limit = 20 } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(academicSessionId && { academicSessionId }),
    ...(termId && { termId }),
    ...(studentId && { studentId }),
    ...(status && { status }),
  };

  if (auth.role === 'admin') {
    if (classId) filter.classId = classId;
  } else if (auth.role === 'teacher') {
    const scope = await requireTeacher(auth);
    filter.classId = { $in: scope.classIds.filter((id) => !classId || idOf(id) === classId) };
  } else {
    return listPublishedForFamily(auth, filter, { classId, page, limit });
  }

  const [items, total] = await Promise.all([
    Result.find(filter).sort({ updatedAt: -1, _id: 1 }).skip((page - 1) * limit).limit(limit),
    Result.countDocuments(filter),
  ]);
  return { items: items.map((r) => toResultStaffView(r, { versions: false })), page, limit, total };
}

// A student sees their own, a parent their linked children's: only the published version,
// only while the student's status allows results, and (for students who have left) only
// results published up to the day they left.
async function visibleToFamily(auth, results) {
  const students = await Student.find(await studentScope(auth));
  const byId = new Map(students.map((s) => [idOf(s._id), s]));
  return results.filter((r) => {
    const student = byId.get(idOf(r.studentId));
    if (!student || r.publishedVersion == null) return false;
    const version = r.versions.find((v) => v.number === r.publishedVersion);
    return Boolean(version) && canViewPublishedResult(student, version.publishedAt);
  });
}

// Which of these results are unlocked, as a Set of "student|session|term" keys.
async function unlockedSet(auth, results) {
  if (results.length === 0) return new Set();
  const access = await ResultAccess.find({ schoolId: auth.schoolId, studentId: { $in: [...new Set(results.map((r) => r.studentId))] } });
  return new Set(access.map(accessKey));
}

async function listPublishedForFamily(auth, filter, { classId, page, limit }) {
  const students = await Student.find(await studentScope(auth)).select('_id');
  const results = await Result.find({
    ...filter,
    ...(classId && { classId }),
    studentId: filter.studentId ? { $in: students.map((s) => s._id).filter((id) => idOf(id) === filter.studentId) } : { $in: students.map((s) => s._id) },
    publishedVersion: { $ne: null },
  }).sort({ updatedAt: -1, _id: 1 });
  // Locked terms are left out of this list; GET /api/result-access says which are locked.
  const open = await unlockedSet(auth, results);
  const visible = (await visibleToFamily(auth, results)).filter((r) => open.has(accessKey(r)));
  const items = visible.slice((page - 1) * limit, page * limit).map(toResultPublishedView);
  return { items, page, limit, total: visible.length };
}

export async function getResult(auth, id) {
  if (auth.role === 'admin') return toResultStaffView(await findForAdmin(auth, id));
  if (auth.role === 'teacher') return toResultStaffView(await findForTeacher(auth, id));

  const students = await Student.find(await studentScope(auth)).select('_id');
  const result = await Result.findOne({ _id: id, schoolId: auth.schoolId, studentId: { $in: students.map((s) => s._id) }, publishedVersion: { $ne: null } });
  const visible = result ? await visibleToFamily(auth, [result]) : [];
  if (visible.length === 0) throw notFound('Result not found.'); // also the answer while it is recalled
  if (!(await unlockedSet(auth, visible)).has(accessKey(visible[0]))) {
    // The person may see this student, so saying it exists but is locked reveals nothing.
    throw forbidden('These results are locked. Enter the result PIN for this term to unlock them.', 'RESULT_LOCKED');
  }
  return toResultPublishedView(visible[0]);
}

// The complete version history, for administrators and the teachers of the class.
export async function getVersions(auth, id) {
  if (!isStaff(auth)) throw forbidden();
  const result = auth.role === 'admin' ? await findForAdmin(auth, id) : await findForTeacher(auth, id);
  return { resultId: idOf(result._id), status: result.status, currentVersion: result.currentVersion, publishedVersion: result.publishedVersion ?? null, versions: toResultStaffView(result).versions };
}
