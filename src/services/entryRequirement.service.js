import { EntryRequirement } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { toRequirementFullView, toRequirementPublicView, toRequirementSummary } from '../utils/serializers.js';
import { recordAudit } from './audit.service.js';
import { resolvePublicSchool } from './publicSchool.service.js';

// SCHOOL ENTRY REQUIREMENTS: the school's published ADMISSION POLICY. (Not anyone's application:
// individual student admissions are a different thing and are not handled here.)
//
// Every version is its own record and the history is simply the set of records:
//
//   draft      being written. The only state that can be edited. One draft per school at a time.
//   published  frozen for good, with its effective date and publication date.
//   archived   withdrawn from use; kept for reference.
//
// "Editing" published requirements = create a NEW version (a draft copied from the old one),
// change it, publish it. The earlier version is never touched. The CURRENT requirements are
// the published version with the latest effective date that has already begun; that is all the
// public website shows. Administrators see every version.
//
// Publishing is refused unless the new effective date is later than that of the previous
// published version, so versions always take effect in the order they were published.

const CONTENT = ['title', 'summary', 'sections', 'classRequirements', 'effectiveDate'];

const idOf = (value) => String(value);

async function currentVersion(schoolId, now = new Date()) {
  return EntryRequirement.findOne({ schoolId, status: 'published', effectiveDate: { $lte: now } }).sort({ effectiveDate: -1, versionNumber: -1 });
}

const draftExists = () =>
  new AppError(409, 'There is already a draft. Finish and publish it (or archive it) before starting another.', { code: 'DRAFT_EXISTS' });

async function findOwn(auth, id) {
  const requirement = await EntryRequirement.findOne({ _id: id, schoolId: auth.schoolId });
  if (!requirement) throw notFound('Entry requirements not found.');
  return requirement;
}

// Creates the next version number as a draft. The unique indexes (one version number, and one
// draft, per school) make double clicks and two administrators at once safe.
async function createVersion(auth, content, basedOnVersion) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await EntryRequirement.exists({ schoolId: auth.schoolId, status: 'draft' })) throw draftExists();
    const last = await EntryRequirement.findOne({ schoolId: auth.schoolId }).sort({ versionNumber: -1 }).select('versionNumber');
    try {
      return await EntryRequirement.create({
        schoolId: auth.schoolId,
        versionNumber: (last?.versionNumber ?? 0) + 1,
        ...(basedOnVersion && { basedOnVersion }),
        ...content,
        status: 'draft',
        createdBy: auth.userId,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      if (await EntryRequirement.exists({ schoolId: auth.schoolId, status: 'draft' })) throw draftExists();
      // otherwise another version number was taken at the same moment: try again
    }
  }
  throw new AppError(409, 'Could not create a new version. Please try again.', { code: 'VERSION_CONFLICT' });
}

const view = async (auth, requirement) => {
  const current = await currentVersion(auth.schoolId);
  return { requirement: toRequirementFullView(requirement, { isCurrent: Boolean(current) && idOf(current._id) === idOf(requirement._id) }) };
};

// ------------------------------------------------------------------ administrators

// A new, blank draft (the very first version, or a fresh start).
export async function createDraft(auth, content) {
  const draft = await createVersion(auth, content);
  await recordAudit(auth, {
    action: 'entry_requirements.draft_created',
    entityType: 'entry_requirements',
    entityId: draft._id,
    summary: `Entry requirements version ${draft.versionNumber} started`,
    details: { versionNumber: draft.versionNumber },
  });
  return view(auth, draft);
}

// A draft copied from an existing version: how published requirements are "edited".
export async function createVersionFrom(auth, id) {
  const source = await findOwn(auth, id);
  if (source.status === 'draft') {
    throw new AppError(409, 'This version is still a draft. Edit it directly.', { code: 'ALREADY_DRAFT' });
  }
  const draft = await createVersion(
    auth,
    {
      title: source.title,
      summary: source.summary,
      sections: source.sections.map((s) => s.toObject?.() ?? s),
      classRequirements: source.classRequirements.map((c) => c.toObject?.() ?? c),
      // The effective date is chosen when the new version is published.
    },
    source.versionNumber
  );
  await recordAudit(auth, {
    action: 'entry_requirements.version_created',
    entityType: 'entry_requirements',
    entityId: draft._id,
    summary: `Entry requirements version ${draft.versionNumber} started from version ${source.versionNumber}`,
    details: { versionNumber: draft.versionNumber, basedOnVersion: source.versionNumber },
  });
  return view(auth, draft);
}

export async function updateDraft(auth, id, changes) {
  if (Object.keys(changes).length === 0) throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  const requirement = await findOwn(auth, id);
  if (requirement.status !== 'draft') {
    throw new AppError(409, 'Published versions cannot be edited. Create a new version and change that instead.', { code: 'REQUIREMENT_NOT_EDITABLE' });
  }
  const set = Object.fromEntries(CONTENT.filter((k) => changes[k] !== undefined).map((k) => [k, changes[k]]));
  // Conditional on "still a draft": if it was published a moment ago, nothing is changed.
  const updated = await EntryRequirement.findOneAndUpdate(
    { _id: requirement._id, schoolId: auth.schoolId, status: 'draft' },
    { $set: { ...set, updatedBy: auth.userId } },
    { new: true, runValidators: true }
  );
  if (!updated) throw new AppError(409, 'This version was published or archived meanwhile. Reload.', { code: 'REQUIREMENT_NOT_EDITABLE' });
  await recordAudit(auth, {
    action: 'entry_requirements.draft_updated',
    entityType: 'entry_requirements',
    entityId: updated._id,
    summary: `Entry requirements version ${updated.versionNumber} edited`,
    details: { fields: Object.keys(set) },
  });
  return view(auth, updated);
}

export async function publishVersion(auth, id, { effectiveDate } = {}) {
  const requirement = await findOwn(auth, id);
  if (requirement.status !== 'draft') {
    throw new AppError(409, requirement.status === 'published' ? 'This version is already published.' : 'Archived versions cannot be published.', {
      code: requirement.status === 'published' ? 'ALREADY_PUBLISHED' : 'REQUIREMENT_ARCHIVED',
    });
  }
  const effective = effectiveDate ?? requirement.effectiveDate;
  const problems = [];
  if (!effective) problems.push({ field: 'effectiveDate', message: 'An effective date is required to publish.' });
  if (requirement.sections.length + requirement.classRequirements.length === 0) {
    problems.push({ field: 'sections', message: 'Add at least one section or class requirement before publishing.' });
  }
  const previous = await EntryRequirement.findOne({ schoolId: auth.schoolId, status: 'published' }).sort({ effectiveDate: -1, versionNumber: -1 });
  if (effective && previous?.effectiveDate && effective <= previous.effectiveDate) {
    problems.push({
      field: 'effectiveDate',
      message: `must be after ${previous.effectiveDate.toISOString().slice(0, 10)}, when version ${previous.versionNumber} took effect.`,
    });
  }
  if (problems.length > 0) throw badRequest('This version cannot be published yet.', { code: 'VALIDATION_ERROR', details: problems });

  const published = await EntryRequirement.findOneAndUpdate(
    { _id: requirement._id, schoolId: auth.schoolId, status: 'draft' },
    { $set: { status: 'published', effectiveDate: effective, publishedAt: new Date(), publishedBy: auth.userId, updatedBy: auth.userId } },
    { new: true, runValidators: true }
  );
  if (!published) throw new AppError(409, 'This version was changed meanwhile. Reload.', { code: 'REQUIREMENT_NOT_EDITABLE' });
  await recordAudit(auth, {
    action: 'entry_requirements.published',
    entityType: 'entry_requirements',
    entityId: published._id,
    summary: `Entry requirements version ${published.versionNumber} published`,
    details: { versionNumber: published.versionNumber, effectiveDate: effective, previousVersion: previous?.versionNumber ?? null },
  });
  return view(auth, published);
}

// Withdraws a draft, or a published version that is not the one in force. The version that is
// currently shown to the public cannot be archived: publish its replacement instead.
export async function archiveVersion(auth, id, { reason }) {
  const requirement = await findOwn(auth, id);
  if (requirement.status === 'archived') throw new AppError(409, 'This version is already archived.', { code: 'REQUIREMENT_ARCHIVED' });
  if (requirement.status === 'published') {
    const current = await currentVersion(auth.schoolId);
    if (current && idOf(current._id) === idOf(requirement._id)) {
      throw new AppError(409, 'This is the version the public website shows now. Publish a newer version first.', { code: 'CURRENT_REQUIREMENT' });
    }
  }
  const archived = await EntryRequirement.findOneAndUpdate(
    { _id: requirement._id, schoolId: auth.schoolId, status: requirement.status },
    { $set: { status: 'archived', archivedAt: new Date(), archivedBy: auth.userId, archiveReason: reason } },
    { new: true }
  );
  if (!archived) throw new AppError(409, 'This version was changed meanwhile. Reload.', { code: 'REQUIREMENT_NOT_EDITABLE' });
  await recordAudit(auth, {
    action: 'entry_requirements.archived',
    entityType: 'entry_requirements',
    entityId: archived._id,
    summary: `Entry requirements version ${archived.versionNumber} archived`,
    details: { versionNumber: archived.versionNumber, reason, wasStatus: requirement.status },
  });
  return view(auth, archived);
}

export async function listVersions(auth, { status, page = 1, limit = 20 } = {}) {
  const filter = { schoolId: auth.schoolId, ...(status && { status }) };
  const [items, total, current] = await Promise.all([
    EntryRequirement.find(filter).sort({ versionNumber: -1 }).skip((page - 1) * limit).limit(limit),
    EntryRequirement.countDocuments(filter),
    currentVersion(auth.schoolId),
  ]);
  return { items: items.map((r) => toRequirementSummary(r, { isCurrent: Boolean(current) && idOf(current._id) === idOf(r._id) })), page, limit, total };
}

export async function getVersion(auth, id) {
  return view(auth, await findOwn(auth, id));
}

// ------------------------------------------------------------------ the public website

export async function getPublicRequirements({ schoolCode } = {}) {
  const school = await resolvePublicSchool(schoolCode);
  const current = await currentVersion(school._id);
  if (!current) throw notFound('No entry requirements have been published yet.');
  return { requirements: toRequirementPublicView(current) };
}
