import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const PIN_STATUSES = ['active', 'redeemed', 'revoked'];

// A result PIN unlocks ONE student's results for ONE term of ONE session, once.
//
// The PIN itself is never stored: only a salted scrypt hash. The plaintext exists only in
// the response to the administrator who generated it, and cannot be recovered afterwards.
// pinHash and salt are never selected by default and are immutable.
//
// `live` is true while the PIN is active or redeemed. A partial unique index on it allows
// exactly one live PIN per student and term (no duplicate generation), while a revoked PIN
// stays on record and a replacement can be issued.
const resultPinSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
    termId: { type: mongoose.Schema.Types.ObjectId, required: true },

    pinHash: { type: String, required: true, select: false, immutable: true },
    salt: { type: String, required: true, select: false, immutable: true },

    status: { type: String, enum: PIN_STATUSES, default: 'active', required: true },
    live: { type: Boolean, default: true, required: true },

    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    // Set for PINs created together by one bulk request.
    batchId: { type: mongoose.Schema.Types.ObjectId, immutable: true },

    redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    redeemedByRole: { type: String, enum: ['student', 'parent'] },
    redeemedAt: { type: Date },

    revokedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    revokedAt: { type: Date },
    revokeReason: { type: String, maxlength: 500 },

    // Wrong guesses against this PIN (for administrators to spot guessing).
    failedAttempts: { type: Number, default: 0, min: 0 },
    lastFailedAt: { type: Date },
  },
  { timestamps: true }
);

resultPinSchema.index(
  { schoolId: 1, studentId: 1, academicSessionId: 1, termId: 1 },
  { unique: true, partialFilterExpression: { live: true }, name: 'one_live_pin_per_student_term' }
);
resultPinSchema.index({ schoolId: 1, studentId: 1, createdAt: -1 });
resultPinSchema.index({ schoolId: 1, academicSessionId: 1, termId: 1, status: 1 });
resultPinSchema.index({ schoolId: 1, batchId: 1 }, { sparse: true });
// PIN statistics for a period (reports) are school-wide.
resultPinSchema.index({ schoolId: 1, createdAt: -1 });

resultPinSchema.plugin(protectFromHardDelete, { label: 'Result PIN' });

export default mongoose.model('ResultPin', resultPinSchema);
