import crypto from 'node:crypto';
import { promisify } from 'node:util';
import mongoose from 'mongoose';
import { AcademicSession, Class, Result, ResultAccess, ResultPin, Student, User } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { joinName, toPinView, toRedemptionView, toResultAccessView } from '../utils/serializers.js';
import { searchFilter } from '../utils/search.js';
import { studentScope } from './access.service.js';
import { recordAudit, recordAuditBatch } from './audit.service.js';
import { assertStudentCapability, canViewPublishedResult } from './lifecycle.service.js';
import { runAtomically } from './transaction.service.js';

// RESULT PINs
//
//   administrator   generates PINs (one, or a batch), sees their status, revokes UNUSED ones,
//                   reads the redemption history. Nobody can read a PIN again: only a salted
//                   scrypt hash is stored, and the plaintext is returned once, on generation.
//   student/parent  redeem the PIN for one student and one term. Success creates a ResultAccess
//                   record that belongs to the student + session + term (not to a login), so
//                   it survives logout, and every linked viewer of that student can read that
//                   term's PUBLISHED results from then on. Recalled results stay hidden because
//                   result.service still requires a published version.
//
// All the ways a redemption can fail (wrong PIN, no PIN issued for that term, revoked PIN,
// unknown session or term, malformed text) give the SAME answer, so nothing reveals whether
// a PIN exists or belongs to another student. Attempts are rate limited in
// middleware/rateLimiter.js.

const scrypt = promisify(crypto.scrypt);

// No 0/O, 1/I/L. 31 symbols x 12 positions is about 59 bits of randomness.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PIN_LENGTH = 12;
const BULK_LIMIT = 100;
const idOf = (value) => String(value);

const INVALID_PIN = () =>
  new AppError(400, 'That PIN is not valid for this student and term.', { code: 'INVALID_PIN' });

export function generatePinValue() {
  let pin = '';
  for (let i = 0; i < PIN_LENGTH; i += 1) pin += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return pin;
}

export const formatPin = (pin) => pin.match(/.{1,4}/g).join('-'); // XXXX-XXXX-XXXX

// "abcd efgh-jkmn" -> "ABCDEFGHJKMN". Anything that is not a well-formed PIN becomes null.
export function normalisePin(input) {
  const pin = String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
  return pin.length === PIN_LENGTH && [...pin].every((c) => ALPHABET.includes(c)) ? pin : null;
}

async function hashPin(pin, saltHex) {
  return (await scrypt(pin, Buffer.from(saltHex, 'hex'), 32)).toString('hex');
}

const sameHash = (a, b) => {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function newSecret() {
  const pin = generatePinValue();
  const salt = crypto.randomBytes(16).toString('hex');
  return { pin, salt, pinHash: await hashPin(pin, salt) };
}

// ------------------------------------------------------------------ shared lookups

async function findSessionTerm(auth, academicSessionId, termId) {
  const session = await AcademicSession.findOne({ _id: academicSessionId, schoolId: auth.schoolId });
  if (!session) throw notFound('Academic session not found.');
  const term = session.terms.id(termId);
  if (!term) throw notFound('Term not found.');
  return { session, term };
}

const nameOf = (s) => joinName(s.firstName, s.middleName, s.lastName);

async function studentLookup(schoolId, ids) {
  const students = await Student.find({ _id: { $in: ids }, schoolId });
  return new Map(students.map((s) => [idOf(s._id), s]));
}

const duplicate = (error) => error?.code === 11000;

const pinExistsError = (existing) =>
  new AppError(
    409,
    existing?.status === 'redeemed'
      ? 'A PIN for this student and term has already been redeemed. Their results for this term are unlocked.'
      : 'A PIN already exists for this student and term. Revoke the unused PIN first if a new one is needed.',
    { code: 'PIN_ALREADY_EXISTS' }
  );

// ------------------------------------------------------------------- generation

export async function generatePin(auth, { studentId, academicSessionId, termId }) {
  const student = await Student.findOne({ _id: studentId, schoolId: auth.schoolId });
  if (!student) throw notFound('Student not found.');
  await findSessionTerm(auth, academicSessionId, termId);

  const key = { schoolId: auth.schoolId, studentId: student._id, academicSessionId, termId };
  const existing = await ResultPin.findOne({ ...key, live: true });
  if (existing) throw pinExistsError(existing);

  const secret = await newSecret();
  let pin;
  try {
    pin = await ResultPin.create({ ...key, pinHash: secret.pinHash, salt: secret.salt, generatedBy: auth.userId });
  } catch (error) {
    if (duplicate(error)) throw pinExistsError(await ResultPin.findOne({ ...key, live: true }));
    throw error;
  }
  await recordAudit(auth, {
    action: 'result_pin.generated',
    entityType: 'result_pin',
    entityId: pin._id,
    studentId: student._id,
    summary: `Result PIN generated for ${nameOf(student)}`,
    details: { academicSessionId, termId }, // never the PIN
  });
  return { pin: toPinView(pin, student), pinValue: formatPin(secret.pin) };
}

// One request, many students: either an explicit list or every active student currently in a
// class. Students who already have a live PIN, or who are not in this school, are skipped
// (and reported), never given a second PIN.
export async function generateBulk(auth, { academicSessionId, termId, studentIds, classId }) {
  if ((studentIds === undefined) === (classId === undefined)) {
    throw badRequest('Send either studentIds or classId.', { code: 'VALIDATION_ERROR' });
  }
  await findSessionTerm(auth, academicSessionId, termId);

  let requested = studentIds ?? [];
  if (classId) {
    const klass = await Class.findOne({ _id: classId, schoolId: auth.schoolId });
    if (!klass) throw notFound('Class not found.');
    const inClass = await Student.find({ schoolId: auth.schoolId, currentClassId: klass._id, status: 'active' }).select('_id');
    requested = inClass.map((s) => idOf(s._id));
    if (requested.length > BULK_LIMIT) {
      throw badRequest(`A class of more than ${BULK_LIMIT} students must be done in smaller groups of studentIds.`, { code: 'VALIDATION_ERROR' });
    }
  }

  const students = await studentLookup(auth.schoolId, requested);
  const have = await ResultPin.find({ schoolId: auth.schoolId, academicSessionId, termId, live: true, studentId: { $in: requested } }).select('studentId');
  const hasPin = new Set(have.map((p) => idOf(p.studentId)));

  const batchId = new mongoose.Types.ObjectId();
  const generated = [];
  const skipped = [];
  const todo = [];
  for (const id of requested) {
    if (!students.has(id)) skipped.push({ studentId: id, reason: 'NOT_FOUND' });
    else if (hasPin.has(id)) skipped.push({ studentId: id, reason: 'ALREADY_HAS_PIN' });
    else todo.push(students.get(id));
  }

  await Promise.all(
    todo.map(async (student) => {
      const secret = await newSecret();
      try {
        const pin = await ResultPin.create({
          schoolId: auth.schoolId,
          studentId: student._id,
          academicSessionId,
          termId,
          pinHash: secret.pinHash,
          salt: secret.salt,
          generatedBy: auth.userId,
          batchId,
        });
        generated.push({ pin, student, pinValue: formatPin(secret.pin) });
      } catch (error) {
        if (!duplicate(error)) throw error;
        skipped.push({ studentId: idOf(student._id), reason: 'ALREADY_HAS_PIN' }); // lost a race
      }
    })
  );

  await recordAuditBatch(
    auth,
    generated.map(({ pin, student }) => ({
      action: 'result_pin.generated',
      entityType: 'result_pin',
      entityId: pin._id,
      studentId: student._id,
      summary: `Result PIN generated for ${nameOf(student)}`,
      details: { academicSessionId, termId, batchId: idOf(batchId) },
    }))
  );

  generated.sort((a, b) => nameOf(a.student).localeCompare(nameOf(b.student)));
  return {
    batchId: idOf(batchId),
    generated: generated.map(({ pin, student, pinValue }) => ({ ...toPinView(pin, student), pinValue })),
    skipped,
    counts: { requested: requested.length, generated: generated.length, skipped: skipped.length },
  };
}

// ----------------------------------------------------------------- administration

export async function listPins(auth, { studentId, academicSessionId, termId, status, q, page = 1, limit = 20 } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(academicSessionId && { academicSessionId }),
    ...(termId && { termId }),
    ...(status && { status }),
  };
  if (studentId) filter.studentId = studentId;

  // A search box: names and student numbers are matched against this school's students.
  const text = searchFilter(q, ['firstName', 'middleName', 'lastName', 'studentId']);
  if (text) {
    const found = await Student.find({ schoolId: auth.schoolId, ...text }).select('_id').limit(500);
    const ids = found.map((s) => idOf(s._id));
    filter.studentId = studentId ? (ids.includes(studentId) ? studentId : { $in: [] }) : { $in: ids };
  }

  const [pins, total] = await Promise.all([
    ResultPin.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    ResultPin.countDocuments(filter),
  ]);
  const students = await studentLookup(auth.schoolId, pins.map((p) => p.studentId));
  return { items: pins.map((p) => toPinView(p, students.get(idOf(p.studentId)))), page, limit, total };
}

export async function getPin(auth, id) {
  const pin = await ResultPin.findOne({ _id: id, schoolId: auth.schoolId });
  if (!pin) throw notFound('PIN not found.');
  const student = await Student.findOne({ _id: pin.studentId, schoolId: auth.schoolId });
  return toPinView(pin, student);
}

// Only an UNUSED PIN can be revoked. A redeemed PIN has already done its job (the unlock is a
// permanent record), and a revoked PIN stays on file with who revoked it and why. The change
// is a single conditional update, so a PIN cannot be revoked and redeemed at the same moment.
export async function revokePin(auth, id, { reason }) {
  const revoked = await ResultPin.findOneAndUpdate(
    { _id: id, schoolId: auth.schoolId, status: 'active' },
    { $set: { status: 'revoked', live: false, revokedBy: auth.userId, revokedAt: new Date(), revokeReason: reason } },
    { new: true }
  );
  if (!revoked) {
    const pin = await ResultPin.findOne({ _id: id, schoolId: auth.schoolId });
    if (!pin) throw notFound('PIN not found.');
    throw new AppError(409, pin.status === 'redeemed' ? 'This PIN has already been redeemed and cannot be revoked.' : 'This PIN is already revoked.', { code: 'PIN_NOT_REVOKABLE' });
  }
  await recordAudit(auth, {
    action: 'result_pin.revoked',
    entityType: 'result_pin',
    entityId: revoked._id,
    studentId: revoked.studentId,
    summary: 'Result PIN revoked',
    details: { academicSessionId: revoked.academicSessionId, termId: revoked.termId, reason },
  });
  const student = await Student.findOne({ _id: revoked.studentId, schoolId: auth.schoolId });
  return toPinView(revoked, student);
}

// Who unlocked what, and when (newest first).
export async function listRedemptions(auth, { studentId, academicSessionId, termId, page = 1, limit = 20 } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(studentId && { studentId }),
    ...(academicSessionId && { academicSessionId }),
    ...(termId && { termId }),
  };
  const [records, total] = await Promise.all([
    ResultAccess.find(filter).sort({ redeemedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    ResultAccess.countDocuments(filter),
  ]);
  const [students, users] = await Promise.all([
    studentLookup(auth.schoolId, records.map((r) => r.studentId)),
    User.find({ _id: { $in: records.map((r) => r.redeemedBy) }, schoolId: auth.schoolId }).select('fullName'),
  ]);
  const names = new Map(users.map((u) => [idOf(u._id), u.fullName]));
  return {
    items: records.map((r) => toRedemptionView(r, students.get(idOf(r.studentId)), names.get(idOf(r.redeemedBy)))),
    page,
    limit,
    total,
  };
}

// -------------------------------------------------------------------- redemption

const alreadyUnlocked = (access) => ({ unlocked: true, alreadyUnlocked: true, access: toResultAccessView(access) });

export async function redeemPin(auth, { studentId, academicSessionId, termId, pin }) {
  // 1. The student must be one this person may act for: their own record, or a linked child,
  //    in their own school. Anything else is "not found".
  const student = await Student.findOne({ ...(await studentScope(auth)), _id: studentId });
  if (!student) throw notFound('Student not found.');
  assertStudentCapability(student, 'results'); // e.g. an inactive student cannot unlock results

  const key = { schoolId: auth.schoolId, studentId: student._id, academicSessionId, termId };

  // 2. Already unlocked (by anyone): nothing to enter again.
  const existing = await ResultAccess.findOne(key);
  if (existing) return alreadyUnlocked(existing);

  // 3. Check the PIN. The work is done even when there is no PIN to compare with, so a
  //    missing PIN and a wrong PIN take the same time and give the same answer.
  const record = await ResultPin.findOne({ ...key, live: true, status: 'active' }).select('+pinHash +salt');
  const candidate = normalisePin(pin);
  const salt = record?.salt ?? crypto.randomBytes(16).toString('hex');
  const given = await hashPin(candidate ?? 'INVALID-PIN-X', salt);
  const matches = Boolean(record && candidate && sameHash(given, record.pinHash));
  if (!matches) {
    if (record) await ResultPin.updateOne({ _id: record._id }, { $inc: { failedAttempts: 1 }, $set: { lastFailedAt: new Date() } });
    throw INVALID_PIN();
  }

  // 4. Redeem: claim the PIN (only one request can win), record the unlock and audit it, all
  //    together. If any step fails, nothing stays half-done.
  const now = new Date();
  try {
    const access = await runAtomically(async ({ session, journal }) => {
      const claimed = await ResultPin.findOneAndUpdate(
        { _id: record._id, schoolId: auth.schoolId, status: 'active', live: true },
        { $set: { status: 'redeemed', redeemedBy: auth.userId, redeemedByRole: auth.role, redeemedAt: now } },
        { new: true, session }
      );
      if (!claimed) throw new AppError(409, 'This PIN was just used.', { code: 'PIN_JUST_USED' });
      journal.add(() =>
        ResultPin.updateOne({ _id: record._id }, { $set: { status: 'active' }, $unset: { redeemedBy: 1, redeemedByRole: 1, redeemedAt: 1 } })
      );

      const [created] = await ResultAccess.create(
        [{ ...key, pinId: record._id, redeemedBy: auth.userId, redeemedByRole: auth.role, redeemedAt: now }],
        { session }
      );
      journal.add(() => ResultAccess.deleteOne({ _id: created._id }, { allowHardDelete: true }));

      await recordAudit(
        auth,
        {
          action: 'result_pin.redeemed',
          entityType: 'result_pin',
          entityId: record._id,
          studentId: student._id,
          summary: 'Result PIN redeemed',
          details: { academicSessionId, termId, redeemedByRole: auth.role },
        },
        { session }
      );
      return created;
    });
    return { unlocked: true, alreadyUnlocked: false, access: toResultAccessView(access) };
  } catch (error) {
    // Two requests with the correct PIN at once: the loser finds the unlock the winner made.
    if (duplicate(error) || error?.code === 'PIN_JUST_USED') {
      const winner = await ResultAccess.findOne(key);
      if (winner) return alreadyUnlocked(winner);
      // Lost to a revocation instead: to this person the PIN simply no longer works.
      if (error?.code === 'PIN_JUST_USED') throw INVALID_PIN();
    }
    throw error;
  }
}

// ------------------------------------------------------------- what is unlocked

export const accessKey = (r) => `${idOf(r.studentId)}|${idOf(r.academicSessionId)}|${idOf(r.termId)}`;

// For students and parents: the published results they could open, and whether each term is
// unlocked yet. Recalled or unpublished results are not listed at all.
export async function listResultAccess(auth, { studentId } = {}) {
  const students = await Student.find({ ...(await studentScope(auth)), ...(studentId && { _id: studentId }) });
  if (students.length === 0) return { items: [] };
  const byId = new Map(students.map((s) => [idOf(s._id), s]));
  const ids = students.map((s) => s._id);

  const [results, access] = await Promise.all([
    Result.find({ schoolId: auth.schoolId, studentId: { $in: ids }, publishedVersion: { $ne: null } }).sort({ updatedAt: -1, _id: 1 }),
    ResultAccess.find({ schoolId: auth.schoolId, studentId: { $in: ids } }),
  ]);
  const unlocked = new Set(access.map(accessKey));

  const items = results
    .filter((r) => {
      const version = r.versions.find((v) => v.number === r.publishedVersion);
      return Boolean(version) && canViewPublishedResult(byId.get(idOf(r.studentId)), version.publishedAt);
    })
    .map((r) => ({
      resultId: idOf(r._id),
      studentId: idOf(r.studentId),
      academicSessionId: idOf(r.academicSessionId),
      termId: idOf(r.termId),
      unlocked: unlocked.has(accessKey(r)),
    }));
  return { items };
}
