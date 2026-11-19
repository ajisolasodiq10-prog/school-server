import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const RESULT_STATUSES = ['draft', 'submitted', 'approved', 'published', 'recalled'];

// FOUNDATION ONLY. Just enough of a result to carry the workflow
//   Draft -> Submitted -> Approved -> Published   (and Published -> Recalled -> correction)
// and its full version history. Grading, positions, CA/exam breakdowns, PINs and report cards
// belong to the result management module that will be built on top of this.
//
// A result is one student's results for one term. Every change after a version leaves draft
// creates a NEW version; published versions are never edited or removed, so the originally
// published figures stay on record even after a recall and correction.
const entrySchema = new mongoose.Schema(
  {
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
    score: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

const versionSchema = new mongoose.Schema(
  {
    number: { type: Number, required: true, min: 1 },
    status: { type: String, enum: RESULT_STATUSES, required: true },
    entries: { type: [entrySchema], default: [] },
    remarks: { type: String, trim: true, maxlength: 500 },
    // Set on a correction: the version it corrects.
    correctionOf: { type: Number },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, required: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    submittedAt: { type: Date },
    returnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    returnedAt: { type: Date },
    returnReason: { type: String, maxlength: 500 },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: { type: Date },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
    recalledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recalledAt: { type: Date },
    recallReason: { type: String, maxlength: 500 },
  },
  { _id: false }
);

const resultSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
    // The term's own id inside the session's embedded terms.
    termId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // The class the student was in for that session, kept as it was. A later class change
    // (promotion, arm change) never touches it.
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
    // Status of the latest version.
    status: { type: String, enum: RESULT_STATUSES, required: true },
    currentVersion: { type: Number, required: true, min: 1 },
    // The version students and parents may see. null while nothing is published or while the
    // result is recalled / under correction.
    publishedVersion: { type: Number, default: null },
    versions: { type: [versionSchema], default: [] },
  },
  // optimisticConcurrency: two people changing the same result at once cannot overwrite each
  // other; the second save fails and the service reports a conflict.
  { timestamps: true, optimisticConcurrency: true }
);

// A student has one result per term of a session.
resultSchema.index({ schoolId: 1, studentId: 1, academicSessionId: 1, termId: 1 }, { unique: true });
resultSchema.index({ schoolId: 1, classId: 1, academicSessionId: 1, termId: 1, status: 1 });
resultSchema.index({ schoolId: 1, studentId: 1, publishedVersion: 1 });

// Only a draft version's figures may change. Anything that has been submitted, approved,
// published or recalled is history and can never be rewritten through a save.
resultSchema.pre('save', function () {
  if (this.isNew) return;
  this.versions.forEach((version, index) => {
    const frozen = version.status !== 'draft';
    if (frozen && (this.isModified(`versions.${index}.entries`) || this.isModified(`versions.${index}.remarks`))) {
      // A version that has just been returned to draft is allowed (status is draft by now).
      throw new Error(`Version ${version.number} is ${version.status} and can no longer be edited. Start a correction instead.`);
    }
  });
});

resultSchema.plugin(protectFromHardDelete, { label: 'Result' });

export default mongoose.model('Result', resultSchema);
