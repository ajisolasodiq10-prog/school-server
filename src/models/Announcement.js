import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const ANNOUNCEMENT_AUDIENCES = ['public', 'students', 'staff', 'class'];
export const ANNOUNCEMENT_STATUSES = ['draft', 'scheduled', 'published', 'archived'];
export const ANNOUNCEMENT_CATEGORIES = ['general', 'event', 'resumption', 'examination', 'holiday', 'admission', 'meeting'];

// A school announcement written by an administrator.
//
//   audience  public    everyone, signed in or not, including transferred and graduated students
//             students  active students and the parents of active students
//             staff     administrators and active teachers
//             class     the active students (and their parents) of ONE class (classId)
//   status    draft -> published (now) or scheduled (starts later) -> archived
//
// It is visible while status is published or scheduled AND startsAt has passed AND it has not
// expired. A scheduled announcement therefore opens by itself at startsAt: no background job
// is needed, and nothing changes in the database when it opens.
const announcementSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 10000 },
    audience: { type: String, enum: ANNOUNCEMENT_AUDIENCES, required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class' }, // only for audience 'class'
    category: { type: String, enum: ANNOUNCEMENT_CATEGORIES, default: 'general', required: true },

    status: { type: String, enum: ANNOUNCEMENT_STATUSES, default: 'draft', required: true },
    startsAt: { type: Date },
    expiresAt: { type: Date },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },
  },
  { timestamps: true }
);

announcementSchema.pre('validate', function () {
  if (this.audience === 'class' && !this.classId) this.invalidate('classId', 'Choose the class this announcement is for.');
  if (this.audience !== 'class' && this.classId) this.invalidate('classId', 'A class can only be chosen when the audience is a class.');
  if (this.startsAt && this.expiresAt && this.expiresAt <= this.startsAt) {
    this.invalidate('expiresAt', 'The expiry date must be after the start date.');
  }
});

announcementSchema.index({ schoolId: 1, status: 1, audience: 1, startsAt: -1 });
announcementSchema.index({ schoolId: 1, createdAt: -1 });

announcementSchema.plugin(protectFromHardDelete, { label: 'Announcement' });

export default mongoose.model('Announcement', announcementSchema);
