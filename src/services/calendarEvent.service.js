import { CalendarEvent } from '../models/index.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { toEventView } from '../utils/serializers.js';
import { recordAudit } from './audit.service.js';

// THE SCHOOL CALENDAR
//   administrators  add, change and remove events
//   everyone else   (teachers, students, parents) read them
// An event belongs to the school of the signed-in user. Removing one deletes it; the audit log
// keeps who did it.

const invalid = (field, message) => badRequest('Invalid event.', { code: 'VALIDATION_ERROR', details: [{ field, message }] });

export async function listEvents(auth, { type, from, to, page = 1, limit = 100 } = {}) {
  const filter = { schoolId: auth.schoolId };
  if (type) filter.type = type;
  // An event is in range when it ends on/after `from` and starts on/before `to` (no end = its start).
  if (from) filter.$or = [{ endDate: { $gte: from } }, { endDate: null, startDate: { $gte: from } }, { endDate: { $exists: false }, startDate: { $gte: from } }];
  if (to) filter.startDate = { $lte: to };
  const [items, total] = await Promise.all([
    CalendarEvent.find(filter).sort({ startDate: 1, _id: 1 }).skip((page - 1) * limit).limit(limit),
    CalendarEvent.countDocuments(filter),
  ]);
  return { items: items.map(toEventView), page, limit, total };
}

export async function createEvent(auth, { type, title, description, startDate, endDate }) {
  if (endDate && endDate < startDate) throw invalid('endDate', 'The end date cannot be before the start date.');
  const event = await CalendarEvent.create({
    schoolId: auth.schoolId,
    type,
    title,
    ...(description && { description }),
    startDate,
    ...(endDate && { endDate }),
    createdBy: auth.userId,
  });
  await recordAudit(auth, { action: 'calendar_event.created', entityType: 'calendar_event', entityId: event._id, summary: `Calendar event "${title}" added` });
  return toEventView(event);
}

export async function updateEvent(auth, id, changes) {
  if (Object.keys(changes).length === 0) throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  const event = await CalendarEvent.findOne({ _id: id, schoolId: auth.schoolId });
  if (!event) throw notFound('Event not found.');
  const startDate = changes.startDate ?? event.startDate;
  const endDate = changes.endDate === undefined ? event.endDate : changes.endDate;
  if (endDate && endDate < startDate) throw invalid('endDate', 'The end date cannot be before the start date.');
  for (const key of ['type', 'title', 'description', 'startDate', 'endDate']) {
    if (changes[key] !== undefined) event.set(key, changes[key] ?? undefined); // null clears
  }
  event.updatedBy = auth.userId;
  await event.save();
  await recordAudit(auth, { action: 'calendar_event.updated', entityType: 'calendar_event', entityId: event._id, summary: `Calendar event "${event.title}" updated`, details: { fields: Object.keys(changes) } });
  return toEventView(event);
}

export async function deleteEvent(auth, id) {
  const event = await CalendarEvent.findOneAndDelete({ _id: id, schoolId: auth.schoolId });
  if (!event) throw notFound('Event not found.');
  await recordAudit(auth, { action: 'calendar_event.removed', entityType: 'calendar_event', entityId: event._id, summary: `Calendar event "${event.title}" removed` });
  return { removed: true };
}
