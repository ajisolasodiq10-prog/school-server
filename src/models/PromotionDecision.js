import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const PROMOTION_VALUES = ['promoted', 'repeated'];
export const PROMOTION_STATUSES = ['recommended', 'confirmed'];

// One promotion decision per student per academic session, tied to the class the student was
// in during that session. A teacher RECOMMENDS; only an administrator CONFIRMS. Nothing here
// moves a student: classes change only when a new session is started (sessionRollover).
const promotionDecisionSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    academicSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'AcademicSession', required: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },

    recommendation: { type: String, enum: PROMOTION_VALUES },
    recommendedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recommendedAt: { type: Date },

    decision: { type: String, enum: PROMOTION_VALUES },
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    confirmedAt: { type: Date },

    status: { type: String, enum: PROMOTION_STATUSES, required: true },

    // Set when a session rollover has acted on the decision. After that it is history.
    appliedAt: { type: Date },
    rolloverId: { type: mongoose.Schema.Types.ObjectId, ref: 'SessionRollover' },
  },
  { timestamps: true }
);

promotionDecisionSchema.index({ schoolId: 1, studentId: 1, academicSessionId: 1 }, { unique: true });
promotionDecisionSchema.index({ schoolId: 1, academicSessionId: 1, classId: 1, status: 1 });

promotionDecisionSchema.plugin(protectFromHardDelete, { label: 'Promotion decision' });

export default mongoose.model('PromotionDecision', promotionDecisionSchema);
