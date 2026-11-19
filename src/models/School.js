import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const SCHOOL_STATUSES = ['active', 'inactive'];

const schoolSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'School name is required.'],
      trim: true,
      maxlength: 150,
    },
    // Short unique identifier, e.g. "GSS-IKJ". Stored upper-case.
    code: {
      type: String,
      required: [true, 'School code is required.'],
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 20,
      match: [/^[A-Z0-9_-]+$/, 'School code may only contain letters, numbers, hyphens and underscores.'],
    },
    address: {
      type: String,
      required: [true, 'School address is required.'],
      trim: true,
      maxlength: 300,
    },
    contactEmail: {
      type: String,
      required: [true, 'Contact email is required.'],
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Contact email is not valid.'],
    },
    contactPhone: {
      type: String,
      required: [true, 'Contact phone is required.'],
      trim: true,
      match: [/^\+?[0-9\s-]{7,20}$/, 'Contact phone is not valid.'],
    },
    // Full http(s) URL or a site-relative path such as /uploads/logo.png
    logoUrl: {
      type: String,
      trim: true,
      match: [/^(https?:\/\/|\/).+/i, 'Logo URL must be an http(s) URL or a path starting with /.'],
    },
    // The school's class levels in promotion order. The LAST one is the final class: students
    // are never promoted past it automatically. Empty means the default Nigerian secondary
    // progression (see config/academic.js).
    classLevels: {
      type: [{ type: String, trim: true, uppercase: true, maxlength: 30 }],
      default: [],
    },
    status: {
      type: String,
      enum: SCHOOL_STATUSES,
      default: 'active',
      required: true,
    },
  },
  { timestamps: true } // createdAt = creation date
);

// School codes are the only globally unique value: every other collection is unique per school.
schoolSchema.index({ code: 1 }, { unique: true });

schoolSchema.plugin(protectFromHardDelete, { label: 'School' });

export default mongoose.model('School', schoolSchema);
