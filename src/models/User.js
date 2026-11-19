import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const USER_ROLES = ['admin', 'teacher', 'student', 'parent'];
// School-side access flag, managed by school administration. It is NOT the account status.
export const USER_STATUSES = ['active', 'inactive', 'suspended'];
// Status of the login account, owned by the Account Management Backend. This backend only
// mirrors it (the live value is always asked from the account service before access is granted).
export const ACCOUNT_STATUSES = ['pending_activation', 'active', 'deactivated', 'suspended'];

// The school's record of a person who can sign in. Credentials are NOT stored here: no password,
// no hash, no reset or activation tokens. They belong to the Account Management Backend, which
// is linked through `accountId`. Mongoose's strict mode drops unknown fields, so a password can
// never be saved on this record by accident.
const userSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School is required.'],
    },
    fullName: {
      type: String,
      required: [true, 'Full name is required.'],
      trim: true,
      maxlength: 150,
    },
    // Optional (students and some parents may not have one; teachers always do), but unique per school when present.
    email: {
      type: String,
      trim: true,
      lowercase: true,
      set: (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email is not valid.'],
    },
    // The login ID (can be a student ID such as "jss/2026/001"). Stored lower-case.
    username: {
      type: String,
      required: [true, 'Username is required.'],
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 40,
      match: [
        /^[a-z0-9][a-z0-9._/-]*$/,
        'Username may only contain letters, numbers, dots, underscores, hyphens and slashes.',
      ],
    },
    // Stable reference to the credentials owned by the Account Management Backend. Absent only
    // while the account is being created (or for an old record not yet migrated).
    accountId: { type: String, trim: true, maxlength: 100 },
    accountStatus: { type: String, enum: ACCOUNT_STATUSES, default: 'pending_activation', required: true },
    accountStatusSyncedAt: { type: Date },
    role: {
      type: String,
      enum: USER_ROLES,
      required: [true, 'Role is required.'],
    },
    status: {
      type: String,
      enum: USER_STATUSES,
      default: 'active',
      required: true,
    },
    lastLoginAt: { type: Date },
  },
  {
    timestamps: true, // createdAt = creation date
    toJSON: { versionKey: false },
  }
);

// Unique within a school, not globally.
userSchema.index({ schoolId: 1, username: 1 }, { unique: true });
// Unique within a school only when an email exists (users without email don't collide).
userSchema.index(
  { schoolId: 1, email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } }
);
// Listing accounts by role/status.
userSchema.index({ schoolId: 1, role: 1, status: 1 });
// One school record per account; authentication looks the person up by it.
userSchema.index({ accountId: 1 }, { unique: true, partialFilterExpression: { accountId: { $type: 'string' } } });

userSchema.plugin(protectFromHardDelete, { label: 'User' });

export default mongoose.model('User', userSchema);
