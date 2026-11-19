import { Class, Subject } from '../models/index.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { toSubjectView } from '../utils/serializers.js';
import { classScope, subjectScope } from './access.service.js';
import { diffFields, pickFields, recordAudit } from './audit.service.js';

// Subjects belong to a school. They are deactivated, never deleted, and deactivating one
// leaves it in every class and teacher record that already refers to it, so history stays
// readable. The subject code is fixed once created (printed records refer to it).

const auditSubject = (auth, subject, action, summary, details) =>
  recordAudit(auth, { action, entityType: 'subject', entityId: subject._id, summary, details: { code: subject.code, ...details } });

const present = (subject) => ({ subject: toSubjectView(subject) });

async function findManaged(auth, id) {
  const subject = await Subject.findOne({ _id: id, schoolId: auth.schoolId });
  if (!subject) throw notFound('Subject not found.');
  return subject;
}

// ------------------------------------------------------------------------ reading

export async function listSubjects(auth, { status, classId, page = 1, limit = 20 } = {}) {
  const clauses = [await subjectScope(auth)];
  if (status) clauses.push({ status });

  if (classId) {
    // Only subjects of a class the user is allowed to see.
    const klass = await Class.findOne({ $and: [await classScope(auth), { _id: classId }] }).select('subjectIds');
    if (!klass) throw notFound('Class not found.');
    clauses.push({ _id: { $in: klass.subjectIds } });
  }
  const filter = { $and: clauses };

  const [subjects, total] = await Promise.all([
    Subject.find(filter)
      .sort({ name: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Subject.countDocuments(filter),
  ]);
  return { items: subjects.map(toSubjectView), page, limit, total };
}

export async function getSubject(auth, id) {
  const scope = await subjectScope(auth);
  const subject = await Subject.findOne({ $and: [scope, { _id: id }] });
  if (!subject) throw notFound('Subject not found.');
  return present(subject);
}

// ------------------------------------------------------------------------ writing

export async function createSubject(auth, data) {
  const subject = await Subject.create({
    name: data.name,
    code: data.code,
    description: data.description,
    category: data.category,
    schoolId: auth.schoolId,
    status: 'active',
  });
  await auditSubject(auth, subject, 'subject.created', `Subject ${subject.name} (${subject.code}) created`, { name: subject.name });
  return present(subject); // a duplicate code in this school fails with 409
}

export async function updateSubject(auth, id, changes) {
  if (Object.keys(changes).length === 0) {
    throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  }
  const subject = await findManaged(auth, id);
  const keys = ['name', 'description', 'category'];
  const before = pickFields(subject, keys);
  if (changes.name !== undefined) subject.name = changes.name;
  if ('description' in changes) subject.description = changes.description ?? undefined; // null clears it
  if ('category' in changes) subject.category = changes.category ?? undefined;
  await subject.save();
  const diff = diffFields(before, pickFields(subject, keys), keys);
  if (diff.changed.length > 0) {
    await auditSubject(auth, subject, 'subject.updated', `Subject ${subject.code} updated: ${diff.changed.join(', ')}`, { before: diff.before, after: diff.after });
  }
  return present(subject);
}

export async function setSubjectStatus(auth, id, status) {
  const subject = await findManaged(auth, id);
  const previous = subject.status;
  subject.status = status;
  await subject.save();
  if (previous !== status) {
    await auditSubject(auth, subject, 'subject.status_changed', `Subject ${subject.code} ${previous} -> ${status}`, { before: { status: previous }, after: { status } });
  }
  return present(subject);
}
