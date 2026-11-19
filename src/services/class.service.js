import { AcademicSession, Class, Subject, Teacher } from '../models/index.js';
import { AppError, badRequest, notFound } from '../utils/AppError.js';
import { toClassView } from '../utils/serializers.js';
import { classScope } from './access.service.js';
import { diffFields, pickFields, recordAudit } from './audit.service.js';

// Classes: a class is one level + arm ("JSS 1" + "A") in ONE academic session. A new session
// gets new Class records, so what a class looked like in an earlier year is never rewritten.
//
// Reads go through classScope() (role-aware). Writes are administrator-only (enforced on the
// routes) and always filter on auth.schoolId. Classes are deactivated, never deleted, and a
// class belonging to a closed session is read-only history.

const CLASS_KEYS = ['name', 'arm', 'classTeacherId', 'room'];
const auditClass = (auth, klass, action, summary, details) =>
  recordAudit(auth, {
    action,
    entityType: 'class',
    entityId: klass._id,
    summary,
    details: { academicSessionId: klass.academicSessionId, className: klass.displayName, ...details },
  });

const present = (klass) => ({ class: toClassView(klass) });

const requireChanges = (changes) => {
  if (Object.keys(changes).length === 0) {
    throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  }
};

async function findManaged(auth, id) {
  const klass = await Class.findOne({ _id: id, schoolId: auth.schoolId });
  if (!klass) throw notFound('Class not found.');
  return klass;
}

// The session must exist in the administrator's school and still be open to changes.
async function assertSessionEditable(auth, sessionId) {
  const session = await AcademicSession.findOne({ _id: sessionId, schoolId: auth.schoolId }).select('status');
  if (!session) throw notFound('Academic session not found.');
  if (session.status === 'closed') {
    throw new AppError(409, 'This class belongs to a closed academic session, which is read-only history.', {
      code: 'SESSION_CLOSED',
    });
  }
}

async function assertAssignableTeacher(auth, teacherId) {
  const teacher = await Teacher.exists({ _id: teacherId, schoolId: auth.schoolId, employmentStatus: 'active' });
  if (!teacher) {
    throw badRequest('The class teacher must be an active teacher in this school.', {
      code: 'VALIDATION_ERROR',
      details: [{ field: 'classTeacherId', message: 'is not an active teacher in this school' }],
    });
  }
}

// ------------------------------------------------------------------------ reading

export async function listClasses(auth, { academicSessionId, status, page = 1, limit = 20 } = {}) {
  const scope = await classScope(auth);
  const extra = { ...(academicSessionId && { academicSessionId }), ...(status && { status }) };
  const filter = Object.keys(extra).length > 0 ? { $and: [scope, extra] } : scope;

  const [classes, total] = await Promise.all([
    Class.find(filter)
      .sort({ name: 1, arm: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Class.countDocuments(filter),
  ]);
  return { items: classes.map(toClassView), page, limit, total };
}

export async function getClass(auth, id) {
  const scope = await classScope(auth);
  const klass = await Class.findOne({ $and: [scope, { _id: id }] });
  if (!klass) throw notFound('Class not found.');
  return present(klass);
}

// ------------------------------------------------------------------------ writing

export async function createClass(auth, data) {
  await assertSessionEditable(auth, data.academicSessionId);
  if (data.classTeacherId) await assertAssignableTeacher(auth, data.classTeacherId);

  const klass = await Class.create({
    name: data.name,
    arm: data.arm,
    academicSessionId: data.academicSessionId,
    classTeacherId: data.classTeacherId,
    room: data.room,
    schoolId: auth.schoolId,
    status: 'active',
  });
  await auditClass(auth, klass, 'class.created', `Class ${klass.displayName} created`, {
    name: klass.name,
    arm: klass.arm,
    classTeacherId: klass.classTeacherId ?? null,
  });
  return present(klass); // a duplicate name + arm in this school and session fails with 409
}

export async function updateClass(auth, id, changes) {
  requireChanges(changes);
  const klass = await findManaged(auth, id);
  await assertSessionEditable(auth, klass.academicSessionId);
  const before = pickFields(klass, CLASS_KEYS);
  const previousName = klass.displayName;

  if (changes.name !== undefined) klass.name = changes.name;
  if (changes.arm !== undefined) klass.arm = changes.arm;
  if ('room' in changes) klass.room = changes.room ?? undefined; // null clears it
  if ('classTeacherId' in changes) {
    if (changes.classTeacherId) {
      await assertAssignableTeacher(auth, changes.classTeacherId);
      klass.classTeacherId = changes.classTeacherId;
    } else {
      klass.classTeacherId = undefined; // null clears the class teacher
    }
  }
  await klass.save();
  const diff = diffFields(before, pickFields(klass, CLASS_KEYS), CLASS_KEYS);
  if (diff.changed.length > 0) {
    await auditClass(auth, klass, 'class.updated', `Class ${previousName} updated: ${diff.changed.join(', ')}`, { before: diff.before, after: diff.after });
  }
  return present(klass);
}

// Deactivating hides nothing from the record: students, results and history stay attached.
export async function setClassStatus(auth, id, status) {
  const klass = await findManaged(auth, id);
  await assertSessionEditable(auth, klass.academicSessionId);
  const previous = klass.status;
  klass.status = status;
  await klass.save();
  if (previous !== status) {
    await auditClass(auth, klass, 'class.status_changed', `Class ${klass.displayName} ${previous} -> ${status}`, { before: { status: previous }, after: { status } });
  }
  return present(klass);
}

// Replaces the list of subjects offered in a class. Subjects that were deactivated earlier
// may stay in the list (history); only active subjects can be newly added.
export async function setClassSubjects(auth, id, subjectIds) {
  const klass = await findManaged(auth, id);
  await assertSessionEditable(auth, klass.academicSessionId);

  const existing = new Set(klass.subjectIds.map(String));
  const added = subjectIds.filter((subjectId) => !existing.has(subjectId));
  if (added.length > 0) {
    const found = await Subject.countDocuments({
      _id: { $in: added },
      schoolId: auth.schoolId,
      status: 'active',
    });
    if (found !== added.length) {
      throw badRequest('Subjects must exist in this school and be active to be added to a class.', {
        code: 'VALIDATION_ERROR',
        details: [{ field: 'subjectIds', message: 'contains an unknown or inactive subject' }],
      });
    }
  }
  const wanted = new Set(subjectIds.map(String));
  const removed = [...existing].filter((subjectId) => !wanted.has(subjectId));
  klass.subjectIds = subjectIds;
  await klass.save();
  if (added.length > 0 || removed.length > 0) {
    await auditClass(auth, klass, 'class.subjects_changed', `Subjects of ${klass.displayName} changed`, { added, removed });
  }
  return present(klass);
}

// ------------------------------------------------ who teaches which subject in a class

// Keeps Teacher.classIds / subjectIds in step with Class.subjectTeachers: a teacher keeps a
// class (or subject) only while at least one pair still refers to it.
async function syncTeacherScope(auth, teacherId) {
  const teacher = await Teacher.findOne({ _id: teacherId, schoolId: auth.schoolId });
  if (!teacher) return;
  const classes = await Class.find({ schoolId: auth.schoolId, 'subjectTeachers.teacherId': teacher._id }).select('subjectTeachers');
  const classIds = new Set();
  const subjectIds = new Set();
  for (const c of classes) {
    for (const st of c.subjectTeachers) {
      if (String(st.teacherId) === String(teacher._id)) {
        classIds.add(String(c._id));
        subjectIds.add(String(st.subjectId));
      }
    }
  }
  teacher.classIds = [...classIds];
  teacher.subjectIds = [...subjectIds];
  await teacher.save();
}

// Sets (or replaces) the teacher of one subject in one class. The subject is added to the
// class when it was not offered yet.
export async function setSubjectTeacher(auth, id, subjectId, teacherId) {
  const klass = await findManaged(auth, id);
  await assertSessionEditable(auth, klass.academicSessionId);
  const [subject, teacher] = await Promise.all([
    Subject.exists({ _id: subjectId, schoolId: auth.schoolId, status: 'active' }),
    Teacher.exists({ _id: teacherId, schoolId: auth.schoolId, employmentStatus: 'active' }),
  ]);
  if (!subject) throw badRequest('The subject must exist in this school and be active.', { code: 'VALIDATION_ERROR', details: [{ field: 'subjectId', message: 'is not an active subject' }] });
  if (!teacher) throw badRequest('The teacher must be an active teacher in this school.', { code: 'VALIDATION_ERROR', details: [{ field: 'teacherId', message: 'is not an active teacher' }] });

  const previous = klass.subjectTeachers.find((st) => String(st.subjectId) === String(subjectId));
  const previousTeacherId = previous ? String(previous.teacherId) : null;
  if (previous) previous.teacherId = teacherId;
  else klass.subjectTeachers.push({ subjectId, teacherId });
  if (!klass.subjectIds.some((s) => String(s) === String(subjectId))) klass.subjectIds.push(subjectId);
  await klass.save();

  await syncTeacherScope(auth, teacherId);
  if (previousTeacherId && previousTeacherId !== String(teacherId)) await syncTeacherScope(auth, previousTeacherId);
  await auditClass(auth, klass, 'class.subject_teacher_set', `Teacher assigned to a subject in ${klass.displayName}`, { subjectId, teacherId, previousTeacherId });
  return present(klass);
}

export async function clearSubjectTeacher(auth, id, subjectId) {
  const klass = await findManaged(auth, id);
  await assertSessionEditable(auth, klass.academicSessionId);
  const existing = klass.subjectTeachers.find((st) => String(st.subjectId) === String(subjectId));
  if (!existing) throw notFound('No teacher is assigned to that subject in this class.');
  const teacherId = String(existing.teacherId);
  klass.subjectTeachers = klass.subjectTeachers.filter((st) => String(st.subjectId) !== String(subjectId));
  await klass.save();
  await syncTeacherScope(auth, teacherId);
  await auditClass(auth, klass, 'class.subject_teacher_cleared', `Teacher removed from a subject in ${klass.displayName}`, { subjectId, teacherId });
  return present(klass);
}
