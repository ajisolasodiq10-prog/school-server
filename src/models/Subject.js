import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const SUBJECT_STATUSES = ['active', 'inactive'];
export const SUBJECT_CATEGORIES = ['Junior', 'Core', 'Science', 'Arts', 'Commercial'];

const subjectSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School is required.'],
    },
    name: {
      type: String,
      required: [true, 'Subject name is required.'],
      trim: true,
      maxlength: 100,
    },
    // e.g. "MTH", "ENG". Stored upper-case.
    code: {
      type: String,
      required: [true, 'Subject code is required.'],
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 20,
      match: [/^[A-Z0-9_-]+$/, 'Subject code may only contain letters, numbers, hyphens and underscores.'],
    },
    description: { type: String, trim: true, maxlength: 500 },
    category: { type: String, enum: SUBJECT_CATEGORIES },
    status: {
      type: String,
      enum: SUBJECT_STATUSES,
      default: 'active',
      required: true,
    },
  },
  { timestamps: true }
);

subjectSchema.index({ schoolId: 1, code: 1 }, { unique: true });
subjectSchema.index({ schoolId: 1, status: 1, name: 1 });

subjectSchema.plugin(protectFromHardDelete, { label: 'Subject' });

export default mongoose.model('Subject', subjectSchema);
