import mongoose from 'mongoose';
import protectFromHardDelete from './helpers/protectFromHardDelete.js';

export const REQUIREMENT_STATUSES = ['draft', 'published', 'archived'];
export const SECTION_KINDS = ['general', 'age', 'qualifications', 'documents', 'entrance_exam', 'procedure', 'policy', 'other'];

// The school's published ADMISSION POLICY (not anyone's application). Every version is its
// own document, so history is the set of documents:
//
//   draft      being written; the only state whose content can change. One draft at a time.
//   published  frozen for good. It stays on record with its effective date and publication date.
//   archived   withdrawn; kept for reference, never shown publicly again.
//
// "Editing" a published policy means creating a NEW version from it (a copy, as a draft) and
// publishing that. The public site shows the published version with the latest effective
// date that has already begun.
const sectionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: SECTION_KINDS, required: true },
    title: { type: String, required: true, trim: true, maxlength: 150 },
    body: { type: String, trim: true, maxlength: 3000 },
    items: { type: [{ type: String, trim: true, maxlength: 500 }], default: [] },
  },
  { _id: false }
);

const classRequirementSchema = new mongoose.Schema(
  {
    classLevel: { type: String, required: true, trim: true, maxlength: 30 }, // "JSS 1"
    items: { type: [{ type: String, trim: true, maxlength: 500 }], default: [] },
    notes: { type: String, trim: true, maxlength: 2000 },
  },
  { _id: false }
);

const CONTENT_FIELDS = ['title', 'summary', 'sections', 'classRequirements', 'effectiveDate'];
const LIFECYCLE_FIELDS = ['status', 'publishedAt', 'publishedBy', 'archivedAt', 'archivedBy', 'archiveReason', 'updatedAt'];

const entryRequirementSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: 'School', required: true, immutable: true },
    versionNumber: { type: Number, required: true, min: 1, immutable: true },
    basedOnVersion: { type: Number, min: 1, immutable: true }, // the version this one was copied from

    title: { type: String, required: true, trim: true, maxlength: 200 },
    summary: { type: String, trim: true, maxlength: 3000 },
    sections: { type: [sectionSchema], default: [], validate: [(v) => v.length <= 20, 'At most 20 sections.'] },
    classRequirements: { type: [classRequirementSchema], default: [], validate: [(v) => v.length <= 30, 'At most 30 class entries.'] },
    // From this date the version is the current policy. Required to publish.
    effectiveDate: { type: Date },

    status: { type: String, enum: REQUIREMENT_STATUSES, default: 'draft', required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    archivedAt: { type: Date },
    archiveReason: { type: String, trim: true, maxlength: 500 },
  },
  { timestamps: true }
);

entryRequirementSchema.index({ schoolId: 1, versionNumber: 1 }, { unique: true });
// At most ONE draft per school: stops two administrators drifting apart, and makes
// "create a new version" safe against double clicks.
entryRequirementSchema.index({ schoolId: 1 }, { unique: true, partialFilterExpression: { status: 'draft' }, name: 'one_draft_per_school' });
entryRequirementSchema.index({ schoolId: 1, status: 1, effectiveDate: -1, versionNumber: -1 });

// ---- published history is never rewritten ------------------------------------------------
// Content can only change while the record is a draft. The service always writes with a
// conditional update (filter status: 'draft'); these hooks refuse anything else, so even a
// careless future caller cannot alter a published or archived version.
const refuse = () => {
  throw new Error('Published requirement versions cannot be changed. Create a new version instead.');
};

entryRequirementSchema.pre('save', function () {
  if (this.isNew) return;
  const touched = CONTENT_FIELDS.filter((f) => this.isModified(f));
  if (touched.length > 0 && this.status !== 'draft') refuse();
});

entryRequirementSchema.pre(['updateOne', 'updateMany', 'replaceOne', 'findOneAndReplace'], refuse);

entryRequirementSchema.pre('findOneAndUpdate', function () {
  const filter = this.getFilter();
  const update = this.getUpdate() ?? {};
  const set = { ...(update.$set ?? {}) };
  const keys = [...Object.keys(set), ...Object.keys(update).filter((k) => !k.startsWith('$'))];
  const fromDraft = filter.status === 'draft';
  const lifecycleOnly = keys.every((k) => LIFECYCLE_FIELDS.includes(k)) && Object.keys(update).every((k) => k === '$set' || !k.startsWith('$'));
  if (!fromDraft && !lifecycleOnly) refuse();
});

entryRequirementSchema.plugin(protectFromHardDelete, { label: 'Entry requirement' });

export default mongoose.model('EntryRequirement', entryRequirementSchema);
