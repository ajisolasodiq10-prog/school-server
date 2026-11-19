import mongoose from 'mongoose';
import { AcademicSession, Class, Subject } from '../../models/index.js';
import { badRequest, notFound } from '../../utils/AppError.js';
import { endOfRange } from '../../utils/dateRange.js';

// Shared pieces for the report modules: filter checking, ids for aggregation pipelines,
// class/session labels and the small helpers that shape a report.
//
// Every report works for ONE school: schoolId comes from the authenticated administrator
// (never from the request), and every id a filter names must belong to that school or the
// answer is 404, exactly as in the rest of the API.

// Aggregation pipelines are NOT cast by Mongoose, so ids must be real ObjectIds.
export const oid = (value) => (value instanceof mongoose.Types.ObjectId ? value : new mongoose.Types.ObjectId(String(value)));

export const EXPORT_MAX_ROWS = 10000;

export const col = (key, label) => ({ key, label });
export const total = (key, label, value) => ({ key, label, value });
export const section = (key, title, columns, rows, extra = {}) => ({ key, title, columns, rows, ...extra });
export const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

// skip/limit for a paged detail list; `all` (exports) takes everything up to a hard cap.
export function pageWindow(paging) {
  if (paging.all) return { skip: 0, limit: EXPORT_MAX_ROWS };
  return { skip: (paging.page - 1) * paging.limit, limit: paging.limit };
}

export const pagedSection = (key, title, columns, rows, totalRows, paging) =>
  section(key, title, columns, rows, {
    total: totalRows,
    ...(paging.all ? { truncated: totalRows > rows.length } : { page: paging.page, limit: paging.limit }),
  });

// Checks the filters a report was given against what that report supports, and against the
// school's own data. Returns what the report modules need, already as ObjectIds.
export async function resolveFilters(auth, def, query) {
  const given = Object.keys(query).filter((k) => query[k] !== undefined && !['page', 'limit', 'format'].includes(k));
  const unsupported = given.filter((k) => !def.filters.includes(k));
  if (unsupported.length > 0) {
    throw badRequest(
      `The ${def.key} report does not use these filters: ${unsupported.join(', ')}. ` +
        `It supports: ${def.filters.join(', ') || 'none'}.`,
      { code: 'UNSUPPORTED_FILTER', details: unsupported.map((field) => ({ field, message: 'does not apply to this report' })) }
    );
  }
  if (query.status && def.statuses && !def.statuses.includes(query.status)) {
    throw badRequest('That status does not apply to this report.', {
      code: 'VALIDATION_ERROR',
      details: [{ field: 'status', message: `must be one of: ${def.statuses.join(', ')}` }],
    });
  }
  const to = query.to ? endOfRange(query.to) : undefined;
  if (query.from && to && query.from > to) {
    throw badRequest('"from" cannot be after "to".', { code: 'VALIDATION_ERROR', details: [{ field: 'from', message: 'must not be after to' }] });
  }

  const schoolId = oid(auth.schoolId);
  const echo = {};

  let session = null;
  if (query.academicSessionId) {
    session = await AcademicSession.findOne({ _id: query.academicSessionId, schoolId }).select('name terms');
    if (!session) throw notFound('Academic session not found.');
    echo.academicSession = session.name;
  }
  let termId;
  if (query.termId) {
    const owner = session ?? (await AcademicSession.findOne({ schoolId, 'terms._id': query.termId }).select('name terms'));
    const term = owner?.terms.id(query.termId);
    if (!term) throw notFound('Term not found.');
    termId = oid(term._id);
    echo.term = `${term.name} (${owner.name})`;
  }
  let klass = null;
  if (query.classId) {
    klass = await Class.findOne({ _id: query.classId, schoolId }).select('name arm academicSessionId');
    if (!klass) throw notFound('Class not found.');
    if (session && String(klass.academicSessionId) !== String(session._id)) {
      throw badRequest('That class does not belong to the chosen academic session.', {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'classId', message: 'is not in the chosen academic session' }],
      });
    }
    echo.class = `${klass.name}${klass.arm}`;
  }
  let subjectId;
  if (query.subjectId) {
    const subject = await Subject.findOne({ _id: query.subjectId, schoolId }).select('name');
    if (!subject) throw notFound('Subject not found.');
    subjectId = oid(subject._id);
    echo.subject = subject.name;
  }
  if (query.arm) echo.arm = query.arm;
  if (query.status) echo.status = query.status;
  if (query.from) echo.from = query.from.toISOString().slice(0, 10);
  if (query.to) echo.to = query.to.toISOString().slice(0, 10);

  // Classes that match session / class / arm, for reports about students, teachers, results...
  let classIds = null;
  if (session || klass || query.arm) {
    const found = await Class.find({
      schoolId,
      ...(session && { academicSessionId: session._id }),
      ...(klass && { _id: klass._id }),
      ...(query.arm && { arm: query.arm }),
    })
      .select('_id')
      .lean();
    classIds = found.map((c) => c._id);
  }

  return {
    schoolId,
    sessionId: session ? oid(session._id) : null,
    termId,
    classIds,
    subjectId,
    status: query.status,
    from: query.from,
    to,
    echo,
  };
}

// {$gte, $lte} for a date field, or undefined when no range was given.
export const dateRange = (f) => (f.from || f.to ? { ...(f.from && { $gte: f.from }), ...(f.to && { $lte: f.to }) } : undefined);

// class id -> { name, arm, label, status, sessionId, sessionName }
export async function classInfo(schoolId, ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  if (unique.length === 0) return new Map();
  const classes = await Class.find({ _id: { $in: unique }, schoolId }).select('name arm status academicSessionId').lean();
  const sessions = await AcademicSession.find({ _id: { $in: classes.map((c) => c.academicSessionId) }, schoolId }).select('name').lean();
  const names = new Map(sessions.map((s) => [String(s._id), s.name]));
  return new Map(
    classes.map((c) => [
      String(c._id),
      {
        id: String(c._id),
        name: c.name,
        arm: c.arm,
        label: `${c.name}${c.arm}`,
        status: c.status,
        sessionId: String(c.academicSessionId),
        sessionName: names.get(String(c.academicSessionId)) ?? '',
      },
    ])
  );
}

export const byClassOrder = (a, b) =>
  b.session.localeCompare(a.session) || a.className.localeCompare(b.className, 'en', { numeric: true }) || a.arm.localeCompare(b.arm);

export const sumOf = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
