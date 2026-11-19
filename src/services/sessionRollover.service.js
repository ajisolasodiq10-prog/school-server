import {
  AcademicSession,
  AuditLog,
  Class,
  PromotionDecision,
  Result,
  School,
  SessionRollover,
  Student,
} from '../models/index.js';
import { AppError, conflict } from '../utils/AppError.js';
import { recordAuditBatch } from './audit.service.js';
import { levelsFor, planStudentMove } from './classProgression.service.js';
import { placeInClass } from './studentClass.service.js';
import { runAtomically } from './transaction.service.js';

// Starting a new academic session ("rollover"), administrator only.
//
// In one all-or-nothing step it
//   1. closes the previous session (and its terms) and creates + activates the new one,
//   2. copies the previous session's active classes into the new session,
//   3. moves students with a CONFIRMED "promoted" decision to the next class (same arm where
//      possible), keeps "repeated" students at their level in the new session's class, and
//      flags everyone it cannot place (no confirmed decision, final class, no matching class),
//   4. marks the decisions as applied and writes the audit trail.
// Nothing is deleted: old classes, old enrolments (class history), results and decisions stay.
//
// Safe to repeat: SessionRollover has a unique index, so only one running-or-completed
// rollover can exist per previous session. Repeating a finished request returns the original
// summary; a concurrent duplicate is refused while the first is running.
//
// All-or-nothing: see transaction.service.js (real transaction, or an undo log).

const STALE_RUNNING_MS = 15 * 60 * 1000;

// Test-only failure injection: throws after N students have been processed. Inert unless
// NODE_ENV is "test".
let failAfterStudents = null;
export const setRolloverFailpoint = (n) => {
  failAfterStudents = n;
};

const idOf = (value) => String(value);

// ------------------------------------------------------------------------- planning

// Works out what a rollover WOULD do and what stops it, without changing anything.
export async function buildRolloverPlan(auth, input) {
  const schoolId = auth.schoolId;
  const previous = await AcademicSession.findOne({ schoolId, isCurrent: true });
  if (!previous) {
    throw new AppError(409, 'There is no current academic session to roll over from.', { code: 'NO_CURRENT_SESSION' });
  }

  const blockers = [];
  const warnings = [];
  const now = new Date();

  if (await AcademicSession.exists({ schoolId, name: input.name })) {
    blockers.push({ code: 'SESSION_NAME_TAKEN', message: `A session named ${input.name} already exists.` });
  }
  if (input.startDate <= previous.endDate) {
    blockers.push({ code: 'STARTS_BEFORE_PREVIOUS_ENDS', message: 'The new session must start after the previous session ends.' });
  }

  // "Properly closed": the third term exists and is over (closed, or its end date has passed).
  const third = previous.terms.find((t) => t.name === 'Third Term');
  if (!third) {
    blockers.push({ code: 'NO_THIRD_TERM', message: 'The previous session has no Third Term, so it cannot be closed for promotion.' });
  } else if (!(third.status === 'closed' || third.endDate <= now)) {
    blockers.push({ code: 'PREVIOUS_SESSION_NOT_FINISHED', message: 'The Third Term of the previous session has not ended yet.' });
  }

  const [school, oldClasses] = await Promise.all([
    School.findById(schoolId).select('classLevels'),
    Class.find({ schoolId, academicSessionId: previous._id }),
  ]);
  const levels = levelsFor(school);
  const oldClassById = new Map(oldClasses.map((c) => [idOf(c._id), c]));
  // The classes the new session will have: every active class of the previous one.
  const newClassSpecs = oldClasses
    .filter((c) => c.status === 'active')
    .map((c) => ({ name: c.name, arm: c.arm, status: 'active', sourceId: idOf(c._id) }));

  const [students, confirmed, unpublished] = await Promise.all([
    Student.find({ schoolId, status: 'active', currentClassId: { $in: oldClasses.map((c) => c._id) } }),
    PromotionDecision.find({ schoolId, academicSessionId: previous._id, status: 'confirmed' }),
    Result.countDocuments({ schoolId, academicSessionId: previous._id, status: { $in: ['draft', 'submitted', 'approved'] } }),
  ]);
  const decisionByStudent = new Map(confirmed.map((d) => [idOf(d.studentId), d.decision]));

  const items = students.map((student) => {
    const fromClass = oldClassById.get(idOf(student.currentClassId));
    const move = planStudentMove({ levels, fromClass, decision: decisionByStudent.get(idOf(student._id)), newClasses: newClassSpecs });
    return {
      studentId: idOf(student._id),
      studentCode: student.studentId,
      fromClassId: idOf(fromClass._id),
      fromClass: `${fromClass.name}${fromClass.arm}`,
      action: move.action,
      reason: move.reason ?? null,
      targetSourceId: move.target?.sourceId ?? null,
      toClass: move.target ? `${move.target.name}${move.target.arm}` : null,
    };
  });

  const missing = items.filter((i) => i.reason === 'NO_CONFIRMED_DECISION');
  if (missing.length > 0 && !input.allowUnconfirmed) {
    blockers.push({
      code: 'DECISIONS_PENDING',
      message: `${missing.length} student(s) have no confirmed promotion decision. Confirm them, or start the session with allowUnconfirmed to leave them for manual review.`,
      students: missing.map((i) => ({ studentId: i.studentId, studentCode: i.studentCode, class: i.fromClass })),
    });
  }
  if (unpublished > 0) {
    warnings.push({ code: 'UNPUBLISHED_RESULTS', message: `${unpublished} result(s) of the previous session are not published yet. They are kept and can still be finished.` });
  }

  const count = (action) => items.filter((i) => i.action === action).length;
  return {
    previous,
    oldClasses,
    items,
    blockers,
    warnings,
    summary: {
      eligibleStudents: items.length,
      promote: count('promote'),
      repeat: count('repeat'),
      needsReview: count('review'),
      classesToCreate: newClassSpecs.length,
    },
  };
}

const publicPlan = (plan) => ({
  canStart: plan.blockers.length === 0,
  previousSession: { id: idOf(plan.previous._id), name: plan.previous.name },
  blockers: plan.blockers,
  warnings: plan.warnings,
  summary: plan.summary,
  students: plan.items.map(({ targetSourceId, ...rest }) => rest),
});

export async function previewRollover(auth, input) {
  await new AcademicSession({ ...input, schoolId: auth.schoolId, status: 'open', isCurrent: true, terms: shapeTerms(input) }).validate();
  return publicPlan(await buildRolloverPlan(auth, input));
}

// ------------------------------------------------------------------------ execution

function shapeTerms(input) {
  const terms = [...(input.terms || [])].sort((a, b) => a.startDate - b.startDate);
  const openFirst = input.startFirstTerm !== false;
  return terms.map((term, index) => ({
    ...term,
    status: openFirst && index === 0 ? 'open' : 'upcoming',
    isCurrent: openFirst && index === 0,
  }));
}

async function replayIfDone(run) {
  return { ...run.summary, rolloverId: idOf(run._id), alreadyApplied: true };
}

export async function startNewSession(auth, input) {
  const schoolId = auth.schoolId;

  // A repeat of a request that already succeeded gets the original answer, not a second run.
  let existing = await SessionRollover.findOne({ schoolId, name: input.name, status: { $in: ['running', 'completed'] } });
  if (existing?.status === 'completed') return replayIfDone(existing);
  if (existing?.status === 'running') {
    if (Date.now() - existing.startedAt.getTime() < STALE_RUNNING_MS) {
      throw new AppError(409, 'This new session is already being started. Wait for it to finish.', { code: 'ROLLOVER_IN_PROGRESS' });
    }
    // Abandoned (the server stopped part-way): release it so the administrator can retry.
    await SessionRollover.updateOne({ _id: existing._id, status: 'running' }, { $set: { status: 'failed', failure: 'Abandoned: no result after 15 minutes.', finishedAt: new Date() } });
  }

  // Reject a bad payload before claiming anything.
  const draft = new AcademicSession({ ...input, schoolId, status: 'open', isCurrent: true, terms: shapeTerms(input) });
  await draft.validate();

  const plan = await buildRolloverPlan(auth, input);
  if (plan.blockers.length > 0) {
    throw new AppError(409, 'The new session cannot be started yet.', { code: 'ROLLOVER_BLOCKED', details: plan.blockers });
  }

  // Claim: the unique index lets exactly one request through.
  const claim = new SessionRollover({
    schoolId,
    fromSessionId: plan.previous._id,
    name: input.name,
    status: 'running',
    startedBy: auth.userId,
    startedAt: new Date(),
  });
  try {
    await claim.save();
  } catch (error) {
    if (error?.code !== 11000) throw error;
    existing = await SessionRollover.findOne({ schoolId, fromSessionId: plan.previous._id, status: { $in: ['running', 'completed'] } });
    if (existing?.status === 'completed' && existing.name === input.name) return replayIfDone(existing);
    throw new AppError(
      409,
      existing?.status === 'completed' ? 'A new session has already been started from this session.' : 'A new session is already being started. Wait for it to finish.',
      { code: existing?.status === 'completed' ? 'ROLLOVER_ALREADY_DONE' : 'ROLLOVER_IN_PROGRESS' }
    );
  }

  try {
    const summary = await runAtomically((ctx) => applyRollover(auth, plan, input, claim, ctx));
    await SessionRollover.updateOne(
      { _id: claim._id },
      { $set: { status: 'completed', newSessionId: summary.newSession.id, summary, finishedAt: new Date() } }
    );
    return { ...summary, rolloverId: idOf(claim._id), alreadyApplied: false };
  } catch (error) {
    await SessionRollover.updateOne(
      { _id: claim._id },
      { $set: { status: 'failed', failure: String(error.message).slice(0, 500), finishedAt: new Date() } }
    );
    throw error;
  }
}

async function applyRollover(auth, plan, input, claim, { session, journal }) {
  const schoolId = auth.schoolId;
  const now = new Date();
  const withSession = (query) => (session ? query.session(session) : query);

  // 1. Close the previous session. The update only matches if it is still the current one.
  const previous = await withSession(AcademicSession.findOne({ _id: plan.previous._id, schoolId, isCurrent: true }));
  if (!previous) throw conflict('The current session changed while the new session was being started. Nothing was changed.');
  const snapshot = { status: previous.status, terms: previous.terms.map((t) => t.toObject()) };
  const closed = await AcademicSession.updateOne(
    { _id: previous._id, schoolId, isCurrent: true },
    { $set: { isCurrent: false, status: 'closed', 'terms.$[].isCurrent': false, 'terms.$[].status': 'closed' } },
    { session }
  );
  if (closed.modifiedCount !== 1) throw conflict('The current session changed while the new session was being started. Nothing was changed.');
  journal.add(() =>
    AcademicSession.updateOne({ _id: previous._id }, { $set: { isCurrent: true, status: snapshot.status, terms: snapshot.terms } })
  );

  // 2. Create and activate the new session.
  const created = new AcademicSession({
    schoolId,
    name: input.name,
    startDate: input.startDate,
    endDate: input.endDate,
    status: 'open',
    isCurrent: true,
    terms: shapeTerms(input),
  });
  await created.validate();
  await created.save({ session });
  journal.add(() => AcademicSession.deleteOne({ _id: created._id }, { allowHardDelete: true }));

  // 3. Copy the active classes into the new session.
  const cloneBySource = new Map();
  for (const old of plan.oldClasses.filter((c) => c.status === 'active')) {
    const clone = new Class({
      schoolId,
      name: old.name,
      arm: old.arm,
      classTeacherId: old.classTeacherId,
      academicSessionId: created._id,
      subjectIds: old.subjectIds,
      status: 'active',
    });
    // The new session is not visible to the reference check until the transaction commits.
    await clone.validate({ pathsToSkip: ['academicSessionId'] });
    await clone.save({ session, validateBeforeSave: false });
    cloneBySource.set(idOf(old._id), clone);
  }
  const cloneIds = [...cloneBySource.values()].map((c) => c._id);
  journal.add(() => Class.deleteMany({ _id: { $in: cloneIds } }, { allowHardDelete: true }));

  // 4. Move or flag every eligible student.
  const students = await withSession(
    Student.find({ _id: { $in: plan.items.map((i) => i.studentId) }, schoolId, status: 'active' })
  );
  const byId = new Map(students.map((s) => [idOf(s._id), s]));
  const moved = [];
  const flagged = [];
  const audit = [];
  let processed = 0;

  for (const item of plan.items) {
    const student = byId.get(item.studentId);
    if (!student || idOf(student.currentClassId) !== item.fromClassId) {
      throw conflict(`Student ${item.studentCode} changed while the new session was being started. Nothing was changed.`);
    }
    const before = {
      currentClassId: student.currentClassId,
      classHistory: student.classHistory.map((e) => e.toObject()),
      reviewFlag: student.reviewFlag?.reason ? student.reviewFlag.toObject() : null,
    };
    journal.add(() => {
      const restore = { currentClassId: before.currentClassId, classHistory: before.classHistory };
      return Student.updateOne(
        { _id: student._id },
        before.reviewFlag ? { $set: { ...restore, reviewFlag: before.reviewFlag } } : { $set: restore, $unset: { reviewFlag: 1 } }
      );
    });

    if (item.action === 'promote' || item.action === 'repeat') {
      const target = cloneBySource.get(item.targetSourceId);
      placeInClass(student, target, item.action === 'promote' ? 'promoted' : 'repeated', now, {
        by: auth.userId,
        note: `New session ${input.name}`,
      });
      student.reviewFlag = undefined;
      moved.push(student._id);
      audit.push({
        action: 'student.class_changed',
        entityType: 'student',
        entityId: student._id,
        studentId: student._id,
        summary: `${item.action === 'promote' ? 'Promoted' : 'Repeated'} for session ${input.name}`,
        details: { fromClassId: item.fromClassId, toClassId: target._id, source: 'rollover', action: item.action },
      });
    } else {
      student.reviewFlag = { reason: item.reason, academicSessionId: created._id, flaggedAt: now };
      flagged.push({ studentId: item.studentId, studentCode: item.studentCode, class: item.fromClass, reason: item.reason });
      audit.push({
        action: 'student.flagged_for_review',
        entityType: 'student',
        entityId: student._id,
        studentId: student._id,
        summary: `Needs manual placement (${item.reason})`,
        details: { fromClassId: item.fromClassId, reason: item.reason, source: 'rollover' },
      });
    }
    await student.validate({ pathsToSkip: ['currentClassId'] });
    await student.save({ session, validateBeforeSave: false });

    processed += 1;
    if (process.env.NODE_ENV === 'test' && failAfterStudents && processed >= failAfterStudents) {
      throw new Error('Injected failure (test)');
    }
  }

  // 5. The decisions have now been acted on and become history.
  if (moved.length > 0) {
    await PromotionDecision.updateMany(
      { schoolId, academicSessionId: previous._id, studentId: { $in: moved }, status: 'confirmed', appliedAt: { $exists: false } },
      { $set: { appliedAt: now, rolloverId: claim._id } },
      { session }
    );
    journal.add(() =>
      PromotionDecision.updateMany({ rolloverId: claim._id }, { $unset: { appliedAt: 1, rolloverId: 1 } })
    );
  }

  // 6. Audit trail.
  const summary = {
    previousSession: { id: idOf(previous._id), name: previous.name },
    newSession: { id: idOf(created._id), name: created.name },
    classesCreated: cloneBySource.size,
    students: {
      eligible: plan.items.length,
      promoted: plan.items.filter((i) => i.action === 'promote').length,
      repeated: plan.items.filter((i) => i.action === 'repeat').length,
      flaggedForReview: flagged.length,
    },
    flagged,
  };
  const logs = await recordAuditBatch(
    auth,
    [
      {
        action: 'session.activated',
        entityType: 'academic_session',
        entityId: created._id,
        summary: `Started session ${created.name}; ${previous.name} closed`,
        details: { previousSessionId: previous._id, rolloverId: claim._id, ...summary.students, classesCreated: cloneBySource.size },
      },
      ...audit,
    ],
    { session }
  );
  const logIds = logs.map((l) => l._id);
  journal.add(() => AuditLog.deleteMany({ _id: { $in: logIds } }, { allowHardDelete: true }));

  return summary;
}
