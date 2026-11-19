import { AcademicSession, Result } from '../../models/index.js';
import { RESULT_STATUSES } from '../../models/Result.js';
import { byClassOrder, classInfo, col, dateRange, percent, section, total } from './common.js';

const flag = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const is = (field, value) => ({ $eq: [field, value] });

// Where results stand in the workflow. COUNTS ONLY: no student, subject, score or remark ever
// leaves this report, so it cannot be used to read anyone's results.
//
// Each result is placed in exactly one bucket, by its status:
//   draft              a new draft the teacher is still writing
//   awaitingCorrection a draft the administrator returned, or a correction of a recalled result
//   submitted          sent for review = awaiting approval
//   approved           approved, awaiting publication
//   published          live for students and parents
//   recalled           taken back after publication
export const resultsReport = {
  key: 'results',
  title: 'Result workflow summary',
  description: 'How many results are in each workflow stage, and publication progress by class and term (counts only).',
  filters: ['academicSessionId', 'termId', 'classId', 'arm', 'status', 'from', 'to'],
  statuses: RESULT_STATUSES,
  async run({ f }) {
    const updatedAt = dateRange(f);
    const match = {
      schoolId: f.schoolId,
      ...(f.sessionId && { academicSessionId: f.sessionId }),
      ...(f.termId && { termId: f.termId }),
      ...(f.classIds && { classId: { $in: f.classIds } }),
      ...(f.status && { status: f.status }),
      ...(updatedAt && { updatedAt }),
    };
    // A draft is "awaiting correction" when its newest version was returned or is a correction.
    const returnedOrCorrection = {
      $let: {
        vars: { v: { $arrayElemAt: ['$versions', { $subtract: ['$currentVersion', 1] }] } },
        in: { $or: [{ $ne: [{ $ifNull: ['$$v.returnedAt', null] }, null] }, { $ne: [{ $ifNull: ['$$v.correctionOf', null] }, null] }] },
      },
    };
    const bucket = {
      draft: flag({ $and: [is('$status', 'draft'), is('$flagged', false)] }),
      awaitingCorrection: flag({ $and: [is('$status', 'draft'), is('$flagged', true)] }),
      submitted: flag(is('$status', 'submitted')),
      approved: flag(is('$status', 'approved')),
      published: flag(is('$status', 'published')),
      recalled: flag(is('$status', 'recalled')),
    };

    const [facets] = await Result.aggregate([
      { $match: match },
      { $project: { status: 1, classId: 1, academicSessionId: 1, termId: 1, flagged: returnedOrCorrection } }, // no scores leave this stage
      {
        $facet: {
          totals: [{ $group: { _id: null, results: { $sum: 1 }, ...bucket } }],
          progress: [{ $group: { _id: { s: '$academicSessionId', t: '$termId', c: '$classId' }, results: { $sum: 1 }, ...bucket } }],
        },
      },
    ]);
    const t = facets.totals[0] ?? { results: 0, draft: 0, awaitingCorrection: 0, submitted: 0, approved: 0, published: 0, recalled: 0 };

    const info = await classInfo(f.schoolId, facets.progress.map((r) => r._id.c));
    const sessions = await AcademicSession.find({ _id: { $in: facets.progress.map((r) => r._id.s) }, schoolId: f.schoolId }).select('name terms').lean();
    const termName = new Map(sessions.flatMap((s) => s.terms.map((term) => [String(term._id), term.name])));
    const rows = facets.progress
      .map((r) => ({
        session: info.get(String(r._id.c))?.sessionName ?? '',
        term: termName.get(String(r._id.t)) ?? '?',
        className: info.get(String(r._id.c))?.name ?? '?',
        arm: info.get(String(r._id.c))?.arm ?? '',
        results: r.results,
        draft: r.draft,
        awaitingCorrection: r.awaitingCorrection,
        submitted: r.submitted,
        approved: r.approved,
        published: r.published,
        recalled: r.recalled,
        publishedPercent: percent(r.published, r.results),
      }))
      .sort((a, b) => byClassOrder(a, b) || a.term.localeCompare(b.term));

    return {
      totals: [
        total('results', 'Results recorded', t.results),
        total('draft', 'In draft', t.draft),
        total('submittedForReview', 'Submitted for review (submitted or approved)', t.submitted + t.approved),
        total('awaitingApproval', 'Awaiting approval', t.submitted),
        total('approved', 'Approved, awaiting publication', t.approved),
        total('published', 'Published', t.published),
        total('recalled', 'Recalled', t.recalled),
        total('awaitingCorrection', 'Awaiting correction (returned or being corrected)', t.awaitingCorrection),
        total('publishedPercent', 'Published (% of results recorded)', percent(t.published, t.results)),
      ],
      sections: [
        section(
          'progress',
          'Publication progress by class and term',
          [col('session', 'Session'), col('term', 'Term'), col('className', 'Class'), col('arm', 'Arm'), col('results', 'Results'), col('draft', 'Draft'), col('awaitingCorrection', 'Awaiting correction'), col('submitted', 'Awaiting approval'), col('approved', 'Approved'), col('published', 'Published'), col('recalled', 'Recalled'), col('publishedPercent', 'Published %')],
          rows
        ),
      ],
    };
  },
};
