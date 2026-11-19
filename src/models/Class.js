import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';
import { refInSameSchool, refsInSameSchool, noDuplicateIds } from './helpers/refValidators.js';

export const CLASS_STATUSES = ['active', 'inactive'];

// A class belongs to ONE academic session ("JSS 1" + arm "A" in 2026/2027). A new session
// gets its own Class records, so students' class history and old results stay accurate.
const classSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School is required.'],
    },
    // Level, e.g. "JSS 1", "SS 2". Stored upper-case.
    name: {
      type: String,
      required: [true, 'Class name is required.'],
      trim: true,
      uppercase: true,
      maxlength: 30,
    },
    // e.g. "A", "B". "JSS 1A" = name "JSS 1" + arm "A".
    arm: {
      type: String,
      required: [true, 'Class arm is required.'],
      trim: true,
      uppercase: true,
      maxlength: 10,
    },
    classTeacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Teacher',
      validate: refInSameSchool('Teacher'),
    },
    academicSessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AcademicSession',
      required: [true, 'Academic session is required.'],
      validate: refInSameSchool('AcademicSession'),
    },
    // Subjects offered in this class. Deactivating a subject never removes it from here, so
    // the class keeps an accurate record of what it offered. Defaults to [] so classes saved
    // before this field existed stay valid.
    subjectIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }],
      default: [],
      validate: [noDuplicateIds, refsInSameSchool('Subject')],
    },
    // Room or location, e.g. "Room 4" (shown on the admin class pages).
    room: { type: String, trim: true, maxlength: 60 },
    // Which teacher teaches which subject in THIS class. Kept in step with Teacher.classIds /
    // Teacher.subjectIds (see class.service setSubjectTeacher / clearSubjectTeacher).
    subjectTeachers: {
      type: [
        new mongoose.Schema(
          {
            subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
            teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    status: {
      type: String,
      enum: CLASS_STATUSES,
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

// "JSS 1" + "A" -> "JSS 1A"
classSchema.virtual('displayName').get(function () {
  return `${this.name}${this.arm}`;
});

// No duplicate class + arm within the same school and session.
classSchema.index({ schoolId: 1, academicSessionId: 1, name: 1, arm: 1 }, { unique: true });
// Find the classes a teacher is class teacher of.
classSchema.index({ schoolId: 1, classTeacherId: 1 });
// "Which classes offer this subject?" and class lists per session.
classSchema.index({ schoolId: 1, subjectIds: 1 });
classSchema.index({ schoolId: 1, academicSessionId: 1, status: 1 });

classSchema.plugin(protectFromHardDelete, { label: 'Class' });

export default mongoose.model('Class', classSchema);
