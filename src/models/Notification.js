import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

// What a notification is about. The type decides which student capability the reader needs
// (see notification.service), so a student who has left stops seeing assignment alerts even
// though the notifications were created while they were active.
export const NOTIFICATION_TYPES = [
  'assignment.created',
  'announcement.public',
  'announcement.students',
  'announcement.staff',
  'result.published',
];

// In-app notifications only: one record per recipient. There is no SMS, WhatsApp or other
// outside delivery yet; a later delivery channel can read these same records.
//
// `availableAt` lets a notification be created now and appear later (an assignment issued
// next week, a scheduled announcement). Nothing is ever deleted; only readAt (and, for a
// rescheduled announcement, availableAt) ever changes.
const notificationSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: 200, immutable: true },
    message: { type: String, trim: true, maxlength: 500, immutable: true },
    entityType: { type: String, trim: true, maxlength: 40, immutable: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, immutable: true },
    // For notifications about one student's work (a parent may have several children).
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', immutable: true },
    // Changes only when an announcement is rescheduled or published early.
    availableAt: { type: Date, required: true },
    readAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

notificationSchema.index({ schoolId: 1, userId: 1, availableAt: -1 });
notificationSchema.index({ schoolId: 1, userId: 1, readAt: 1, availableAt: -1 });
notificationSchema.index({ schoolId: 1, entityType: 1, entityId: 1 });

notificationSchema.plugin(protectFromHardDelete, { label: 'Notification' });

export default mongoose.model('Notification', notificationSchema);
