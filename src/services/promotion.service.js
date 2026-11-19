import { AcademicSession, PromotionDecision, Student } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { toDecisionView } from '../utils/serializers.js';
import { getTeacherScope } from './access.service.js';
import { recordAudit } from './audit.service.js';
import { classForSession } from './enrolment.service.js';
import { registerAcademicRecordCheck } from './academicRecords.service.js';

// Promotion decisions: Promoted or Repeated, one per student per academic session, tied to
// the class the student was in that session.
//
//   teacher        RECOMMENDS (during / after third term), only for students in their classes
//   administrator  CONFIRMS (may agree with the recommendation or decide differently)
//
// Nothing here moves a student. Classes change only when an administrator starts a new
// session (sessionRollover.service.js), and only on CONFIRMED decisions.

registerAcademicRecordCheck(async ({ schoolId, sessionId, termId }) =>
  !termId && (await PromotionDecision.exists({ schoolId, academicSessionId: sessionId })) ? 'promotion decisions' : null
);

const decisionConfirmed = () =>
  new AppError(409, 'This promotion decision has already been confirmed by an administrator.', { code: 'DECISION_CONFIRMED' });

async function load(auth, studentId, academicSessionId) {
  const student = await Student.findOne({ _id: studentId, schoolId: auth.schoolId });
  if (!student) throw notFound('Student not found.');
  const session = await AcademicSession.findOne({ _id: academicSessionId, schoolId: auth.schoolId });
  if (!session) throw notFound('Academic session not found.');
  const klass = await classForSession(auth.schoolId, student, session._id);
  if (!klass) {
    throw new AppError(409, 'This student was not enrolled in a class during that session.', { code: 'STUDENT_NOT_ENROLLED' });
  }
  return { student, session, klass };
}

// Promotion is decided at the end of the year: the session needs a third term that has begun.
function assertThirdTermStarted(session) {
  const third = session.terms.find((t) => t.name === 'Third Term');
  if (!third || third.status === 'upcoming') {
    throw new AppError(409, 'Promotion decisions can only be made once the Third Term of the session has started.', {
      code: 'THIRD_TERM_NOT_STARTED',
    });
  }
}

const isDuplicate = (error) => error?.code === 11000;

// Teacher: recommend promoted / repeated. May be changed until an administrator confirms.
export async function recommendPromotion(auth, { studentId, academicSessionId, recommendation }) {
  const { student, session, klass } = await load(auth, studentId, academicSessionId);
  assertThirdTermStarted(session);

  const { teacher, classIds } = await getTeacherScope(auth);
  if (!teacher || !classIds.some((id) => String(id) === String(klass._id))) {
    // Same answer as for a student who does not exist: nothing about other classes is revealed.
    throw notFound('Student not found.');
  }

  const now = new Date();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let decision = await PromotionDecision.findOne({ schoolId: auth.schoolId, studentId: student._id, academicSessionId: session._id });
    if (decision?.status === 'confirmed') throw decisionConfirmed();
    const previous = decision?.recommendation ?? null;
    if (!decision) {
      decision = new PromotionDecision({
        schoolId: auth.schoolId,
        studentId: student._id,
        academicSessionId: session._id,
        classId: klass._id,
        status: 'recommended',
      });
    }
    decision.recommendation = recommendation;
    decision.recommendedBy = auth.userId;
    decision.recommendedAt = now;
    try {
      await decision.save();
    } catch (error) {
      if (isDuplicate(error) && attempt === 0) continue; // two teachers at once: load theirs and update it
      throw error;
    }
    await recordAudit(auth, {
      action: 'promotion.recommended',
      entityType: 'promotion_decision',
      entityId: decision._id,
      studentId: student._id,
      summary: `Teacher recommended: ${recommendation}`,
      details: { academicSessionId: session._id, classId: klass._id, recommendation, previousRecommendation: previous },
    });
    return toDecisionView(decision);
  }
  throw new AppError(409, 'Could not save the recommendation. Please try again.', { code: 'CONFLICT' });
}

// Administrator: confirm the teacher's recommendation as it is (leave `decision` out) or decide.
export async function confirmPromotion(auth, { studentId, academicSessionId, decision: chosen }) {
  const { student, session, klass } = await load(auth, studentId, academicSessionId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let record = await PromotionDecision.findOne({ schoolId: auth.schoolId, studentId: student._id, academicSessionId: session._id });
    if (record?.appliedAt) {
      throw new AppError(409, 'A new session has already acted on this decision, so it can no longer be changed.', { code: 'DECISION_APPLIED' });
    }
    const final = chosen ?? record?.recommendation;
    if (!final) {
      throw badRequest('There is no recommendation to confirm. Say whether the student is promoted or repeated.', { code: 'VALIDATION_ERROR' });
    }
    const previous = record?.decision ?? null;
    if (!record) {
      record = new PromotionDecision({
        schoolId: auth.schoolId,
        studentId: student._id,
        academicSessionId: session._id,
        classId: klass._id,
      });
    }
    record.decision = final;
    record.confirmedBy = auth.userId;
    record.confirmedAt = new Date();
    record.status = 'confirmed';
    try {
      await record.save();
    } catch (error) {
      if (isDuplicate(error) && attempt === 0) continue;
      throw error;
    }
    await recordAudit(auth, {
      action: 'promotion.confirmed',
      entityType: 'promotion_decision',
      entityId: record._id,
      studentId: student._id,
      summary: `Administrator confirmed: ${final}`,
      details: {
        academicSessionId: session._id,
        classId: klass._id,
        decision: final,
        previousDecision: previous,
        recommendation: record.recommendation ?? null,
        overrodeRecommendation: Boolean(record.recommendation && record.recommendation !== final),
      },
    });
    return toDecisionView(record);
  }
  throw new AppError(409, 'Could not save the decision. Please try again.', { code: 'CONFLICT' });
}

export async function listDecisions(auth, { academicSessionId, classId, status, page = 1, limit = 20 } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(academicSessionId && { academicSessionId }),
    ...(classId && { classId }),
    ...(status && { status }),
  };
  if (auth.role === 'teacher') {
    const { classIds } = await getTeacherScope(auth);
    filter.classId = classId ? { $in: classIds.filter((id) => String(id) === classId) } : { $in: classIds };
  }
  const [items, total] = await Promise.all([
    PromotionDecision.find(filter).sort({ createdAt: 1, _id: 1 }).skip((page - 1) * limit).limit(limit),
    PromotionDecision.countDocuments(filter),
  ]);
  return { items: items.map(toDecisionView), page, limit, total };
}
