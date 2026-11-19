import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

// A RESULT SHEET is what one subject teacher enters for one class, one subject and one term:
// a continuous-assessment (CA) score and an exam score for every student. It follows the
// workflow the school dashboards use:
//
//   draft --submit--> submitted --approve--> approved --publish--> published
//     ^                  |
//     +------ return ----+   (administrator, with a reason; the teacher edits and submits again)
//
// Students and parents only ever see PUBLISHED sheets, and only for terms unlocked with a result
// PIN (ResultAccess). Nothing is deleted: a sheet can only move forward or be returned.
export const SHEET_STATUSES = ['draft', 'submitted', 'approved', 'returned', 'published'];

const scoreSchema = new mongoose.Schema(
  {
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    // Either may be left empty while the sheet is a draft; a submitted sheet has both for everyone.
    ca: { type: Number, min: 0, max: 1000 },
    exam: { type: Number, min: 0, max: 1000 },
  },
  { _id: false }
);

const resultSheetSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
    termId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // The teacher who owns the sheet (Teacher record) and their login (for the audit trail).
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
    teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: SHEET_STATUSES, default: 'draft', required: true },
    scores: { type: [scoreSchema], default: [] },

    submittedAt: { type: Date },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String, maxlength: 120 },
    feedback: {
      message: { type: String, maxlength: 500 },
      at: { type: Date },
      byName: { type: String, maxlength: 120 },
    },
    publishedAt: { type: Date },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedByName: { type: String, maxlength: 120 },
  },
  { timestamps: true, optimisticConcurrency: true }
);

// One sheet per class, subject and term.
resultSheetSchema.index({ schoolId: 1, classId: 1, subjectId: 1, academicSessionId: 1, termId: 1 }, { unique: true });
resultSheetSchema.index({ schoolId: 1, status: 1, academicSessionId: 1, termId: 1 });
resultSheetSchema.index({ schoolId: 1, teacherId: 1 });
resultSheetSchema.index({ schoolId: 1, 'scores.studentId': 1, status: 1 });

resultSheetSchema.plugin(protectFromHardDelete, { label: 'Result sheet' });

export default mongoose.model('ResultSheet', resultSheetSchema);
