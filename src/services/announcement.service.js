import { Announcement, Class, Student, Teacher } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { toAnnouncementReaderView, toAnnouncementStaffView } from '../utils/serializers.js';
import { studentScope } from './access.service.js';
import { recordAudit } from './audit.service.js';
import { canStudentAccess } from './lifecycle.service.js';
import { moveNotifications, notifyUsers, recipientsForAudience, recipientsForClass } from './notification.service.js';
import { resolvePublicSchool } from './publicSchool.service.js';

// SCHOOL ANNOUNCEMENTS
//
//   administrators  create, edit, publish, schedule and archive; choose the audience; set the
//                   start and expiry dates. They see every announcement, in every state.
//   readers         only what their access allows, and only while it is LIVE:
//                     public    everyone, signed in or not (including transferred and graduated
//                               students and their parents)
//                     students  active students and the parents of active students
//                     staff     administrators and active teachers
//
// Live = published or scheduled, its start date has passed and it has not expired. A scheduled
// announcement therefore opens by itself at its start date: no background job, and the record
// does not change when it opens.
//
// Every state change is one conditional update (it only applies if the announcement is still in
// the state we read), so two administrators clicking at once cannot publish twice or send the
// notifications twice. Nothing is deleted: "archive" is the end of the road.

const NEVER = new Date('9999-12-31T00:00:00Z'); // a notification that must not appear (archived before it started)

export function stateOf(a, now = new Date()) {
  if (a.status === 'draft') return 'draft';
  if (a.status === 'archived') return 'archived';
  if (a.expiresAt && a.expiresAt <= now) return 'expired';
  if (a.startsAt && a.startsAt > now) return 'scheduled';
  return 'live';
}

const liveFilter = (now) => ({
  status: { $in: ['published', 'scheduled'] },
  $and: [
    { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
    { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
  ],
});

const staffView = (a) => toAnnouncementStaffView(a, stateOf(a));
const invalid = (field, message) => badRequest('Invalid announcement.', { code: 'VALIDATION_ERROR', details: [{ field, message }] });

// ------------------------------------------------------------------ administrators

// A class announcement needs a class of this school; every other audience must not have one.
async function checkClassAudience(auth, audience, classId) {
  if (audience !== 'class') {
    if (classId) throw invalid('classId', 'A class can only be chosen when the audience is a class.');
    return;
  }
  if (!classId) throw invalid('classId', 'Choose the class this announcement is for.');
  if (!(await Class.exists({ _id: classId, schoolId: auth.schoolId }))) throw notFound('Class not found.');
}

export async function createAnnouncement(auth, { title, body, audience, classId, category, startsAt, expiresAt }) {
  const now = new Date();
  await checkClassAudience(auth, audience, classId);
  if (startsAt && expiresAt && expiresAt <= startsAt) throw invalid('expiresAt', 'The expiry date must be after the start date.');
  if (expiresAt && expiresAt <= now) throw invalid('expiresAt', 'The expiry date must be in the future.');

  const announcement = await Announcement.create({
    schoolId: auth.schoolId,
    title,
    body,
    audience,
    ...(classId && { classId }),
    ...(category && { category }),
    ...(startsAt && { startsAt }),
    ...(expiresAt && { expiresAt }),
    createdBy: auth.userId,
  });
  await recordAudit(auth, {
    action: 'announcement.created',
    entityType: 'announcement',
    entityId: announcement._id,
    summary: `Announcement "${title}" drafted for ${audience}`,
    details: { audience },
  });
  return { announcement: staffView(announcement) };
}

async function findOwn(auth, id) {
  const announcement = await Announcement.findOne({ _id: id, schoolId: auth.schoolId });
  if (!announcement) throw notFound('Announcement not found.');
  return announcement;
}

const archivedError = () => new AppError(409, 'This announcement is archived and cannot be changed.', { code: 'ANNOUNCEMENT_ARCHIVED' });

export async function updateAnnouncement(auth, id, changes) {
  if (Object.keys(changes).length === 0) throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  const announcement = await findOwn(auth, id);
  if (announcement.status === 'archived') throw archivedError();
  const now = new Date();

  if (changes.audience !== undefined && changes.audience !== announcement.audience && announcement.status !== 'draft') {
    throw new AppError(409, 'The audience can only be changed while the announcement is a draft.', { code: 'AUDIENCE_LOCKED' });
  }
  if (changes.audience !== undefined || changes.classId !== undefined) {
    const audience = changes.audience ?? announcement.audience;
    const classId = audience !== 'class' ? null : changes.classId !== undefined ? changes.classId : changes.audience !== undefined ? null : announcement.classId;
    if (announcement.status !== 'draft' && changes.classId !== undefined && String(changes.classId) !== String(announcement.classId)) {
      throw new AppError(409, 'The class can only be changed while the announcement is a draft.', { code: 'AUDIENCE_LOCKED' });
    }
    await checkClassAudience(auth, audience, classId);
    changes.classId = classId;
  }
  if (changes.startsAt !== undefined) {
    if (announcement.status === 'published') {
      throw new AppError(409, 'A published announcement has already started; its start date cannot change.', { code: 'START_LOCKED' });
    }
    if (announcement.status === 'scheduled' && (changes.startsAt === null || changes.startsAt <= now)) {
      throw invalid('startsAt', 'A scheduled announcement needs a start date in the future. Publish it to start it now.');
    }
  }
  const startsAt = changes.startsAt === undefined ? announcement.startsAt : changes.startsAt;
  const expiresAt = changes.expiresAt === undefined ? announcement.expiresAt : changes.expiresAt;
  if (changes.expiresAt && changes.expiresAt <= now) throw invalid('expiresAt', 'The expiry date must be in the future.');
  if (startsAt && expiresAt && expiresAt <= startsAt) throw invalid('expiresAt', 'The expiry date must be after the start date.');

  const before = { audience: announcement.audience, startsAt: announcement.startsAt, expiresAt: announcement.expiresAt };
  for (const key of ['title', 'body', 'audience', 'classId', 'category', 'startsAt', 'expiresAt']) {
    if (changes[key] !== undefined) announcement.set(key, changes[key] ?? undefined); // null clears
  }
  announcement.updatedBy = auth.userId;
  if (announcement.status === 'scheduled' && changes.startsAt) announcement.publishedAt = changes.startsAt;
  await announcement.save();

  if (announcement.status === 'scheduled' && changes.startsAt) {
    await moveNotifications(auth.schoolId, 'announcement', announcement._id, changes.startsAt);
  }
  await recordAudit(auth, {
    action: 'announcement.updated',
    entityType: 'announcement',
    entityId: announcement._id,
    summary: `Announcement "${announcement.title}" edited`,
    details: { fields: Object.keys(changes), before },
  });
  return { announcement: staffView(announcement) };
}

// One conditional transition. Returns the updated announcement, or throws 409 when someone
// else changed it first.
async function transition(auth, announcement, set) {
  const changed = await Announcement.findOneAndUpdate(
    { _id: announcement._id, schoolId: auth.schoolId, status: announcement.status },
    { $set: { ...set, updatedBy: auth.userId } },
    { new: true, runValidators: true }
  );
  if (!changed) throw new AppError(409, 'This announcement was just changed by someone else. Reload and try again.', { code: 'ANNOUNCEMENT_CHANGED' });
  return changed;
}

// A class announcement is delivered like a student announcement, to that class only.
const tellAudience = (auth, announcement, availableAt) =>
  (announcement.audience === 'class'
    ? recipientsForClass(auth.schoolId, announcement.classId)
    : recipientsForAudience(auth.schoolId, announcement.audience, auth.userId)
  ).then((recipients) =>
    notifyUsers(auth.schoolId, recipients, {
      type: announcement.audience === 'class' ? 'announcement.students' : `announcement.${announcement.audience}`,
      title: announcement.title,
      message: announcement.body.slice(0, 200),
      entityType: 'announcement',
      entityId: announcement._id,
      availableAt,
    })
  );

// Starts now. A scheduled announcement published early moves its notifications to now.
export async function publishAnnouncement(auth, id) {
  const announcement = await findOwn(auth, id);
  if (announcement.status === 'archived') throw archivedError();
  if (announcement.status === 'published') {
    throw new AppError(409, 'This announcement is already published.', { code: 'ANNOUNCEMENT_ALREADY_PUBLISHED' });
  }
  const now = new Date();
  if (announcement.expiresAt && announcement.expiresAt <= now) {
    throw new AppError(409, 'The expiry date has passed. Edit the expiry date before publishing.', { code: 'ANNOUNCEMENT_EXPIRED' });
  }
  const wasScheduled = announcement.status === 'scheduled';
  const published = await transition(auth, announcement, { status: 'published', startsAt: now, publishedAt: now, publishedBy: auth.userId });

  if (wasScheduled) await moveNotifications(auth.schoolId, 'announcement', published._id, now);
  else await tellAudience(auth, published, now);
  await recordAudit(auth, {
    action: 'announcement.published',
    entityType: 'announcement',
    entityId: published._id,
    summary: `Announcement "${published.title}" published for ${published.audience}`,
    details: { audience: published.audience, wasScheduled },
  });
  return { announcement: staffView(published) };
}

// Starts later, on its own.
export async function scheduleAnnouncement(auth, id, { startsAt }) {
  const announcement = await findOwn(auth, id);
  if (announcement.status === 'archived') throw archivedError();
  if (announcement.status === 'published') {
    throw new AppError(409, 'This announcement is already published.', { code: 'ANNOUNCEMENT_ALREADY_PUBLISHED' });
  }
  if (startsAt <= new Date()) throw invalid('startsAt', 'The start date must be in the future. Use publish to start now.');
  if (announcement.expiresAt && announcement.expiresAt <= startsAt) throw invalid('expiresAt', 'The expiry date must be after the start date.');

  const wasScheduled = announcement.status === 'scheduled';
  const scheduled = await transition(auth, announcement, { status: 'scheduled', startsAt, publishedAt: startsAt, publishedBy: auth.userId });

  if (wasScheduled) await moveNotifications(auth.schoolId, 'announcement', scheduled._id, startsAt);
  else await tellAudience(auth, scheduled, startsAt);
  await recordAudit(auth, {
    action: 'announcement.scheduled',
    entityType: 'announcement',
    entityId: scheduled._id,
    summary: `Announcement "${scheduled.title}" scheduled`,
    details: { audience: scheduled.audience, startsAt, rescheduled: wasScheduled },
  });
  return { announcement: staffView(scheduled) };
}

export async function archiveAnnouncement(auth, id) {
  const announcement = await findOwn(auth, id);
  if (announcement.status === 'archived') throw new AppError(409, 'This announcement is already archived.', { code: 'ANNOUNCEMENT_ARCHIVED' });
  const notStarted = stateOf(announcement) === 'scheduled';
  const archived = await transition(auth, announcement, { status: 'archived', archivedAt: new Date(), archivedBy: auth.userId });
  // Alerts for an announcement that never opened must not appear later.
  if (notStarted) await moveNotifications(auth.schoolId, 'announcement', archived._id, NEVER);
  await recordAudit(auth, {
    action: 'announcement.archived',
    entityType: 'announcement',
    entityId: archived._id,
    summary: `Announcement "${archived.title}" archived`,
  });
  return { announcement: staffView(archived) };
}

// ----------------------------------------------------------------------- reading

// What this person may read, as a database filter on audience (administrators are handled apart).
// Returns null when nothing is readable.
async function audienceFilter(auth, audience) {
  const clauses = [];
  if (auth.role === 'teacher') {
    const active = await Teacher.exists({ schoolId: auth.schoolId, userId: auth.userId, employmentStatus: 'active' });
    clauses.push({ audience: 'public' });
    if (active) clauses.push({ audience: 'staff' }); // on leave, resigned: no staff notices
  } else {
    const students = await Student.find(await studentScope(auth));
    if (auth.role === 'parent' || students.some((s) => canStudentAccess(s, 'publicAnnouncements'))) clauses.push({ audience: 'public' }); // a parent is not a student: public always
    const current = students.filter((s) => canStudentAccess(s, 'privateAnnouncements'));
    if (current.length) clauses.push({ audience: 'students' });
    const classIds = current.map((s) => s.currentClassId).filter(Boolean);
    if (classIds.length) clauses.push({ audience: 'class', classId: { $in: classIds } });
  }
  const allowed = clauses.filter((c) => !audience || c.audience === audience);
  return allowed.length ? { $or: allowed } : null;
}

export async function listAnnouncements(auth, { status, audience, category, page = 1, limit = 20 } = {}) {
  const filter = { schoolId: auth.schoolId };
  if (category) filter.category = category;

  if (auth.role === 'admin') {
    if (status) filter.status = status;
    if (audience) filter.audience = audience;
    const [items, total] = await Promise.all([
      Announcement.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
      Announcement.countDocuments(filter),
    ]);
    return { items: items.map(staffView), page, limit, total };
  }

  if (status) throw badRequest('Only administrators can filter by status.', { code: 'VALIDATION_ERROR' });
  const readable = await audienceFilter(auth, audience);
  if (!readable) return { items: [], page, limit, total: 0 };
  filter.$and = [readable, ...liveFilter(new Date()).$and];
  filter.status = liveFilter(new Date()).status;
  const [items, total] = await Promise.all([
    Announcement.find(filter).sort({ startsAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Announcement.countDocuments(filter),
  ]);
  return { items: items.map(toAnnouncementReaderView), page, limit, total };
}

export async function getAnnouncement(auth, id) {
  if (auth.role === 'admin') return { announcement: staffView(await findOwn(auth, id)) };
  const readable = await audienceFilter(auth);
  const live = liveFilter(new Date());
  const announcement = readable
    ? await Announcement.findOne({ _id: id, schoolId: auth.schoolId, status: live.status, $and: [readable, ...live.$and] })
    : null;
  if (!announcement) throw notFound('Announcement not found.');
  return { announcement: toAnnouncementReaderView(announcement) };
}

// ------------------------------------------------------------------ the public website

export async function listPublicAnnouncements({ schoolCode, category, page = 1, limit = 20 } = {}) {
  const school = await resolvePublicSchool(schoolCode);
  const filter = { schoolId: school._id, audience: 'public', ...liveFilter(new Date()), ...(category && { category }) };
  const [items, total] = await Promise.all([
    Announcement.find(filter).sort({ startsAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    Announcement.countDocuments(filter),
  ]);
  return { items: items.map(toAnnouncementReaderView), page, limit, total };
}

export async function getPublicAnnouncement({ schoolCode }, id) {
  const school = await resolvePublicSchool(schoolCode);
  const announcement = await Announcement.findOne({ _id: id, schoolId: school._id, audience: 'public', ...liveFilter(new Date()) });
  if (!announcement) throw notFound('Announcement not found.');
  return { announcement: toAnnouncementReaderView(announcement) };
}

