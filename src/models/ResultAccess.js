import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

// The persistent unlock. One record means: this student's results for this term are open to
// the student and to the parents linked to the student. It belongs to the student, session
// and term, NOT to a login session, so logging out and in never removes it, and a new term
// needs its own PIN.
//
// It says nothing about whether a result is published: a recalled result stays hidden
// (the result's own publishedVersion decides that), and a corrected republication becomes
// readable through this same record. Records are written once and never changed or removed.
const resultAccessSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true, immutable: true },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true, immutable: true },
    termId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    pinId: { type: mongoose.Schema.Types.ObjectId, ref: 'ResultPin', required: true, immutable: true },
    redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    redeemedByRole: { type: String, enum: ['student', 'parent'], required: true, immutable: true },
    redeemedAt: { type: Date, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

resultAccessSchema.index({ schoolId: 1, studentId: 1, academicSessionId: 1, termId: 1 }, { unique: true });
resultAccessSchema.index({ schoolId: 1, redeemedAt: -1 });
resultAccessSchema.index({ schoolId: 1, academicSessionId: 1, termId: 1 });

const refuse = () => {
  throw new Error('Result access records cannot be changed.');
};
resultAccessSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'], refuse);
resultAccessSchema.pre('save', function () {
  if (!this.isNew) refuse();
});

resultAccessSchema.plugin(protectFromHardDelete, { label: 'Result access' });

export default mongoose.model('ResultAccess', resultAccessSchema);
