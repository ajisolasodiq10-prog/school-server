import mongoose from 'mongoose';

export const EVENT_TYPES = ['examination', 'resumption', 'holiday', 'meeting', 'event', 'deadline'];

// A date on the school calendar (an examination period, a holiday, a meeting, a deadline...).
// Written by administrators; everyone signed in can read it. An event that has been removed is
// really removed; the audit log keeps the record of who did it.
const calendarEventSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 2000 },
    startDate: { type: Date, required: true },
    endDate: { type: Date }, // optional: a one-day event has none
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

calendarEventSchema.pre('validate', function () {
  if (this.endDate && this.startDate && this.endDate < this.startDate) {
    this.invalidate('endDate', 'The end date cannot be before the start date.');
  }
});

calendarEventSchema.index({ schoolId: 1, startDate: 1 });

export default mongoose.model('CalendarEvent', calendarEventSchema);
