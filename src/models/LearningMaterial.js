import mongoose from 'mongoose';
import { refInSameSchool } from './helpers/refValidators.js';

export const MATERIAL_TYPES = ['notes', 'document', 'link'];
export const MATERIAL_STATUSES = ['active', 'removed'];

// A resource a teacher shares with one class for one subject. Files are not uploaded: the
// material is a title, a description and a link. "Removing" it hides it from students and from
// the teacher's list; the record stays.
const learningMaterialSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true, immutable: true, validate: refInSameSchool('Class') },
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true, immutable: true, validate: refInSameSchool('Subject') },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true, immutable: true },
    teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true, immutable: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    type: { type: String, enum: MATERIAL_TYPES, required: true },
    link: { type: String, trim: true, maxlength: 2000 },

    status: { type: String, enum: MATERIAL_STATUSES, default: 'active', required: true },
    removedAt: { type: Date },
  },
  { timestamps: true }
);

learningMaterialSchema.index({ schoolId: 1, classId: 1, status: 1, createdAt: -1 });
learningMaterialSchema.index({ schoolId: 1, createdBy: 1, status: 1, createdAt: -1 });

export default mongoose.model('LearningMaterial', learningMaterialSchema);
