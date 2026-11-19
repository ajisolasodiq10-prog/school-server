import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';
import { refInSameSchool } from './helpers/refValidators.js';

// "removed" is only ever set by an administrator (inappropriate content). A teacher chooses
// between the other three.
export const ASSIGNMENT_STATUSES = ['active', 'completed', 'cancelled', 'removed'];
export const TEACHER_ASSIGNMENT_STATUSES = ['active', 'completed', 'cancelled'];

// Work set by a teacher for one class and one subject. The class belongs to one academic
// session, so an assignment stays attached to the right session for good. Assignments are
// never deleted: an administrator "removes" one (it disappears for students, parents and
// the teacher's own working list, and the reason and the administrator are kept).
const assignmentSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true, immutable: true, validate: refInSameSchool('Class') },
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, immutable: true, validate: refInSameSchool('Subject') },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true, immutable: true },

    // The teacher who owns it (only they, and administrators, can change it).
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true, immutable: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    // Students and parents see an assignment from its issue date. The deadline cannot come first.
    issueDate: { type: Date, required: true },
    dueDate: { type: Date, required: true },

    status: { type: String, enum: ASSIGNMENT_STATUSES, default: 'active', required: true },
    statusChangedAt: { type: Date },

    statusBeforeRemoval: { type: String, enum: TEACHER_ASSIGNMENT_STATUSES },
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    removedAt: { type: Date },
    removalReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

assignmentSchema.pre('validate', function () {
  if (this.issueDate && this.dueDate && this.dueDate < this.issueDate) {
    this.invalidate('dueDate', 'The deadline cannot be before the issue date.');
  }
});

assignmentSchema.index({ schoolId: 1, classId: 1, status: 1, issueDate: -1 });
assignmentSchema.index({ schoolId: 1, createdBy: 1, createdAt: -1 });
// "Assignments created in a period" (reports) is school-wide, not per teacher.
assignmentSchema.index({ schoolId: 1, createdAt: -1 });
assignmentSchema.index({ schoolId: 1, academicSessionId: 1 });
assignmentSchema.index({ schoolId: 1, subjectId: 1, classId: 1 });

assignmentSchema.plugin(protectFromHardDelete, { label: 'Assignment' });

export default mongoose.model('Assignment', assignmentSchema);
