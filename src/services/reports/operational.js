import { AcademicSession, Announcement, Assignment, ResultPin, Student, Subject } from '../../models/index.js';
import { ANNOUNCEMENT_STATUSES } from '../../models/Announcement.js';
import { ASSIGNMENT_STATUSES } from '../../models/Assignment.js';
import { PIN_STATUSES } from '../../models/ResultPin.js';
import { byClassOrder, classInfo, col, dateRange, pageWindow, pagedSection, section, total } from './common.js';

const flag = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });

// ---------------------------------------------------------------- assignments
export const assignmentsReport = {
  key: 'assignments',
  title: 'Assignments created',
  description: 'Assignments created in a period, by status, class and subject.',
  filters: ['academicSessionId', 'classId', 'arm', 'subjectId', 'status', 'from', 'to'],
  statuses: ASSIGNMENT_STATUSES,
  async run({ f }) {
    const createdAt = dateRange(f);
    const match = {
      schoolId: f.schoolId,
      ...(f.sessionId && { academicSessionId: f.sessionId }),
      ...(f.classIds && { classId: { $in: f.classIds } }),
      ...(f.subjectId && { subjectId: f.subjectId }),
      ...(f.status && { status: f.status }),
      ...(createdAt && { createdAt }),
    };
    const [facets] = await Assignment.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [{ $group: { _id: null, n: { $sum: 1 }, active: flag({ $eq: ['$status', 'active'] }), completed: flag({ $eq: ['$status', 'completed'] }), cancelled: flag({ $eq: ['$status', 'cancelled'] }), removed: flag({ $eq: ['$status', 'removed'] }) } }],
          byClass: [{ $group: { _id: '$classId', n: { $sum: 1 } } }],
          bySubject: [{ $group: { _id: '$subjectId', n: { $sum: 1 } } }],
        },
      },
    ]);
    const t = facets.totals[0] ?? { n: 0, active: 0, completed: 0, cancelled: 0, removed: 0 };
    const info = await classInfo(f.schoolId, facets.byClass.map((r) => r._id));
    const classRows = facets.byClass
      .map((r) => ({ session: info.get(String(r._id))?.sessionName ?? '', className: info.get(String(r._id))?.name ?? '?', arm: info.get(String(r._id))?.arm ?? '', assignments: r.n }))
      .sort(byClassOrder);
    const subjects = await Subject.find({ _id: { $in: facets.bySubject.map((r) => r._id) }, schoolId: f.schoolId }).select('name code').lean();
    const names = new Map(subjects.map((s) => [String(s._id), s]));
    const subjectRows = facets.bySubject
      .map((r) => ({ code: names.get(String(r._id))?.code ?? '?', subject: names.get(String(r._id))?.name ?? '?', assignments: r.n }))
      .sort((a, b) => a.subject.localeCompare(b.subject));
    return {
      totals: [total('created', 'Assignments created', t.n), total('active', 'Active', t.active), total('completed', 'Completed', t.completed), total('cancelled', 'Cancelled', t.cancelled), total('removed', 'Removed', t.removed)],
      sections: [
        section('byClass', 'Assignments by class', [col('session', 'Session'), col('className', 'Class'), col('arm', 'Arm'), col('assignments', 'Assignments')], classRows),
        section('bySubject', 'Assignments by subject', [col('code', 'Code'), col('subject', 'Subject'), col('assignments', 'Assignments')], subjectRows),
      ],
    };
  },
};

// ---------------------------------------------------------------- announcements
export const announcementsReport = {
  key: 'announcements',
  title: 'Announcements',
  description: 'Published announcements (or another status) by audience and category, with a paginated list.',
  filters: ['status', 'from', 'to'],
  statuses: ANNOUNCEMENT_STATUSES,
  paged: true,
  async run({ f, paging }) {
    const status = f.status ?? 'published';
    const range = dateRange(f);
    const dateField = status === 'published' ? 'publishedAt' : 'createdAt'; // drafts have no publication date
    const match = { schoolId: f.schoolId, status, ...(range && { [dateField]: range }) };
    const { skip, limit } = pageWindow(paging);
    const [matrix, items, count] = await Promise.all([
      Announcement.aggregate([{ $match: match }, { $group: { _id: { a: '$audience', c: '$category' }, n: { $sum: 1 } } }]),
      Announcement.find(match).sort({ [dateField]: -1, _id: -1 }).skip(skip).limit(limit).select('title audience category status publishedAt createdAt').lean(),
      Announcement.countDocuments(match),
    ]);
    const audienceRows = matrix.map((r) => ({ audience: r._id.a, category: r._id.c, announcements: r.n })).sort((a, b) => a.audience.localeCompare(b.audience) || a.category.localeCompare(b.category));
    const rows = items.map((a) => ({ title: a.title, audience: a.audience, category: a.category, status: a.status, date: a.publishedAt ?? a.createdAt }));
    return {
      totals: [total('count', `Announcements (${status})`, count)],
      sections: [
        section('byAudience', 'By audience and category', [col('audience', 'Audience'), col('category', 'Category'), col('announcements', 'Announcements')], audienceRows),
        pagedSection('announcements', 'Announcement list', [col('title', 'Title'), col('audience', 'Audience'), col('category', 'Category'), col('status', 'Status'), col('date', status === 'published' ? 'Published' : 'Created')], rows, count, paging),
      ],
    };
  },
};

// ---------------------------------------------------------------- result PINs
// Counts only. The PIN hash, salt and any PIN value are never read into the output.
export const pinsReport = {
  key: 'pins',
  title: 'Result PIN statistics',
  description: 'PINs generated, redeemed, unused and revoked, by term (counts only; no PIN values).',
  filters: ['academicSessionId', 'termId', 'classId', 'arm', 'status', 'from', 'to'],
  statuses: PIN_STATUSES,
  async run({ f }) {
    const createdAt = dateRange(f);
    const match = {
      schoolId: f.schoolId,
      ...(f.sessionId && { academicSessionId: f.sessionId }),
      ...(f.termId && { termId: f.termId }),
      ...(f.status && { status: f.status }),
      ...(createdAt && { createdAt }),
    };
    const rows = await ResultPin.aggregate([
      { $match: match },
      // The student's class is only needed (and only looked up) when filtering by class.
      ...(f.classIds
        ? [
            { $lookup: { from: Student.collection.name, localField: 'studentId', foreignField: '_id', as: 's' } },
            { $match: { 's.schoolId': f.schoolId, 's.currentClassId': { $in: f.classIds } } },
          ]
        : []),
      { $group: { _id: { s: '$academicSessionId', t: '$termId' }, generated: { $sum: 1 }, redeemed: flag({ $eq: ['$status', 'redeemed'] }), unused: flag({ $eq: ['$status', 'active'] }), revoked: flag({ $eq: ['$status', 'revoked'] }) } },
    ]);
    const sessions = await AcademicSession.find({ _id: { $in: rows.map((r) => r._id.s) }, schoolId: f.schoolId }).select('name startDate terms').lean();
    const bySession = new Map(sessions.map((s) => [String(s._id), s]));
    const termName = new Map(sessions.flatMap((s) => s.terms.map((t) => [String(t._id), t.name])));
    const out = rows
      .map((r) => ({
        start: String(bySession.get(String(r._id.s))?.startDate ?? ''),
        session: bySession.get(String(r._id.s))?.name ?? '?',
        term: termName.get(String(r._id.t)) ?? '?',
        generated: r.generated,
        redeemed: r.redeemed,
        unused: r.unused,
        revoked: r.revoked,
      }))
      .sort((a, b) => b.start.localeCompare(a.start) || a.term.localeCompare(b.term));
    const sum = (key) => out.reduce((n, r) => n + r[key], 0);
    return {
      totals: [total('generated', 'PINs generated', sum('generated')), total('redeemed', 'Redeemed', sum('redeemed')), total('unused', 'Unused (not yet redeemed or revoked)', sum('unused')), total('revoked', 'Revoked', sum('revoked'))],
      sections: [section('byTerm', 'PINs by session and term', [col('session', 'Session'), col('term', 'Term'), col('generated', 'Generated'), col('redeemed', 'Redeemed'), col('unused', 'Unused'), col('revoked', 'Revoked')], out.map(({ start, ...r }) => r))],
    };
  },
};
