import { Student, User } from '../models/index.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { toPublicUser, toStudentSummary } from '../utils/serializers.js';
import { recordAudit } from './audit.service.js';

// Parent management for school administrators. Parent accounts are created only by an
// administrator (POST /api/parents or /api/accounts/parents); there is no public sign-up.
//
// A parent can see a student ONLY when that student's record lists the parent's account in
// guardianUserIds (access.service.studentScope). Linking and unlinking edit that list and
// nothing else: no student record, result or account is ever deleted. Every query filters on
// auth.schoolId, which comes from the authenticated administrator.

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function findParent(auth, id) {
  const parent = await User.findOne({ _id: id, schoolId: auth.schoolId, role: 'parent' });
  if (!parent) throw notFound('Parent not found.');
  return parent;
}

// Every child linked to each of the given parents, grouped by parent id.
async function childrenByParent(auth, parentIds) {
  const children = await Student.find({ schoolId: auth.schoolId, guardianUserIds: { $in: parentIds } }).sort({
    lastName: 1,
    firstName: 1,
  });
  const grouped = new Map(parentIds.map((id) => [String(id), []]));
  for (const child of children) {
    for (const guardian of child.guardianUserIds) grouped.get(String(guardian))?.push(toStudentSummary(child));
  }
  return grouped;
}

const auditLink = (auth, parent, studentId, action, verb) =>
  recordAudit(auth, {
    action,
    entityType: 'user',
    entityId: parent._id,
    studentId,
    summary: `Parent ${parent.fullName} ${verb} a student`,
    details: { parentId: parent._id, studentId },
  });

const present = (parent, children) => ({ user: toPublicUser(parent), children });

export async function listParents(auth, { q, status, page = 1, limit = 20 } = {}) {
  const filter = { schoolId: auth.schoolId, role: 'parent', ...(status && { status }) };
  const tokens = (q || '').split(' ').filter(Boolean);
  if (tokens.length > 0) {
    filter.$and = tokens.map((token) => {
      const pattern = new RegExp(escapeRegex(token), 'i');
      return { $or: ['fullName', 'username', 'email'].map((f) => ({ [f]: pattern })) };
    });
  }
  const [parents, total] = await Promise.all([
    User.find(filter)
      .sort({ fullName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  const grouped = await childrenByParent(auth, parents.map((p) => p._id));
  return { items: parents.map((p) => present(p, grouped.get(String(p._id)))), page, limit, total };
}

export async function getParent(auth, id) {
  const parent = await findParent(auth, id);
  return present(parent, (await childrenByParent(auth, [parent._id])).get(String(parent._id)));
}

// Links one more child to a parent. Linking the same child twice changes nothing.
export async function linkStudent(auth, parentId, studentId) {
  const parent = await findParent(auth, parentId);
  const student = await Student.findOne({ _id: studentId, schoolId: auth.schoolId }).select('_id');
  if (!student) throw notFound('Student not found.');

  const linked = await Student.updateOne(
    { _id: student._id, schoolId: auth.schoolId },
    { $addToSet: { guardianUserIds: parent._id } }
  );
  if (linked.modifiedCount > 0) await auditLink(auth, parent, student._id, 'parent.student_linked', 'linked to');
  return present(parent, (await childrenByParent(auth, [parent._id])).get(String(parent._id)));
}

// Removes a wrong link. The student and the parent both stay; only the link goes.
export async function unlinkStudent(auth, parentId, studentId) {
  const parent = await findParent(auth, parentId);
  const result = await Student.updateOne(
    { _id: studentId, schoolId: auth.schoolId, guardianUserIds: parent._id },
    { $pull: { guardianUserIds: parent._id } }
  );
  if (result.matchedCount === 0) {
    throw badRequest('That student is not linked to this parent.', { code: 'NOT_LINKED' });
  }
  await auditLink(auth, parent, studentId, 'parent.student_unlinked', 'unlinked from');
  return present(parent, (await childrenByParent(auth, [parent._id])).get(String(parent._id)));
}
