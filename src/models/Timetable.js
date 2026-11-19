import mongoose from 'mongoose';
import { refInSameSchool } from './helpers/refValidators.js';

export const TIMETABLE_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// The weekly timetable of ONE class: the same periods every day, and for each day the lesson in
// every teaching period. `lessons` of a day lines up with the periods that are NOT breaks
// (first lesson = first teaching period, and so on).
const periodSchema = new mongoose.Schema(
  {
    start: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    end: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    breakLabel: { type: String, trim: true, maxlength: 60 }, // set = a break (no lesson)
  },
  { _id: false }
);

const lessonSchema = new mongoose.Schema(
  {
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },
    room: { type: String, trim: true, maxlength: 60 },
  },
  { _id: false }
);

const daySchema = new mongoose.Schema(
  {
    name: { type: String, enum: TIMETABLE_DAYS, required: true },
    lessons: { type: [lessonSchema], default: [] },
  },
  { _id: false }
);

const timetableSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true, immutable: true, validate: refInSameSchool('Class') },
    periods: { type: [periodSchema], default: [] },
    days: { type: [daySchema], default: [] },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

timetableSchema.index({ schoolId: 1, classId: 1 }, { unique: true });

export default mongoose.model('Timetable', timetableSchema);
