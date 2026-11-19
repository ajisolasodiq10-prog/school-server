import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const ROLLOVER_STATUSES = ['running', 'completed', 'failed'];

// One record per attempt to start a new session. It makes the operation safe to repeat:
// the unique index below allows only ONE running-or-completed rollover per previous session,
// so a double click or a retry can never promote students twice. A failed attempt (rolled
// back) stops counting, so the administrator can try again.
const sessionRolloverSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
    fromSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
    newSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession' },
    name: { type: String, required: true }, // name of the new session
    status: { type: String, enum: ROLLOVER_STATUSES, required: true },
    startedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date },
    summary: { type: mongoose.Schema.Types.Mixed },
    failure: { type: String, maxlength: 500 },
  },
  { timestamps: true }
);

const ACTIVE = { status: { $in: ['running', 'completed'] } };
sessionRolloverSchema.index(
  { schoolId: 1, fromSessionId: 1 },
  { unique: true, partialFilterExpression: ACTIVE, name: 'one_rollover_per_session' }
);
sessionRolloverSchema.index(
  { schoolId: 1, name: 1 },
  { unique: true, partialFilterExpression: ACTIVE, name: 'one_rollover_per_new_name' }
);

sessionRolloverSchema.plugin(protectFromHardDelete, { label: 'Session rollover' });

export default mongoose.model('SessionRollover', sessionRolloverSchema);
