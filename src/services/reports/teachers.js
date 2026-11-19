import { Subject, Teacher } from '../../models/index.js';
import { EMPLOYMENT_STATUSES } from '../../models/Teacher.js';
import { byClassOrder, classInfo, col, section, total } from './common.js';

export const teachersReport = {
  key: 'teachers',
  title: 'Teacher summary',
  description: 'Teachers by employment status, and how many teach each class and subject.',
  filters: ['academicSessionId', 'classId', 'arm', 'subjectId', 'status'],
  statuses: EMPLOYMENT_STATUSES,
  async run({ f }) {
    const base = {
      schoolId: f.schoolId,
      ...(f.status && { employmentStatus: f.status }),
      ...(f.classIds && { classIds: { $in: f.classIds } }),
      ...(f.subjectId && { subjectIds: f.subjectId }),
    };
    const [byStatus, perClass, perSubject] = await Promise.all([
      Teacher.aggregate([{ $match: base }, { $group: { _id: '$employmentStatus', n: { $sum: 1 } } }]),
      Teacher.aggregate([
        { $match: base },
        { $unwind: '$classIds' },
        ...(f.classIds ? [{ $match: { classIds: { $in: f.classIds } } }] : []),
        { $group: { _id: '$classIds', teachers: { $sum: 1 } } },
      ]),
      Teacher.aggregate([
        { $match: base },
        { $unwind: '$subjectIds' },
        ...(f.subjectId ? [{ $match: { subjectIds: f.subjectId } }] : []),
        { $group: { _id: '$subjectIds', teachers: { $sum: 1 } } },
      ]),
    ]);

    const n = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
    const count = (s) => n[s] ?? 0;
    const all = byStatus.reduce((sum, r) => sum + r.n, 0);

    const info = await classInfo(f.schoolId, perClass.map((r) => r._id));
    const classRows = perClass
      .map((r) => ({ session: info.get(String(r._id))?.sessionName ?? '', className: info.get(String(r._id))?.name ?? '?', arm: info.get(String(r._id))?.arm ?? '', teachers: r.teachers }))
      .sort(byClassOrder);

    const subjects = await Subject.find({ _id: { $in: perSubject.map((r) => r._id) }, schoolId: f.schoolId }).select('name code').lean();
    const subjectName = new Map(subjects.map((s) => [String(s._id), s]));
    const subjectRows = perSubject
      .map((r) => ({ code: subjectName.get(String(r._id))?.code ?? '?', subject: subjectName.get(String(r._id))?.name ?? '?', teachers: r.teachers }))
      .sort((a, b) => a.subject.localeCompare(b.subject));

    return {
      totals: [
        total('total', 'Total teachers', all),
        total('active', 'Active teachers', count('active')),
        total('onLeave', 'Teachers on leave', count('on_leave')),
        total('inactive', 'Inactive teachers', count('inactive')),
        total('resigned', 'Resigned teachers', count('resigned')),
        total('retired', 'Retired teachers', count('retired')),
        total('resignedOrRetired', 'Resigned or retired teachers', count('resigned') + count('retired')),
      ],
      sections: [
        section('byClass', 'Teachers assigned to each class', [col('session', 'Session'), col('className', 'Class'), col('arm', 'Arm'), col('teachers', 'Teachers')], classRows),
        section('bySubject', 'Teachers assigned to each subject', [col('code', 'Code'), col('subject', 'Subject'), col('teachers', 'Teachers')], subjectRows),
      ],
    };
  },
};
