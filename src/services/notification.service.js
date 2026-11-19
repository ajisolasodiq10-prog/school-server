import { Student, Teacher, User, Notification } from '../models/index.js';
import { notFound } from '../utils/AppError.js';
import { toNotificationView } from '../utils/serializers.js';
import { studentScope } from './access.service.js';
import { canStudentAccess } from './lifecycle.service.js';

// IN-APP NOTIFICATIONS (the foundation). One record per recipient; no SMS, WhatsApp or other
// paid delivery. A later delivery channel can read the same records.
//
// Creating notifications must never break the action that caused them (an assignment is saved
// even if the notification step fails), so notifyUsers() never throws.
//
// Who may READ a notification is decided when it is read, not when it is created: a student
// who is later transferred stops seeing assignment alerts, exactly as they stop seeing the
// assignments (lifecycle.service is the single source of truth).

const idOf = (value) => String(value);
const CHUNK = 500;

// The student capability a notification type needs.
const CAPABILITY = {
  'assignment.created': 'assignments',
  'announcement.public': 'publicAnnouncements',
  'announcement.students': 'privateAnnouncements',
  'result.published': 'results',
};
// Types that are about one particular student (a parent has one per child).
const PER_STUDENT = new Set(['assignment.created', 'result.published']);

// recipients: [{ userId, studentId? }]. Duplicates (same user and student) are dropped.
export async function notifyUsers(schoolId, recipients, { type, title, message, entityType, entityId, availableAt = new Date() }) {
  try {
    const seen = new Set();
    const docs = [];
    for (const r of recipients) {
      const key = `${idOf(r.userId)}|${r.studentId ? idOf(r.studentId) : ''}`;
      if (!r.userId || seen.has(key)) continue;
      seen.add(key);
      docs.push({ schoolId, userId: r.userId, type, title, message, entityType, entityId, studentId: r.studentId, availableAt });
    }
    for (let i = 0; i < docs.length; i += CHUNK) await Notification.insertMany(docs.slice(i, i + CHUNK));
    return docs.length;
  } catch (error) {
    console.error(`Could not create "${type}" notifications:`, error.message);
    return 0;
  }
}

// ------------------------------------------------------------------ who to tell

// The students of a class and their parents. `status: active` because only active students
// have assignments.
export async function recipientsForClass(schoolId, classId) {
  const students = await Student.find({ schoolId, currentClassId: classId, status: 'active' }).select('userId guardianUserIds');
  return students.flatMap((s) => [
    ...(s.userId ? [{ userId: s.userId, studentId: s._id }] : []),
    ...(s.guardianUserIds || []).map((userId) => ({ userId, studentId: s._id })),
  ]);
}

// A student and everyone linked to them.
export async function recipientsForStudent(schoolId, studentId) {
  const student = await Student.findOne({ _id: studentId, schoolId }).select('userId guardianUserIds');
  if (!student) return [];
  return [
    ...(student.userId ? [{ userId: student.userId, studentId: student._id }] : []),
    ...(student.guardianUserIds || []).map((userId) => ({ userId, studentId: student._id })),
  ];
}

// The people an announcement is meant for (never the author).
export async function recipientsForAudience(schoolId, audience, excludeUserId) {
  let ids = [];
  if (audience === 'public') {
    ids = (await User.find({ schoolId, status: 'active' }).select('_id')).map((u) => u._id);
  } else if (audience === 'students') {
    const students = await Student.find({ schoolId, status: 'active' }).select('userId guardianUserIds');
    ids = students.flatMap((s) => [...(s.userId ? [s.userId] : []), ...(s.guardianUserIds || [])]);
  } else if (audience === 'staff') {
    const [admins, teachers] = await Promise.all([
      User.find({ schoolId, status: 'active', role: 'admin' }).select('_id'),
      Teacher.find({ schoolId, employmentStatus: 'active' }).select('userId'),
    ]);
    ids = [...admins.map((u) => u._id), ...teachers.map((t) => t.userId)];
  }
  return ids.filter((id) => !excludeUserId || idOf(id) !== idOf(excludeUserId)).map((userId) => ({ userId }));
}

// A scheduled announcement moved or published early: its notifications move with it.
export async function moveNotifications(schoolId, entityType, entityId, availableAt) {
  try {
    await Notification.updateMany({ schoolId, entityType, entityId }, { $set: { availableAt } });
  } catch (error) {
    console.error('Could not reschedule notifications:', error.message);
  }
}

// ------------------------------------------------------------------ reading

// A database filter for what this person may read, built from the lifecycle policy.
async function readableFilter(auth) {
  const base = { schoolId: auth.schoolId, userId: auth.userId, availableAt: { $lte: new Date() } };

  if (auth.role === 'admin') return base;
  if (auth.role === 'teacher') {
    // Teachers on leave, resigned or inactive have no access to protected teacher functions.
    const active = await Teacher.exists({ schoolId: auth.schoolId, userId: auth.userId, employmentStatus: 'active' });
    return active ? { ...base, type: { $in: ['announcement.public', 'announcement.staff'] } } : null;
  }

  const students = await Student.find(await studentScope(auth));
  if (auth.role === 'student') {
    const types = Object.keys(CAPABILITY).filter((type) => students.some((s) => canStudentAccess(s, CAPABILITY[type])));
    return types.length ? { ...base, type: { $in: types } } : null;
  }

  // Parent: public announcements always; student announcements while any child may see them;
  // per-child notifications only for children who may still use that feature.
  const clauses = [{ type: 'announcement.public' }];
  if (students.some((s) => canStudentAccess(s, CAPABILITY['announcement.students']))) clauses.push({ type: 'announcement.students' });
  for (const type of PER_STUDENT) {
    const ids = students.filter((s) => canStudentAccess(s, CAPABILITY[type])).map((s) => s._id);
    if (ids.length) clauses.push({ type, studentId: { $in: ids } });
  }
  return { ...base, $or: clauses };
}

export async function listNotifications(auth, { unread, page = 1, limit = 20 } = {}) {
  const filter = await readableFilter(auth);
  if (!filter) return { items: [], page, limit, total: 0, unreadCount: 0 };
  const listFilter = unread === 'true' ? { ...filter, readAt: null } : unread === 'false' ? { ...filter, readAt: { $ne: null } } : filter;
  const [items, total, unreadCount] = await Promise.all([
    Notification.find(listFilter).sort({ availableAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Notification.countDocuments(listFilter),
    Notification.countDocuments({ ...filter, readAt: null }),
  ]);
  return { items: items.map(toNotificationView), page, limit, total, unreadCount };
}

export async function markRead(auth, id) {
  const filter = await readableFilter(auth);
  const notification = filter ? await Notification.findOne({ ...filter, _id: id }) : null;
  if (!notification) throw notFound('Notification not found.');
  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save();
  }
  return toNotificationView(notification);
}

export async function markAllRead(auth) {
  const filter = await readableFilter(auth);
  if (!filter) return { updated: 0 };
  const result = await Notification.updateMany({ ...filter, readAt: null }, { $set: { readAt: new Date() } });
  return { updated: result.modifiedCount ?? 0 };
}
