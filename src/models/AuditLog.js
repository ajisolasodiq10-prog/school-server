import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

// An append-only record of every sensitive action (accounts, academic setup, students,
// results, promotion, PINs, assignments, announcements, entry requirements). Entries are written once
// and never changed; there is no update path (hooks below refuse one).
const auditLogSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    actorRole: { type: String, required: true },
    // e.g. "result.recalled", "student.class_changed", "session.activated"
    action: { type: String, required: true, trim: true, maxlength: 60 },
    entityType: { type: String, required: true, trim: true, maxlength: 40 },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // The student the action is about, when there is one (lets a student's trail be found).
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student' },
    summary: { type: String, trim: true, maxlength: 300 },
    details: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ schoolId: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 }, { sparse: true });
auditLogSchema.index({ schoolId: 1, action: 1, createdAt: -1 });
// "What did this person do?" (the audit log's user filter)
auditLogSchema.index({ schoolId: 1, actorId: 1, createdAt: -1 });

const refuse = () => {
  throw new Error('Audit log entries cannot be changed.');
};
auditLogSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], refuse);
// Entry.updateOne() / entry.deleteOne() on a loaded document, and bulk writes, are refused too.
auditLogSchema.pre('updateOne', { document: true, query: false }, refuse);
auditLogSchema.pre('bulkWrite', refuse);
auditLogSchema.pre('save', function () {
  if (!this.isNew) refuse();
});

auditLogSchema.plugin(protectFromHardDelete, { label: 'Audit log' });

export default mongoose.model('AuditLog', auditLogSchema);
