import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';
import { refInSameSchool, refsInSameSchool, noDuplicateIds } from './helpers/refValidators.js';

export const EMPLOYMENT_STATUSES = ['active', 'on_leave', 'inactive', 'resigned', 'retired'];

// Teachers are never deleted. "Deactivating" a teacher means changing employmentStatus,
// so the results, class assignments and other history that point at them stay intact.
const teacherSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School is required.'],
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A linked user account is required.'],
      validate: refInSameSchool('User', { role: 'teacher' }),
    },
    // School-issued staff number. Stored upper-case.
    teacherId: {
      type: String,
      required: [true, 'Teacher ID is required.'],
      trim: true,
      uppercase: true,
      maxlength: 40,
    },
    firstName: { type: String, required: [true, 'First name is required.'], trim: true, maxlength: 60 },
    middleName: { type: String, trim: true, maxlength: 60 },
    lastName: { type: String, required: [true, 'Last name is required.'], trim: true, maxlength: 60 },
    department: { type: String, trim: true, maxlength: 100 },
    // Form of address (e.g. "Mr", "Mrs", "Dr") and a contact number shown on the admin pages.
    title: { type: String, trim: true, maxlength: 20 },
    phone: { type: String, trim: true, maxlength: 30 },
    // Edited by the teacher on their own profile page.
    qualification: { type: String, trim: true, maxlength: 200 },
    bio: { type: String, trim: true, maxlength: 300 },
    // Subjects this teacher is assigned to teach.
    subjectIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }],
      default: [],
      validate: [noDuplicateIds, refsInSameSchool('Subject')],
    },
    // Classes this teacher teaches in (not the same as being a class teacher, which is set on Class).
    classIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Class' }],
      default: [],
      validate: [noDuplicateIds, refsInSameSchool('Class')],
    },
    employmentStatus: {
      type: String,
      enum: EMPLOYMENT_STATUSES,
      default: 'active',
      required: true,
    },
    // When employmentStatus last changed (resigned, retired, deactivated, reactivated).
    employmentStatusChangedAt: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

teacherSchema.virtual('fullName').get(function () {
  return [this.firstName, this.middleName, this.lastName].filter(Boolean).join(' ');
});

// Teacher IDs are unique within a school.
teacherSchema.index({ schoolId: 1, teacherId: 1 }, { unique: true });
// One login account belongs to at most one teacher.
teacherSchema.index({ userId: 1 }, { unique: true });
// Staff lists and "who teaches this subject / class" lookups.
teacherSchema.index({ schoolId: 1, employmentStatus: 1 });
teacherSchema.index({ schoolId: 1, subjectIds: 1 });
teacherSchema.index({ schoolId: 1, classIds: 1 });

teacherSchema.plugin(protectFromHardDelete, { label: 'Teacher' });

export default mongoose.model('Teacher', teacherSchema);
