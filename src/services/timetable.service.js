import { Class, Subject, Timetable } from '../models/index.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { toTimetableView } from '../utils/serializers.js';
import { classScope } from './access.service.js';
import { recordAudit } from './audit.service.js';

// CLASS TIMETABLES
//   administrators  set one weekly timetable for each class (the same periods every day, a
//                   subject and room per lesson).
//   teachers, students, parents  read the timetable of a class they can see (a teacher's own
//                   classes, a student's current class, a parent's children's classes).

const invalid = (field, message) => badRequest('Invalid timetable.', { code: 'VALIDATION_ERROR', details: [{ field, message }] });
const idOf = (v) => String(v);

async function subjectsFor(schoolId, timetable) {
  const ids = [...new Set(timetable.days.flatMap((d) => d.lessons.map((l) => l.subjectId)).filter(Boolean).map(idOf))];
  const subjects = ids.length ? await Subject.find({ _id: { $in: ids }, schoolId }).select('name') : [];
  return new Map(subjects.map((s) => [idOf(s._id), s]));
}

export async function getTimetable(auth, classId) {
  const klass = await Class.findOne({ _id: classId, ...(await classScope(auth)) });
  if (!klass) throw notFound('Class not found.');
  const timetable = await Timetable.findOne({ schoolId: auth.schoolId, classId: klass._id });
  if (!timetable) return { classId: idOf(klass._id), periods: [], days: [], updatedAt: null };
  return toTimetableView(timetable, await subjectsFor(auth.schoolId, timetable));
}

export async function saveTimetable(auth, classId, { periods, days }) {
  const klass = await Class.findOne({ _id: classId, schoolId: auth.schoolId });
  if (!klass) throw notFound('Class not found.');

  periods.forEach((p, i) => {
    if (p.end <= p.start) throw invalid(`periods.${i}.end`, 'A period must end after it starts.');
    if (i > 0 && p.start < periods[i - 1].end) throw invalid(`periods.${i}.start`, 'Periods cannot overlap and must be in time order.');
  });
  const teaching = periods.filter((p) => !p.breakLabel).length;
  const seen = new Set();
  const offered = new Set(klass.subjectIds.map(idOf));
  for (const day of days) {
    if (seen.has(day.name)) throw invalid('days', `${day.name} appears twice.`);
    seen.add(day.name);
    if (day.lessons.length !== teaching) throw invalid('days', `${day.name} needs exactly ${teaching} lessons (one for each period that is not a break).`);
    for (const lesson of day.lessons) {
      if (lesson.subjectId && !offered.has(idOf(lesson.subjectId))) throw invalid('days', 'A lesson uses a subject that this class does not offer.');
    }
  }

  const doc = {
    periods: periods.map((p) => ({ start: p.start, end: p.end, ...(p.breakLabel && { breakLabel: p.breakLabel }) })),
    days: days.map((d) => ({ name: d.name, lessons: d.lessons.map((l) => ({ subjectId: l.subjectId || null, ...(l.room && { room: l.room }) })) })),
    updatedBy: auth.userId,
  };
  const timetable = await Timetable.findOneAndUpdate(
    { schoolId: auth.schoolId, classId: klass._id },
    { $set: doc, $setOnInsert: { schoolId: auth.schoolId, classId: klass._id } },
    { new: true, upsert: true, runValidators: true }
  );
  await recordAudit(auth, { action: 'timetable.saved', entityType: 'timetable', entityId: timetable._id, summary: `Timetable saved for ${klass.name}${klass.arm}` });
  return toTimetableView(timetable, await subjectsFor(auth.schoolId, timetable));
}
