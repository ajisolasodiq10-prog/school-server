import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';
import { refInSameSchool, refsInSameSchool, noDuplicateIds } from './helpers/refValidators.js';

export const GENDERS = ['male', 'female'];
export const STUDENT_STATUSES = ['active', 'inactive', 'graduated', 'transferred'];
export const CLASS_ENTRY_REASONS = ['admission', 'assigned', 'promoted', 'repeated', 'adjusted', 'reenrolled'];
export const CLASS_EXIT_REASONS = ['reassigned', 'promoted', 'repeated', 'adjusted', 'transferred', 'graduated', 'inactive'];
export const REVIEW_REASONS = ['NO_CONFIRMED_DECISION', 'FINAL_CLASS', 'UNKNOWN_LEVEL', 'NO_TARGET_CLASS'];

// One period a student spent in one class. Entries are only ever added or closed (endedAt
// set), never edited or removed, so the student's class history is permanent.
const classHistorySchema = new mongoose.Schema({
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  startedAt: { type: Date, required: true },
  endedAt: { type: Date },
  reason: { type: String, enum: CLASS_ENTRY_REASONS, required: true },
  endedReason: { type: String, enum: CLASS_EXIT_REASONS },
  // Who made this placement and why (manual moves and promotions). Never edited afterwards.
  changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  note: { type: String, trim: true, maxlength: 300 },
});

// A student record can exist without a login account (userId is optional). Student
// biodata lives here; login details live on the linked User, so nothing is duplicated.
const studentSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School is required.'],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      validate: refInSameSchool('User', { role: 'student' }),
    },
    // School-issued admission/student number. Stored upper-case.
    studentId: {
      type: String,
      required: [true, 'Student ID is required.'],
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    firstName: { type: String, required: [true, 'First name is required.'], trim: true, maxlength: 60 },
    middleName: { type: String, trim: true, maxlength: 60 },
    lastName: { type: String, required: [true, 'Last name is required.'], trim: true, maxlength: 60 },
    gender: {
      type: String,
      enum: GENDERS,
      required: [true, 'Gender is required.'],
    },
    dateOfBirth: {
      type: Date,
      required: [true, 'Date of birth is required.'],
      max: [() => new Date(), 'Date of birth cannot be in the future.'],
    },
    admissionDate: {
      type: Date,
      required: [true, 'Admission date is required.'],
      validate: {
        validator: function (value) {
          return !this.dateOfBirth || value >= this.dateOfBirth;
        },
        message: 'Admission date cannot be before the date of birth.',
      },
    },
    // Details shown on the student's own profile page. Set by an administrator; all optional.
    house: { type: String, trim: true, maxlength: 60 },
    guardianName: { type: String, trim: true, maxlength: 150 },
    guardianPhone: { type: String, trim: true, maxlength: 30 },
    guardianEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },
    address: { type: String, trim: true, maxlength: 300 },
    // When the student's status last became graduated/transferred. Results published before
    // this moment stay visible to the student afterwards. Cleared when re-enrolled.
    statusChangedAt: { type: Date },
    // Optional administrator note about a transfer or graduation (for example the new school).
    statusNote: { type: String, trim: true, maxlength: 300 },
    // Every class the student has been in, oldest first. currentClassId is kept when a
    // student leaves, so the last class is never lost.
    classHistory: { type: [classHistorySchema], default: [] },
    // Set when a new-session rollover could not place this student by itself (no confirmed
    // decision, final class, no matching class). Cleared by the next manual class adjustment.
    reviewFlag: {
      type: new mongoose.Schema(
        {
          reason: { type: String, enum: REVIEW_REASONS, required: true },
          academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession' },
          flaggedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
    },
    // Parent/guardian login accounts explicitly linked to this student. A parent can only
    // see students whose record lists their account here. Defaults to [] so records saved
    // before this field existed keep working unchanged.
    guardianUserIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      default: [],
      validate: [noDuplicateIds, refsInSameSchool('User', { role: 'parent' })],
    },
    // Optional: a new or graduated student may not be in a class.
    currentClassId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Class',
      validate: refInSameSchool('Class'),
    },
    status: {
      type: String,
      enum: STUDENT_STATUSES,
      default: 'active',
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

studentSchema.virtual('fullName').get(function () {
  return [this.firstName, this.middleName, this.lastName].filter(Boolean).join(' ');
});

// Student IDs are unique within a school.
studentSchema.index({ schoolId: 1, studentId: 1 }, { unique: true });
// One login account can belong to at most one student; students without an account don't collide.
studentSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { userId: { $type: 'objectId' } } }
);
// "Which students does this parent account belong to?"
studentSchema.index({ schoolId: 1, guardianUserIds: 1 });
// Class lists.
studentSchema.index({ schoolId: 1, currentClassId: 1, status: 1 });
// Name searches and alphabetical listings.
studentSchema.index({ schoolId: 1, lastName: 1, firstName: 1 });
// Students waiting for a manual placement decision.
studentSchema.index({ schoolId: 1, 'reviewFlag.reason': 1 }, { sparse: true });
// "Newly registered students in a period" (reports) filters and sorts on registration time.
studentSchema.index({ schoolId: 1, createdAt: -1 });

studentSchema.plugin(protectFromHardDelete, { label: 'Student' });

export default mongoose.model('Student', studentSchema);
