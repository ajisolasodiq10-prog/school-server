import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const TERM_NAMES = ['First Term', 'Second Term', 'Third Term'];
export const SESSION_STATUSES = ['upcoming', 'open', 'closed'];
export const TERM_STATUSES = ['upcoming', 'open', 'closed'];

// Terms live inside their session (a session always has at most three), so they are
// embedded rather than a separate collection. Each term gets its own _id so that later
// records (results, attendance) can refer to a specific term of a session.
const termSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      enum: TERM_NAMES,
      required: [true, 'Term name is required.'],
    },
    startDate: { type: Date, required: [true, 'Term start date is required.'] },
    endDate: { type: Date, required: [true, 'Term end date is required.'] },
    status: {
      type: String,
      enum: TERM_STATUSES,
      default: 'upcoming',
      required: true,
    },
    isCurrent: { type: Boolean, default: false },
  },
  { _id: true }
);

const academicSessionSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'School',
      required: [true, 'School is required.'],
    },
    // e.g. "2026/2027"
    name: {
      type: String,
      required: [true, 'Session name is required.'],
      trim: true,
      match: [/^\d{4}\/\d{4}$/, 'Session name must look like 2026/2027.'],
    },
    startDate: { type: Date, required: [true, 'Session start date is required.'] },
    endDate: { type: Date, required: [true, 'Session end date is required.'] },
    terms: {
      type: [termSchema],
      validate: {
        validator: (terms) => terms.length <= 3,
        message: 'A session can have at most three terms.',
      },
    },
    isCurrent: { type: Boolean, default: false },
    status: {
      type: String,
      enum: SESSION_STATUSES,
      default: 'upcoming',
      required: true,
    },
  },
  { timestamps: true }
);

// Session-level and term-level rules that need to look at several fields together.
academicSessionSchema.pre('validate', function () {
  const years = /^(\d{4})\/(\d{4})$/.exec(this.name || '');
  if (years && Number(years[2]) !== Number(years[1]) + 1) {
    this.invalidate('name', 'Session name must span consecutive years, e.g. 2026/2027.');
  }

  if (this.startDate && this.endDate && this.endDate <= this.startDate) {
    this.invalidate('endDate', 'Session end date must be after its start date.');
  }

  if (this.isCurrent && this.status !== 'open') {
    this.invalidate('status', 'The current session must be open.');
  }

  const terms = this.terms || [];

  const names = terms.map((term) => term.name).filter(Boolean);
  if (new Set(names).size !== names.length) {
    this.invalidate('terms', 'A session cannot contain the same term twice.');
  }

  const currentTerms = terms.filter((term) => term.isCurrent);
  if (currentTerms.length > 1) {
    this.invalidate('terms', 'Only one term can be marked as current.');
  }
  if (currentTerms.length === 1 && !this.isCurrent) {
    this.invalidate('terms', 'A term can only be current inside the current session.');
  }
  if (currentTerms.length === 1 && currentTerms[0].status !== 'open') {
    this.invalidate('terms', 'The current term must be open.');
  }

  const dated = terms.filter((term) => term.startDate && term.endDate);
  for (const term of dated) {
    if (term.endDate <= term.startDate) {
      this.invalidate('terms', `${term.name} must end after it starts.`);
    }
    if (
      this.startDate &&
      this.endDate &&
      (term.startDate < this.startDate || term.endDate > this.endDate)
    ) {
      this.invalidate('terms', `${term.name} must fall within the session dates.`);
    }
  }

  const ordered = [...dated].sort((a, b) => a.startDate - b.startDate);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i].startDate <= ordered[i - 1].endDate) {
      this.invalidate('terms', `${ordered[i - 1].name} and ${ordered[i].name} overlap.`);
    }
  }
});

// A school cannot have two sessions with the same name.
academicSessionSchema.index({ schoolId: 1, name: 1 }, { unique: true });
// At most ONE current session per school, enforced by the database itself.
// Because a term can only be current inside the current session (validated above) and
// only one term per session can be current, this also guarantees a single current
// session + term combination per school.
academicSessionSchema.index(
  { schoolId: 1 },
  {
    name: 'one_current_session_per_school',
    unique: true,
    partialFilterExpression: { isCurrent: true },
  }
);
// Newest sessions first.
academicSessionSchema.index({ schoolId: 1, startDate: -1 });

academicSessionSchema.plugin(protectFromHardDelete, { label: 'Academic session' });

export default mongoose.model('AcademicSession', academicSessionSchema);
