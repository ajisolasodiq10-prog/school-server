import { AcademicSession, Class, PromotionDecision, Result, Student, Subject, Teacher } from '../../models/index.js';
import { CLASS_STATUSES } from '../../models/Class.js';
import { PROMOTION_STATUSES } from '../../models/PromotionDecision.js';
import { SESSION_STATUSES } from '../../models/AcademicSession.js';
import { badRequest } from '../../utils/AppError.js';
import { byClassOrder, classInfo, col, oid, pageWindow, pagedSection, percent, section, total } from './common.js';

const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);

// ---------------------------------------------------------------- enrolment by session
export const enrolmentReport = {
  key: 'enrolment',
  title: 'Student enrolment by academic session',
  description: 'How many different students were placed in a class of each academic session (past and present).',
  filters: ['academicSessionId', 'classId', 'arm', 'status'],
  statuses: ['active', 'inactive', 'graduated', 'transferred'],
  async run({ f }) {
    const rows = await Student.aggregate([
      { $match: { schoolId: f.schoolId, ...(f.status && { status: f.status }) } },
      { $project: { 'classHistory.classId': 1 } },
      { $unwind: '$classHistory' },
      ...(f.classIds ? [{ $match: { 'classHistory.classId': { $in: f.classIds } } }] : []),
      { $lookup: { from: Class.collection.name, localField: 'classHistory.classId', foreignField: '_id', as: 'c' } },
      { $unwind: '$c' },
      { $match: { 'c.schoolId': f.schoolId } },
      { $group: { _id: { s: '$c.academicSessionId', st: '$_id' } } }, // each student once per session
      { $group: { _id: '$_id.s', students: { $sum: 1 } } },
    ]).allowDiskUse(true);

    const sessions = await AcademicSession.find({ _id: { $in: rows.map((r) => r._id) }, schoolId: f.schoolId }).select('name status startDate').lean();
    const bySession = new Map(sessions.map((s) => [String(s._id), s]));
    const out = rows
      .map((r) => ({ session: bySession.get(String(r._id))?.name ?? '?', status: bySession.get(String(r._id))?.status ?? '', startDate: bySession.get(String(r._id))?.startDate, students: r.students }))
      .sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)));
    return {
      totals: [total('sessions', 'Sessions with enrolled students', out.length)],
      sections: [section('bySession', 'Enrolled students per session', [col('session', 'Session'), col('status', 'Session status'), col('students', 'Students enrolled')], out.map(({ startDate, ...r }) => r))],
    };
  },
};

// ---------------------------------------------------------------- population by class
export const populationReport = {
  key: 'population',
  title: 'Student population by class',
  description: 'Students in every class, including classes that are still empty.',
  filters: ['academicSessionId', 'classId', 'arm', 'status'],
  statuses: CLASS_STATUSES,
  async run({ f }) {
    const classes = await Class.find({ schoolId: f.schoolId, ...(f.classIds && { _id: { $in: f.classIds } }), ...(f.status && { status: f.status }) })
      .select('name arm status academicSessionId')
      .lean();
    const counts = await Student.aggregate([
      { $match: { schoolId: f.schoolId, currentClassId: { $in: classes.map((c) => c._id) } } },
      { $group: { _id: { c: '$currentClassId', s: '$status' }, n: { $sum: 1 } } },
    ]);
    const perClass = new Map();
    for (const { _id, n } of counts) {
      const row = perClass.get(String(_id.c)) ?? { active: 0, all: 0 };
      if (_id.s === 'active') row.active += n;
      row.all += n;
      perClass.set(String(_id.c), row);
    }
    const info = await classInfo(f.schoolId, classes.map((c) => c._id));
    const rows = classes
      .map((c) => ({
        session: info.get(String(c._id))?.sessionName ?? '',
        className: c.name,
        arm: c.arm,
        classStatus: c.status,
        active: perClass.get(String(c._id))?.active ?? 0,
        total: perClass.get(String(c._id))?.all ?? 0,
      }))
      .sort(byClassOrder);
    return {
      totals: [total('classes', 'Classes', rows.length), total('active', 'Active students in these classes', sum(rows, 'active')), total('students', 'All students in these classes', sum(rows, 'total'))],
      sections: [section('byClass', 'Students per class', [col('session', 'Session'), col('className', 'Class'), col('arm', 'Arm'), col('classStatus', 'Class status'), col('active', 'Active students'), col('total', 'All students')], rows)],
    };
  },
};

// ---------------------------------------------------------------- class and subject distribution
export const distributionReport = {
  key: 'distribution',
  title: 'Class and subject distribution',
  description: 'Subjects offered in each class, classes offering each subject and active teachers for both.',
  filters: ['academicSessionId', 'classId', 'arm', 'subjectId', 'status'],
  statuses: CLASS_STATUSES,
  async run({ f }) {
    const classes = await Class.find({
      schoolId: f.schoolId,
      ...(f.classIds && { _id: { $in: f.classIds } }),
      ...(f.status && { status: f.status }),
      ...(f.subjectId && { subjectIds: f.subjectId }),
    })
      .select('name arm status academicSessionId subjectIds')
      .lean();
    const classIds = classes.map((c) => c._id);
    const active = { schoolId: f.schoolId, employmentStatus: 'active' };
    const [teachersPerClass, teachersPerSubject] = await Promise.all([
      Teacher.aggregate([{ $match: { ...active, classIds: { $in: classIds } } }, { $unwind: '$classIds' }, { $match: { classIds: { $in: classIds } } }, { $group: { _id: '$classIds', n: { $sum: 1 } } }]),
      Teacher.aggregate([{ $match: active }, { $unwind: '$subjectIds' }, ...(f.subjectId ? [{ $match: { subjectIds: f.subjectId } }] : []), { $group: { _id: '$subjectIds', n: { $sum: 1 } } }]),
    ]);
    const tClass = new Map(teachersPerClass.map((r) => [String(r._id), r.n]));
    const tSubject = new Map(teachersPerSubject.map((r) => [String(r._id), r.n]));

    const info = await classInfo(f.schoolId, classIds);
    const classRows = classes
      .map((c) => ({
        session: info.get(String(c._id))?.sessionName ?? '',
        className: c.name,
        arm: c.arm,
        classStatus: c.status,
        subjects: c.subjectIds.length,
        teachers: tClass.get(String(c._id)) ?? 0,
      }))
      .sort(byClassOrder);

    const offered = new Map();
    for (const c of classes) for (const id of c.subjectIds) offered.set(String(id), (offered.get(String(id)) ?? 0) + 1);
    const subjects = await Subject.find({ schoolId: f.schoolId, _id: f.subjectId ? f.subjectId : { $in: [...offered.keys()] } }).select('name code status').lean();
    const subjectRows = subjects
      .map((s) => ({ code: s.code, subject: s.name, subjectStatus: s.status, classes: offered.get(String(s._id)) ?? 0, teachers: tSubject.get(String(s._id)) ?? 0 }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    return {
      totals: [total('classes', 'Classes', classRows.length), total('subjects', 'Subjects offered', subjectRows.length)],
      sections: [
        section('classes', 'Subjects and teachers per class', [col('session', 'Session'), col('className', 'Class'), col('arm', 'Arm'), col('classStatus', 'Class status'), col('subjects', 'Subjects'), col('teachers', 'Active teachers')], classRows),
        section('subjects', 'Classes and teachers per subject', [col('code', 'Code'), col('subject', 'Subject'), col('subjectStatus', 'Status'), col('classes', 'Classes'), col('teachers', 'Active teachers')], subjectRows),
      ],
    };
  },
};

// ---------------------------------------------------------------- promotion statistics
const flag = (condition) => ({ $sum: { $cond: [condition, 1, 0] } });
const PD = ['promoted', 'repeated'];

export const promotionReport = {
  key: 'promotion',
  title: 'Promotion and repetition statistics',
  description: 'Teacher recommendations, administrator decisions and how many have been applied by a new session.',
  filters: ['academicSessionId', 'classId', 'arm', 'status'],
  statuses: PROMOTION_STATUSES,
  async run({ f }) {
    const match = {
      schoolId: f.schoolId,
      ...(f.sessionId && { academicSessionId: f.sessionId }),
      ...(f.classIds && { classId: { $in: f.classIds } }),
      ...(f.status && { status: f.status }),
    };
    const groups = await PromotionDecision.aggregate([
      { $match: match },
      {
        $group: {
          _id: { s: '$academicSessionId', c: '$classId' },
          recommended: flag({ $in: ['$recommendation', PD] }),
          confirmed: flag({ $eq: ['$status', 'confirmed'] }),
          promoted: flag({ $eq: ['$decision', 'promoted'] }),
          repeated: flag({ $eq: ['$decision', 'repeated'] }),
          overridden: flag({ $and: [{ $eq: ['$status', 'confirmed'] }, { $in: ['$recommendation', PD] }, { $ne: ['$recommendation', '$decision'] }] }),
          applied: flag({ $eq: [{ $type: '$appliedAt' }, 'date'] }),
        },
      },
    ]);
    const info = await classInfo(f.schoolId, groups.map((g) => g._id.c));
    const rows = groups
      .map((g) => ({
        session: info.get(String(g._id.c))?.sessionName ?? '',
        className: info.get(String(g._id.c))?.name ?? '?',
        arm: info.get(String(g._id.c))?.arm ?? '',
        recommended: g.recommended,
        confirmed: g.confirmed,
        promoted: g.promoted,
        repeated: g.repeated,
        overridden: g.overridden,
        applied: g.applied,
      }))
      .sort(byClassOrder);
    const promoted = sum(rows, 'promoted');
    const repeated = sum(rows, 'repeated');
    return {
      totals: [
        total('recommended', 'Teacher recommendations', sum(rows, 'recommended')),
        total('confirmed', 'Administrator decisions', sum(rows, 'confirmed')),
        total('promoted', 'Promoted', promoted),
        total('repeated', 'Repeated', repeated),
        total('repeatRate', 'Repetition rate (% of decisions)', percent(repeated, promoted + repeated)),
        total('overridden', 'Recommendations changed by the administrator', sum(rows, 'overridden')),
        total('applied', 'Decisions already applied by a new session', sum(rows, 'applied')),
      ],
      sections: [
        section('byClass', 'Decisions by class', [col('session', 'Session'), col('className', 'Class'), col('arm', 'Arm'), col('recommended', 'Recommended'), col('confirmed', 'Confirmed'), col('promoted', 'Promoted'), col('repeated', 'Repeated'), col('overridden', 'Changed'), col('applied', 'Applied')], rows),
      ],
    };
  },
};

// ---------------------------------------------------------------- awaiting a decision
export const awaitingPromotionReport = {
  key: 'awaiting-promotion',
  title: 'Students awaiting promotion decisions',
  description: 'Active students of a session whose promotion has not been confirmed yet (defaults to the current session).',
  filters: ['academicSessionId', 'classId', 'arm'],
  paged: true,
  async run({ auth, f, paging }) {
    let sessionId = f.sessionId;
    let sessionName = f.echo.academicSession;
    if (!sessionId) {
      const current = await AcademicSession.findOne({ schoolId: f.schoolId, isCurrent: true }).select('name').lean();
      if (!current) throw badRequest('There is no current academic session. Choose an academicSessionId.', { code: 'NO_CURRENT_SESSION' });
      sessionId = oid(current._id);
      sessionName = current.name;
      f.echo.academicSession = `${current.name} (current)`;
    }
    const classes = await Class.find({ schoolId: f.schoolId, academicSessionId: sessionId, ...(f.classIds && { _id: { $in: f.classIds } }) }).select('_id').lean();
    const { skip, limit } = pageWindow(paging);

    const [facets] = await Student.aggregate([
      { $match: { schoolId: f.schoolId, status: 'active', currentClassId: { $in: classes.map((c) => c._id) } } },
      {
        $lookup: {
          from: PromotionDecision.collection.name,
          let: { sid: '$_id' },
          pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$studentId', '$$sid'] }, { $eq: ['$academicSessionId', sessionId] }] } } }, { $limit: 1 }, { $project: { status: 1, recommendation: 1 } }],
          as: 'd',
        },
      },
      { $match: { 'd.0.status': { $ne: 'confirmed' } } },
      {
        $facet: {
          rows: [
            { $sort: { lastName: 1, firstName: 1, _id: 1 } },
            { $skip: skip },
            { $limit: limit },
            { $project: { studentId: 1, firstName: 1, middleName: 1, lastName: 1, currentClassId: 1, recommendation: { $arrayElemAt: ['$d.recommendation', 0] } } },
          ],
          perClass: [{ $group: { _id: '$currentClassId', n: { $sum: 1 }, recommended: { $sum: { $cond: [{ $in: [{ $arrayElemAt: ['$d.recommendation', 0] }, PD] }, 1, 0] } } } }],
        },
      },
    ]);
    const info = await classInfo(f.schoolId, [...facets.rows.map((r) => r.currentClassId), ...facets.perClass.map((r) => r._id)]);
    const waiting = sum(facets.perClass, 'n');
    const withRecommendation = sum(facets.perClass, 'recommended');

    const rows = facets.rows.map((s) => ({
      studentId: s.studentId,
      name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '),
      className: info.get(String(s.currentClassId))?.label ?? '',
      recommendation: s.recommendation ?? 'none yet',
    }));
    const perClass = facets.perClass
      .map((r) => ({ session: sessionName ?? '', className: info.get(String(r._id))?.name ?? '?', arm: info.get(String(r._id))?.arm ?? '', waiting: r.n, withRecommendation: r.recommended }))
      .sort(byClassOrder);
    return {
      totals: [total('awaiting', 'Students awaiting a decision', waiting), total('withRecommendation', 'Of these, with a teacher recommendation', withRecommendation), total('withoutRecommendation', 'Of these, with no recommendation yet', waiting - withRecommendation)],
      sections: [
        section('byClass', 'Awaiting decision by class', [col('className', 'Class'), col('arm', 'Arm'), col('waiting', 'Students waiting'), col('withRecommendation', 'With recommendation')], perClass),
        pagedSection('students', 'Students awaiting a decision', [col('studentId', 'Student ID'), col('name', 'Name'), col('className', 'Class'), col('recommendation', 'Teacher recommendation')], rows, waiting, paging),
      ],
    };
  },
};

// ---------------------------------------------------------------- session and term summaries
export const sessionsReport = {
  key: 'sessions',
  title: 'Academic session and term summary',
  description: 'Sessions and their terms with status, dates, class counts, active students and result publication counts.',
  filters: ['academicSessionId', 'status'],
  statuses: SESSION_STATUSES,
  async run({ f }) {
    const sessions = await AcademicSession.find({ schoolId: f.schoolId, ...(f.sessionId && { _id: f.sessionId }), ...(f.status && { status: f.status }) })
      .sort({ startDate: -1 })
      .lean();
    const ids = sessions.map((s) => s._id);
    const [classCounts, classes, studentCounts, resultCounts] = await Promise.all([
      Class.aggregate([{ $match: { schoolId: f.schoolId, academicSessionId: { $in: ids } } }, { $group: { _id: '$academicSessionId', n: { $sum: 1 } } }]),
      Class.find({ schoolId: f.schoolId, academicSessionId: { $in: ids } }).select('academicSessionId').lean(),
      Student.aggregate([{ $match: { schoolId: f.schoolId, status: 'active', currentClassId: { $ne: null } } }, { $group: { _id: '$currentClassId', n: { $sum: 1 } } }]),
      Result.aggregate([
        { $match: { schoolId: f.schoolId, academicSessionId: { $in: ids } } },
        { $group: { _id: { s: '$academicSessionId', t: '$termId' }, results: { $sum: 1 }, published: flag({ $eq: ['$status', 'published'] }) } },
      ]),
    ]);
    const classesIn = new Map(classCounts.map((r) => [String(r._id), r.n]));
    const sessionOfClass = new Map(classes.map((c) => [String(c._id), String(c.academicSessionId)]));
    const studentsIn = new Map();
    for (const r of studentCounts) {
      const s = sessionOfClass.get(String(r._id));
      if (s) studentsIn.set(s, (studentsIn.get(s) ?? 0) + r.n);
    }
    const results = new Map(resultCounts.map((r) => [`${r._id.s}|${r._id.t}`, r]));
    const day = (d) => (d ? d.toISOString().slice(0, 10) : '');

    const sessionRows = sessions.map((s) => ({
      session: s.name,
      status: s.status,
      current: s.isCurrent ? 'yes' : 'no',
      startDate: day(s.startDate),
      endDate: day(s.endDate),
      terms: s.terms.length,
      classes: classesIn.get(String(s._id)) ?? 0,
      activeStudents: studentsIn.get(String(s._id)) ?? 0,
    }));
    const termRows = sessions.flatMap((s) =>
      s.terms.map((t) => ({
        session: s.name,
        term: t.name,
        status: t.status,
        current: t.isCurrent ? 'yes' : 'no',
        startDate: day(t.startDate),
        endDate: day(t.endDate),
        results: results.get(`${s._id}|${t._id}`)?.results ?? 0,
        published: results.get(`${s._id}|${t._id}`)?.published ?? 0,
      }))
    );
    return {
      totals: [total('sessions', 'Sessions', sessionRows.length), total('terms', 'Terms', termRows.length)],
      sections: [
        section('sessions', 'Sessions', [col('session', 'Session'), col('status', 'Status'), col('current', 'Current'), col('startDate', 'Starts'), col('endDate', 'Ends'), col('terms', 'Terms'), col('classes', 'Classes'), col('activeStudents', 'Active students')], sessionRows),
        section('terms', 'Terms', [col('session', 'Session'), col('term', 'Term'), col('status', 'Status'), col('current', 'Current'), col('startDate', 'Starts'), col('endDate', 'Ends'), col('results', 'Results recorded'), col('published', 'Results published')], termRows),
      ],
    };
  },
};
