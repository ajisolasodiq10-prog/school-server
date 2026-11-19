import { AuditLog, Student, User } from '../models/index.js';
import { notFound } from '../utils/AppError.js';
import { endOfRange } from '../utils/dateRange.js';
import { escapeRegex } from '../utils/search.js';
import { cut, sanitizeAuditDetails } from '../utils/auditData.js';
import { toAuditView } from '../utils/serializers.js';

// What is stored (and what never is) lives in utils/auditData.js so it can be tested without a database.
export { diffFields, pickFields, sanitizeAuditDetails } from '../utils/auditData.js';

// The audit trail. recordAudit() is called by every sensitive operation; entries are
// append-only (see models/AuditLog.js) and always carry the acting user and their school,
// both taken from the authenticated request, never from the client.

// ------------------------------------------------------------------------- writing

const entryFor = (auth, { action, entityType, entityId, studentId, summary, details }) => ({
  schoolId: auth.schoolId,
  actorId: auth.userId,
  actorRole: auth.role,
  action,
  entityType,
  entityId,
  ...(studentId && { studentId }),
  summary: cut(summary, 300),
  ...(details && { details: sanitizeAuditDetails(details) }),
});

// `session` is the MongoDB transaction session when the caller is inside one.
export async function recordAudit(auth, entry, { session } = {}) {
  const [log] = await AuditLog.create([entryFor(auth, entry)], { session });
  return log;
}

// Several entries at once (a session rollover writes one per moved student).
export async function recordAuditBatch(auth, entries, { session } = {}) {
  if (entries.length === 0) return [];
  return AuditLog.insertMany(entries.map((e) => entryFor(auth, e)), { session });
}

// ------------------------------------------------------------------------- reading

export function auditFilter(auth, { entityType, entityId, studentId, action, actorId, actorRole, from, to, q } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(entityType && { entityType }),
    ...(entityId && { entityId }),
    ...(studentId && { studentId }),
    ...(action && { action }),
    ...(actorId && { actorId }),
    ...(actorRole && { actorRole }),
  };
  if (from || to) {
    filter.createdAt = { ...(from && { $gte: from }), ...(to && { $lte: endOfRange(to) }) };
  }
  // Every word typed must appear in the description (escaped: no regular expressions from users).
  const words = (q || '').split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length > 0) filter.$and = words.map((word) => ({ summary: new RegExp(escapeRegex(word), 'i') }));
  return filter;
}

// Names for the people an entry points at, looked up in the SAME school only.
async function namesFor(auth, logs) {
  const actorIds = [...new Set(logs.map((l) => String(l.actorId)))];
  const studentIds = [...new Set(logs.filter((l) => l.studentId).map((l) => String(l.studentId)))];
  const [actors, students] = await Promise.all([
    actorIds.length ? User.find({ _id: { $in: actorIds }, schoolId: auth.schoolId }).select('fullName username') : [],
    studentIds.length ? Student.find({ _id: { $in: studentIds }, schoolId: auth.schoolId }).select('firstName middleName lastName studentId') : [],
  ]);
  return {
    actor: new Map(actors.map((u) => [String(u._id), u.fullName])),
    student: new Map(
      students.map((s) => [String(s._id), { studentId: s.studentId, name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' ') }])
    ),
  };
}

const present = (log, names) => ({
  ...toAuditView(log),
  actorName: names.actor.get(String(log.actorId)) ?? null,
  student: log.studentId ? (names.student.get(String(log.studentId)) ?? null) : null,
});

export async function listAuditLogs(auth, { page = 1, limit = 20, ...filters } = {}) {
  const filter = auditFilter(auth, filters);
  const [logs, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AuditLog.countDocuments(filter),
  ]);
  const names = await namesFor(auth, logs);
  return { items: logs.map((log) => present(log, names)), page, limit, total };
}

export async function getAuditLog(auth, id) {
  const log = await AuditLog.findOne({ _id: id, schoolId: auth.schoolId });
  if (!log) throw notFound('Audit entry not found.'); // same answer for another school's entry
  return present(log, await namesFor(auth, [log]));
}

// The values a filter box can offer: the actions and record types this school has logged.
export async function auditFacets(auth) {
  const [actions, entityTypes] = await Promise.all([
    AuditLog.distinct('action', { schoolId: auth.schoolId }),
    AuditLog.distinct('entityType', { schoolId: auth.schoolId }),
  ]);
  return { actions: actions.sort(), entityTypes: entityTypes.sort() };
}
