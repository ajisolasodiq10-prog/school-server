import mongoose from 'mongoose';

// One document per school: the scoring structure and result display options the administrator
// sets on the School Settings page. Until the administrator saves, the defaults in
// services/settings.service.js apply (the school's own name, address and contact details come
// from the School record).
const bandSchema = new mongoose.Schema(
  {
    grade: { type: String, required: true, trim: true, maxlength: 2 },
    remark: { type: String, trim: true, maxlength: 30, default: '' },
    min: { type: Number, required: true, min: 0, max: 100 }, // lowest percentage for the grade
  },
  { _id: false }
);

const schoolSettingsSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true, unique: true },
    schoolName: { type: String, required: true, trim: true, maxlength: 150 },
    address: { type: String, trim: true, maxlength: 300, default: '' },
    email: { type: String, trim: true, lowercase: true, maxlength: 254, default: '' },
    phone: { type: String, trim: true, maxlength: 30, default: '' },
    caMax: { type: Number, required: true, min: 1, max: 99 },
    examMax: { type: Number, required: true, min: 1, max: 99 },
    gradeBands: { type: [bandSchema], default: [] }, // highest grade first
    showGrade: { type: Boolean, default: true },
    showClassAverage: { type: Boolean, default: true },
    showRemarks: { type: Boolean, default: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

export default mongoose.model('SchoolSettings', schoolSettingsSchema);
