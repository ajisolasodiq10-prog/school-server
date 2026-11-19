import { Student } from '../../models/index.js';
import { STUDENT_STATUSES } from '../../models/Student.js';
import { byClassOrder, classInfo, col, dateRange, pageWindow, pagedSection, section, total } from './common.js';

const countStatus = (status) => ({ $sum: { $cond: [{ $eq: ['$status', status] }, 1, 0] } });

// Student numbers. The status and class filters narrow the population; a date range only
// decides what counts as "newly registered" (so the other figures stay a true headcount).
export const studentsReport = {
  key: 'students',
  title: 'Student summary',
  description: 'Total, active, inactive, transferred and graduated students, grouped by class and arm.',
  filters: ['academicSessionId', 'classId', 'arm', 'status', 'from', 'to'],
  statuses: STUDENT_STATUSES,
  async run({ auth, f }) {
    const base = { schoolId: f.schoolId, ...(f.classIds && { currentClassId: { $in: f.classIds } }), ...(f.status && { status: f.status }) };
    const range = dateRange(f);
    const registered = range
      ? { $and: [...(f.from ? [{ $gte: ['$createdAt', f.from] }] : []), ...(f.to ? [{ $lte: ['$createdAt', f.to] }] : [])] }
      : null;

    const [[counts = {}], perClass] = await Promise.all([
      Student.aggregate([
        { $match: base },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            active: countStatus('active'),
            inactive: countStatus('inactive'),
            transferred: countStatus('transferred'),
            graduated: countStatus('graduated'),
            ...(registered && { newlyRegistered: { $sum: { $cond: [registered, 1, 0] } } }),
          },
        },
      ]),
      Student.aggregate([{ $match: base }, { $group: { _id: { c: '$currentClassId', s: '$status' }, n: { $sum: 1 } } }]),
    ]);

    const info = await classInfo(f.schoolId, perClass.map((r) => r._id.c));
    const grouped = new Map();
    for (const { _id, n } of perClass) {
      const key = _id.c ? String(_id.c) : 'none';
      const row = grouped.get(key) ?? { className: 'Not in a class', arm: '-', session: '', active: 0, inactive: 0, transferred: 0, graduated: 0, total: 0 };
      if (_id.c && info.get(key)) Object.assign(row, { className: info.get(key).name, arm: info.get(key).arm, session: info.get(key).sessionName });
      row[_id.s] += n;
      row.total += n;
      grouped.set(key, row);
    }
    const rows = [...grouped.values()].sort(byClassOrder);

    return {
      totals: [
        total('total', 'Total registered students', counts.total ?? 0),
        total('active', 'Active students', counts.active ?? 0),
        total('inactive', 'Inactive students', counts.inactive ?? 0),
        total('transferred', 'Transferred students', counts.transferred ?? 0),
        total('graduated', 'Graduated students', counts.graduated ?? 0),
        ...(registered ? [total('newlyRegistered', 'Newly registered in the period', counts.newlyRegistered ?? 0)] : []),
      ],
      sections: [
        section(
          'byClass',
          'Students by class and arm',
          [col('session', 'Session'), col('className', 'Class'), col('arm', 'Arm'), col('active', 'Active'), col('inactive', 'Inactive'), col('transferred', 'Transferred'), col('graduated', 'Graduated'), col('total', 'Total')],
          rows
        ),
      ],
    };
  },
};

// A pageable list of students registered in a period. No dates of birth, contacts or
// accounts: only what is needed to recognise the student.
export const newStudentsReport = {
  key: 'new-students',
  title: 'Newly registered students',
  description: 'Students registered within a period (detail list, paginated).',
  filters: ['academicSessionId', 'classId', 'arm', 'status', 'from', 'to'],
  statuses: STUDENT_STATUSES,
  paged: true,
  async run({ f, paging }) {
    const createdAt = dateRange(f);
    const match = {
      schoolId: f.schoolId,
      ...(f.classIds && { currentClassId: { $in: f.classIds } }),
      ...(f.status && { status: f.status }),
      ...(createdAt && { createdAt }),
    };
    const { skip, limit } = pageWindow(paging);
    const [students, count] = await Promise.all([
      Student.find(match)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .select('studentId firstName middleName lastName status currentClassId admissionDate createdAt')
        .lean(),
      Student.countDocuments(match),
    ]);
    const info = await classInfo(f.schoolId, students.map((s) => s.currentClassId));
    const rows = students.map((s) => ({
      studentId: s.studentId,
      name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(' '),
      className: info.get(String(s.currentClassId))?.label ?? '',
      status: s.status,
      admissionDate: s.admissionDate,
      registeredAt: s.createdAt,
    }));
    return {
      totals: [total('total', 'Students registered', count)],
      sections: [
        pagedSection(
          'students',
          'Registered students',
          [col('studentId', 'Student ID'), col('name', 'Name'), col('className', 'Class'), col('status', 'Status'), col('admissionDate', 'Admission date'), col('registeredAt', 'Registered')],
          rows,
          count,
          paging
        ),
      ],
    };
  },
};
