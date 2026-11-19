import { AcademicSession, Class, LearningMaterial, Subject, Teacher } from '../models/index.js';
import { AppError, badRequest, forbidden, notFound } from '../utils/AppError.js';
import { toMaterialView } from '../utils/serializers.js';
import { getEnrolledClassIds, getTeacherScope } from './access.service.js';
import { recordAudit } from './audit.service.js';

// LEARNING MATERIALS
//   teacher   adds materials ONLY for a class and subject they are assigned to, and sees and
//             changes ONLY their own. "Remove" hides a material; the record stays.
//   admin     sees every material in the school and may remove one.
//   student / parent   the materials of the student's CURRENT class (the route refuses students
//             whose status does not allow learning materials).
// A material is a title, a description and a link (no file uploads).

const idOf = (v) => String(v);
const linkPattern = /^(https?:\/\/[^\s]+|\/[^\s]*)$/i;
const invalid = (field, message) => badRequest('Invalid material.', { code: 'VALIDATION_ERROR', details: [{ field, message }] });

function checkLink(type, link) {
  if (type === 'link' && !link) throw invalid('link', 'Add the link for this material.');
  if (link && !linkPattern.test(link)) throw invalid('link', 'Enter a web address starting with https://.');
}

async function requireTeacher(auth) {
  const scope = await getTeacherScope(auth);
  if (!scope.teacher) throw forbidden('Your teacher account is not active. Contact your school administrator.', 'TEACHER_NOT_ACTIVE');
  return scope;
}

async function referencesFor(schoolId, materials) {
  const ids = (key) => [...new Set(materials.map((m) => idOf(m[key])))];
  const [subjects, classes, teachers] = await Promise.all([
    Subject.find({ _id: { $in: ids('subjectId') }, schoolId }).select('name code'),
    Class.find({ _id: { $in: ids('classId') }, schoolId }).select('name arm'),
    Teacher.find({ _id: { $in: ids('teacherId') }, schoolId }).select('firstName middleName lastName'),
  ]);
  const byId = (docs) => new Map(docs.map((d) => [idOf(d._id), d]));
  return { subjects: byId(subjects), classes: byId(classes), teachers: byId(teachers) };
}

export async function createMaterial(auth, { classId, subjectId, title, description, type, link }) {
  const scope = await requireTeacher(auth);
  checkLink(type, link);
  const klass = await Class.findOne({ _id: classId, schoolId: auth.schoolId });
  if (!klass) throw notFound('Class not found.');
  if (!scope.classIds.some((id) => idOf(id) === idOf(klass._id))) throw forbidden('You are not assigned to this class.', 'NOT_ASSIGNED_TO_CLASS');
  const subject = await Subject.findOne({ _id: subjectId, schoolId: auth.schoolId });
  if (!subject) throw notFound('Subject not found.');
  if (!scope.subjectIds.some((id) => idOf(id) === idOf(subject._id))) throw forbidden('You are not assigned to teach this subject.', 'NOT_ASSIGNED_TO_SUBJECT');
  if (!klass.subjectIds.some((id) => idOf(id) === idOf(subject._id))) throw badRequest('This subject is not offered in this class.', { code: 'SUBJECT_NOT_IN_CLASS' });
  if (klass.status !== 'active' || subject.status !== 'active') {
    throw new AppError(409, 'Materials can only be added for an active class and an active subject.', { code: 'CLASS_OR_SUBJECT_INACTIVE' });
  }
  const session = await AcademicSession.findOne({ _id: klass.academicSessionId, schoolId: auth.schoolId });
  if (!session || session.status === 'closed') throw new AppError(409, "This class's academic session is closed.", { code: 'SESSION_CLOSED' });

  const material = await LearningMaterial.create({
    schoolId: auth.schoolId,
    classId: klass._id,
    subjectId: subject._id,
    academicSessionId: klass.academicSessionId,
    teacherId: scope.teacher._id,
    createdBy: auth.userId,
    title,
    description,
    type,
    ...(link && { link }),
  });
  await recordAudit(auth, {
    action: 'material.created',
    entityType: 'learning_material',
    entityId: material._id,
    summary: `Learning material "${title}" added for ${klass.name}${klass.arm} (${subject.name})`,
  });
  return toMaterialView(material, await referencesFor(auth.schoolId, [material]));
}

async function findManageable(auth, id) {
  const filter = { _id: id, schoolId: auth.schoolId, status: 'active' };
  if (auth.role === 'teacher') filter.createdBy = auth.userId;
  const material = await LearningMaterial.findOne(filter);
  if (!material) throw notFound('Material not found.');
  return material;
}

export async function updateMaterial(auth, id, changes) {
  if (Object.keys(changes).length === 0) throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  const material = await findManageable(auth, id);
  const type = changes.type ?? material.type;
  const link = changes.link === undefined ? material.link : changes.link;
  checkLink(type, link);
  for (const key of ['title', 'description', 'type', 'link']) if (changes[key] !== undefined) material.set(key, changes[key] ?? undefined);
  material.updatedBy = auth.userId;
  await material.save();
  await recordAudit(auth, { action: 'material.updated', entityType: 'learning_material', entityId: material._id, summary: `Learning material "${material.title}" updated`, details: { fields: Object.keys(changes) } });
  return toMaterialView(material, await referencesFor(auth.schoolId, [material]));
}

export async function removeMaterial(auth, id) {
  const material = await findManageable(auth, id);
  material.status = 'removed';
  material.removedAt = new Date();
  material.updatedBy = auth.userId;
  await material.save();
  await recordAudit(auth, { action: 'material.removed', entityType: 'learning_material', entityId: material._id, summary: `Learning material "${material.title}" removed` });
  return { removed: true };
}

export async function listMaterials(auth, { classId, subjectId, page = 1, limit = 50 } = {}) {
  const filter = { schoolId: auth.schoolId, status: 'active' };
  if (auth.role === 'teacher') {
    await requireTeacher(auth);
    filter.createdBy = auth.userId;
    if (classId) filter.classId = classId;
  } else if (auth.role === 'admin') {
    if (classId) filter.classId = classId;
  } else {
    const enrolled = (await getEnrolledClassIds(auth)).map(idOf).filter((c) => !classId || c === classId);
    filter.classId = { $in: enrolled };
  }
  if (subjectId) filter.subjectId = subjectId;
  const [items, total] = await Promise.all([
    LearningMaterial.find(filter).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit),
    LearningMaterial.countDocuments(filter),
  ]);
  const refs = await referencesFor(auth.schoolId, items);
  return { items: items.map((m) => toMaterialView(m, refs)), page, limit, total };
}

