import mongoose from 'mongoose';

// Details an administrator edits about themselves (administrators have no other profile record).
// Their name and email belong to their login account and are not edited here.
const userProfileSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    title: { type: String, trim: true, maxlength: 20 },
    phone: { type: String, trim: true, maxlength: 30 },
    bio: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

userProfileSchema.index({ schoolId: 1, userId: 1 }, { unique: true });

export default mongoose.model('UserProfile', userProfileSchema);
