import { School, Student, Teacher, User } from '../models/index.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/AppError.js';
import { joinName, toPublicUser, toStudentView } from '../utils/serializers.js';
import { getProfile } from './auth.service.js';
import { nextSequentialId, withGeneratedId } from './idGenerator.service.js';
import { findAssignableClass, placeInClass } from './studentClass.service.js';
import { applyStudentChanges } from './student.service.js';
import { applyTeacherChanges, assertTeachingAssignments } from './teacher.service.js';
import { diffFields, pickFields, recordAudit, recordAuditBatch } from './audit.service.js';
import { changeAccess, localStatusFor, refreshPendingMirror, syncContact, undoAccess } from './accountAccess.service.js';
import {
  createAccount,
  getAccountStatus,
  issueActivationLink,
  issuePasswordResetLink,
  voidAccount,
} from './accountManagement.service.js';

// Account management for school administrators.
//
// Every function takes `auth` (the administrator, from req.auth) and uses auth.schoolId
// for ALL reads and writes. A school id is never accepted from the request, and every
// lookup by id also filters on the administrator's school, so another school's accounts
// cannot be found even with a valid id.
//
// MongoDB transactions need a replica set (not available on a plain local install), so
// when a user is created together with a profile record and the second step fails, the
// brand-new user is removed again. That user was created seconds earlier and has no
// history, so removing it does not touch any academic record.

const removeNewUser = (userId) => User.deleteOne({ _id: userId }, { allowHardDelete: true });

async function findManagedUser(auth, id) {
  const user = await User.findOne({ _id: id, schoolId: auth.schoolId });
  if (!user) throw notFound('Account not found.');
  return user;
}

async function assertStudentsInSchool(auth, studentIds) {
  if (studentIds.length === 0) return;
  const count = await Student.countDocuments({ _id: { $in: studentIds }, schoolId: auth.schoolId });
  if (count !== studentIds.length) {
    throw badRequest('One or more students were not found in this school.', {
      code: 'VALIDATION_ERROR',
    });
  }
}

// One parent-student link or unlink, as an audit entry (the parent is the record, the student the subject).
export const linkEntry = (parent, studentId, action, verb) => ({
  action,
  entityType: 'user',
  entityId: parent._id,
  studentId,
  summary: `Parent ${parent.fullName} ${verb} a student`,
  details: { parentId: parent._id, studentId },
});

const present = async (user) => ({ user: toPublicUser(user), profile: await getProfile(user) });

// ---------------------------------------------------------------- creating accounts
//
// No password is ever collected or stored here. Creating a person works in three steps:
//   1. the school records (user + profile) are created, with the account marked pending_activation;
//   2. the Account Management Backend is asked to create the login account;
//   3. only if step 2 worked is the person reported as created.
// If step 2 (or anything after it) fails, step 1 is undone, so a failed request leaves no half-made
// profile behind and never answers "created" for an account that does not exist.

const removeRecords = async (user, Model, profileId) => {
  if (profileId) await Model.deleteOne({ _id: profileId }, { allowHardDelete: true });
  await removeNewUser(user._id);
};

// Asks the account service for the account and stores its id on the user. When the outcome of a
// create is unknown (no answer), the account service is asked to void it before the error is re-thrown.
async function provisionAccount(auth, user, { role, loginId, profile, delivery }) {
  try {
    const school = await School.findById(user.schoolId).select('code');
    const result = await createAccount({
      idempotencyKey: `create-account:${user._id}`,
      schoolId: user.schoolId,
      schoolCode: school?.code,
      userId: user._id,
      role,
      loginId,
      fullName: user.fullName,
      email: user.email,
      profile,
      delivery,
      requestedBy: auth,
    });
    await User.updateOne(
      { _id: user._id },
      { $set: { accountId: result.accountId, accountStatus: 'pending_activation', accountStatusSyncedAt: new Date() } }
    );
    user.accountId = result.accountId;
    return result;
  } catch (error) {
    if (error.ambiguous || !(error instanceof AppError)) {
      await voidAccount({ schoolId: user.schoolId, userId: user._id }).catch(() => {});
    }
    throw error;
  }
}

// The audit entries for a new account's activation: a link handed to the administrator, or an
// email sent by the account service. The link itself is never written anywhere.
const activationEntry = (user, studentId, delivery, result) => ({
  action: delivery === 'email' ? 'account.activation_email_requested' : 'account.activation_link_issued',
  entityType: 'user',
  entityId: user._id,
  studentId,
  summary:
    delivery === 'email'
      ? `Activation email requested for ${user.role} ${user.fullName}`
      : `Activation link issued for ${user.role} ${user.fullName}`,
  details: { role: user.role, accountId: user.accountId, delivery, expiresAt: result.activation?.expiresAt ?? null },
});

const activationView = (result) =>
  result.activation ? { link: result.activation.link ?? null, expiresAt: result.activation.expiresAt ?? null } : null;

export async function createTeacherAccount(auth, data) {
  const { username, email, teacherId: suppliedId, ...teacherFields } = data;
  const schoolId = auth.schoolId;

  // Class and subject assignments are checked BEFORE anything is created.
  await assertTeachingAssignments(auth, teacherFields);

  const created = await withGeneratedId({
    supplied: suppliedId,
    generate: () => nextSequentialId(Teacher, 'teacherId', schoolId, 'TCH-'),
    create: async (teacherId) => {
      const user = await User.create({
        schoolId,
        fullName: joinName(teacherFields.firstName, teacherFields.middleName, teacherFields.lastName),
        email,
        username: username ?? teacherId.toLowerCase(), // teachers sign in with their staff ID by default
        role: 'teacher',
        status: 'active',
        accountStatus: 'pending_activation',
      });
      let teacher;
      try {
        teacher = await Teacher.create({ ...teacherFields, teacherId, schoolId, userId: user._id });
      } catch (error) {
        await removeNewUser(user._id);
        throw error;
      }
      return { user, teacher };
    },
  });

  let result;
  try {
    // The account service emails the activation link to the teacher's registered address.
    result = await provisionAccount(auth, created.user, {
      role: 'teacher',
      loginId: created.user.username,
      profile: { type: 'teacher', id: created.teacher._id, code: created.teacher.teacherId },
      delivery: 'email',
    });
  } catch (error) {
    await removeRecords(created.user, Teacher, created.teacher._id);
    throw error;
  }

  await recordAudit(auth, {
    action: 'teacher.created',
    entityType: 'teacher',
    entityId: created.teacher._id,
    summary: `Teacher account created: ${created.user.fullName} (${created.teacher.teacherId})`,
    details: {
      userId: created.user._id,
      accountId: created.user.accountId,
      accountStatus: 'pending_activation',
      teacherId: created.teacher.teacherId,
      username: created.user.username,
      classIds: created.teacher.classIds,
      subjectIds: created.teacher.subjectIds,
    },
  });
  await recordAudit(auth, activationEntry(created.user, undefined, 'email', result));
  return { ...(await present(created.user)), activation: activationView(result) };
}

// Registers a student: the record, the school user and a login account waiting for activation.
// The student ID is generated when the administrator gives none. The response carries the
// activation link (once) so the administrator can pass it on; it can be issued again later.
export async function registerStudent(auth, data) {
  const { username, email, studentId: suppliedId, ...studentFields } = data;
  const schoolId = auth.schoolId;

  const klass = studentFields.currentClassId ? await findAssignableClass(auth, studentFields.currentClassId) : null;
  // Build the class placement from the admission date, so history starts with the admission.
  const { currentClassId, ...profileFields } = studentFields;

  const registered = await withGeneratedId({
    supplied: suppliedId,
    generate: () =>
      nextSequentialId(Student, 'studentId', schoolId, `STU-${studentFields.admissionDate.getUTCFullYear()}-`),
    create: async (studentId) => {
      const user = await User.create({
        schoolId,
        fullName: joinName(profileFields.firstName, profileFields.middleName, profileFields.lastName),
        email, // optional: students need neither an email nor a phone number
        // Students sign in with their student ID unless a different username is supplied.
        username: username ?? studentId.toLowerCase(),
        role: 'student',
        status: 'active',
        accountStatus: 'pending_activation',
      });
      try {
        const student = new Student({ ...profileFields, studentId, schoolId, userId: user._id });
        if (klass) placeInClass(student, klass, 'admission', studentFields.admissionDate);
        await student.save();
        return { user, student };
      } catch (error) {
        await removeNewUser(user._id);
        throw error;
      }
    },
  });

  let result;
  try {
    result = await provisionAccount(auth, registered.user, {
      role: 'student',
      loginId: registered.user.username,
      profile: { type: 'student', id: registered.student._id, code: registered.student.studentId },
      delivery: 'link',
    });
  } catch (error) {
    await removeRecords(registered.user, Student, registered.student._id);
    throw error;
  }

  await recordAuditBatch(auth, [
    {
      action: 'student.registered',
      entityType: 'student',
      entityId: registered.student._id,
      studentId: registered.student._id,
      summary: `Student registered: ${registered.student.fullName} (${registered.student.studentId})`,
      details: {
        studentId: registered.student.studentId,
        admissionDate: registered.student.admissionDate,
        classId: registered.student.currentClassId ?? null,
        accountCreated: true,
        userId: registered.user._id,
        accountId: registered.user.accountId,
        accountStatus: 'pending_activation',
      },
    },
    activationEntry(registered.user, registered.student._id, 'link', result),
  ]);
  return { ...registered, activation: activationView(result) };
}

// Same as registerStudent, in the response shape of the account routes.
export async function createStudentAccount(auth, data) {
  const { user, activation } = await registerStudent(auth, data);
  return { ...(await present(user)), activation };
}

export const presentRegisteredStudent = ({ user, student, activation }) => ({
  user: user ? toPublicUser(user) : null,
  profile: { type: 'student', ...toStudentView(student, { admin: true }) },
  activation,
});

// Gives a login account to a student record that already exists without one.
export async function createAccountForStudent(auth, studentRecordId, data = {}) {
  const { username, email } = data;
  const schoolId = auth.schoolId;

  const student = await Student.findOne({ _id: studentRecordId, schoolId });
  if (!student) throw notFound('Student not found.');
  if (student.userId) throw conflict('This student already has a login account.');

  const user = await User.create({
    schoolId,
    fullName: joinName(student.firstName, student.middleName, student.lastName),
    email,
    username: username ?? student.studentId.toLowerCase(),
    role: 'student',
    status: 'active',
    accountStatus: 'pending_activation',
  });

  // Conditional update: succeeds only if nobody linked an account in the meantime.
  const linked = await Student.findOneAndUpdate(
    { _id: student._id, schoolId, userId: null },
    { $set: { userId: user._id } },
    { new: true }
  );
  if (!linked) {
    await removeNewUser(user._id);
    throw conflict('This student already has a login account.');
  }

  let result;
  try {
    result = await provisionAccount(auth, user, {
      role: 'student',
      loginId: user.username,
      profile: { type: 'student', id: student._id, code: student.studentId },
      delivery: 'link',
    });
  } catch (error) {
    await Student.updateOne({ _id: student._id, schoolId, userId: user._id }, { $unset: { userId: 1 } });
    await removeNewUser(user._id);
    throw error;
  }
  await recordAuditBatch(auth, [
    {
      action: 'account.created',
      entityType: 'user',
      entityId: user._id,
      studentId: student._id,
      summary: `Login account created for student ${student.studentId}`,
      details: { role: 'student', username: user.username, accountId: user.accountId, accountStatus: 'pending_activation' },
    },
    activationEntry(user, student._id, 'link', result),
  ]);
  return { ...(await present(user)), activation: activationView(result) };
}

export async function createParentAccount(auth, data) {
  const { username, email, fullName, studentIds = [] } = data;
  const schoolId = auth.schoolId;

  await assertStudentsInSchool(auth, studentIds);

  const user = await User.create({
    schoolId,
    fullName,
    email,
    username,
    role: 'parent',
    status: 'active',
    accountStatus: 'pending_activation',
  });

  try {
    if (studentIds.length > 0) {
      await Student.updateMany(
        { _id: { $in: studentIds }, schoolId },
        { $addToSet: { guardianUserIds: user._id } }
      );
    }
  } catch (error) {
    await removeNewUser(user._id);
    throw error;
  }

  // A parent with an email gets the activation link by email; otherwise the administrator passes it on.
  const delivery = user.email ? 'email' : 'link';
  let result;
  try {
    result = await provisionAccount(auth, user, { role: 'parent', loginId: user.username, profile: undefined, delivery });
  } catch (error) {
    if (studentIds.length > 0) {
      await Student.updateMany({ _id: { $in: studentIds }, schoolId }, { $pull: { guardianUserIds: user._id } });
    }
    await removeNewUser(user._id);
    throw error;
  }

  await recordAudit(auth, {
    action: 'parent.created',
    entityType: 'user',
    entityId: user._id,
    summary: `Parent account created: ${user.fullName}`,
    details: { role: 'parent', username: user.username, accountId: user.accountId, accountStatus: 'pending_activation', linkedStudentIds: studentIds },
  });
  await recordAudit(auth, activationEntry(user, undefined, delivery, result));
  await recordAuditBatch(
    auth,
    studentIds.map((studentId) => linkEntry(user, studentId, 'parent.student_linked', 'linked to'))
  );
  return { ...(await present(user)), activation: activationView(result) };
}

// ------------------------------------------------------------------ reading accounts

export async function listAccounts(auth, { role, status, page = 1, limit = 20 } = {}) {
  const filter = {
    schoolId: auth.schoolId,
    ...(role && { role }),
    ...(status && { status }),
  };
  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ fullName: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  return { items: users.map(toPublicUser), page, limit, total };
}

export async function getAccount(auth, id) {
  return present(await findManagedUser(auth, id));
}

// ------------------------------------------------------------------ updating accounts

// Fields an administrator may change, by the role of the account being edited.
// Deliberately absent: role, status (own endpoints), schoolId, password, studentId,
// teacherId, username. Those can never be changed through this route.
// Classes, subjects, class placement and lifecycle status have their own endpoints
// (teachers/students routes) because they need checks and history.
const EDITABLE = {
  teacher: ['firstName', 'middleName', 'lastName', 'department', 'title', 'phone'],
  student: ['firstName', 'middleName', 'lastName', 'gender', 'dateOfBirth'],
  parent: ['fullName'],
};

export async function updateAccount(auth, id, changes) {
  const user = await findManagedUser(auth, id);

  if (user.role === 'admin') {
    throw forbidden('Administrator accounts cannot be changed here.', 'ADMIN_PROTECTED');
  }

  const allowed = new Set(['email', ...EDITABLE[user.role]]);
  const notAllowed = Object.keys(changes).filter((key) => !allowed.has(key));
  if (notAllowed.length > 0) {
    throw badRequest(`These fields cannot be changed for a ${user.role} account.`, {
      code: 'VALIDATION_ERROR',
      details: notAllowed.map((field) => ({ field, message: 'is not an allowed field' })),
    });
  }
  if (Object.keys(changes).length === 0) {
    throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  }

  if (user.role === 'teacher' || user.role === 'student') {
    // The profile rules (names, dates, email, validation) live in teacher.service and
    // student.service, shared with the /api/teachers and /api/students routes.
    const Model = user.role === 'teacher' ? Teacher : Student;
    const profile = await Model.findOne({ schoolId: auth.schoolId, userId: user._id });
    if (!profile) throw notFound('The profile record for this account was not found.');
    await (user.role === 'teacher' ? applyTeacherChanges : applyStudentChanges)(profile, user, changes, auth);
  } else {
    const keys = ['email', 'fullName'];
    const before = pickFields(user, keys);
    if (changes.email !== undefined) user.email = changes.email;
    if (changes.fullName !== undefined) user.fullName = changes.fullName;
    await user.validate();
    await syncContact(user, { email: changes.email, fullName: changes.fullName }); // account service first
    await user.save();
    const diff = diffFields(before, pickFields(user, keys), keys);
    if (diff.changed.length > 0) {
      await recordAudit(auth, {
        action: 'parent.updated',
        entityType: 'user',
        entityId: user._id,
        summary: `Parent account updated: ${diff.changed.join(', ')}`,
        details: { before: diff.before, after: diff.after },
      });
    }
  }

  return present(user);
}

// Replaces the full list of students linked to a parent account.
export async function setLinkedStudents(auth, parentId, studentIds) {
  const parent = await findManagedUser(auth, parentId);
  if (parent.role !== 'parent') {
    throw badRequest('Only parent accounts can be linked to students.', { code: 'VALIDATION_ERROR' });
  }
  await assertStudentsInSchool(auth, studentIds);

  const linkedBefore = new Set(
    (await Student.find({ schoolId: auth.schoolId, guardianUserIds: parent._id }).select('_id')).map((s) => String(s._id))
  );
  await Student.updateMany(
    { schoolId: auth.schoolId, guardianUserIds: parent._id, _id: { $nin: studentIds } },
    { $pull: { guardianUserIds: parent._id } }
  );
  if (studentIds.length > 0) {
    await Student.updateMany(
      { schoolId: auth.schoolId, _id: { $in: studentIds } },
      { $addToSet: { guardianUserIds: parent._id } }
    );
  }
  const wanted = new Set(studentIds.map(String));
  await recordAuditBatch(auth, [
    ...studentIds.filter((id) => !linkedBefore.has(String(id))).map((id) => linkEntry(parent, id, 'parent.student_linked', 'linked to')),
    ...[...linkedBefore].filter((id) => !wanted.has(id)).map((id) => linkEntry(parent, id, 'parent.student_unlinked', 'unlinked from')),
  ]);
  return present(parent);
}

// -------------------------------------------------------- activating / deactivating

// Changing access NEVER deletes anything: teachers, students and all their records stay in the
// database. The change is made at the account service first (it owns the account status) and
// mirrored on the school record afterwards. authenticate() asks for the live status, so a
// deactivated or suspended account is locked out within the status-cache window (15 s by default)
// even if it still holds an unexpired token. `desired` is 'active', 'deactivated' or 'suspended'.
const ACTION = { active: 'account.activated', deactivated: 'account.deactivated', suspended: 'account.suspended' };
const VERB = { active: 'activated', deactivated: 'deactivated', suspended: 'suspended' };

export async function setAccountStatus(auth, id, desired, { reason } = {}) {
  const user = await findManagedUser(auth, id);

  if (user.role === 'admin') {
    throw forbidden(
      'Administrator accounts cannot be activated, deactivated or suspended here.',
      'ADMIN_PROTECTED'
    );
  }
  if (desired === 'active') await refreshPendingMirror(user);
  if (desired === 'active' && user.accountStatus === 'pending_activation') {
    throw conflict('This account has not been activated yet. The person must use their activation link (it can be issued again).');
  }

  if (desired === 'active' && user.role === 'teacher') {
    const teacher = await Teacher.findOne({ schoolId: auth.schoolId, userId: user._id }).select('employmentStatus');
    if (teacher && (teacher.employmentStatus === 'resigned' || teacher.employmentStatus === 'retired')) {
      throw conflict(
        `This teacher is ${teacher.employmentStatus}. Change their employment status first (POST /api/teachers/:id/employment-status).`
      );
    }
  }

  const wantedLocal = localStatusFor(desired);
  if (user.accountStatus !== desired || user.status !== wantedLocal) {
    const teacherBefore = user.role === 'teacher'
      ? await Teacher.findOne({ schoolId: auth.schoolId, userId: user._id }).select('employmentStatus')
      : null;
    const { previous } = await changeAccess(auth, user, desired, reason);
    try {
      await user.save();
    } catch (error) {
      await undoAccess(auth, user, previous); // the account service is put back as it was
      throw error;
    }

    // Keep a teacher's employment record in step with their login.
    if (user.role === 'teacher') {
      if (desired === 'active') {
        await Teacher.updateOne(
          { schoolId: auth.schoolId, userId: user._id, employmentStatus: 'inactive' },
          { $set: { employmentStatus: 'active', employmentStatusChangedAt: new Date() } }
        );
      } else {
        await Teacher.updateOne(
          { schoolId: auth.schoolId, userId: user._id, employmentStatus: { $in: ['active', 'on_leave'] } },
          { $set: { employmentStatus: 'inactive', employmentStatusChangedAt: new Date() } }
        );
      }
    }

    const student = user.role === 'student' ? await Student.findOne({ schoolId: auth.schoolId, userId: user._id }).select('_id') : null;
    const teacherAfter = teacherBefore ? await Teacher.findOne({ _id: teacherBefore._id }).select('employmentStatus') : null;
    const entries = [
      {
        action: ACTION[desired],
        entityType: 'user',
        entityId: user._id,
        studentId: student?._id,
        summary: `${user.role[0].toUpperCase()}${user.role.slice(1)} account ${VERB[desired]}: ${user.fullName}`,
        details: {
          role: user.role,
          accountId: user.accountId,
          before: { status: previous.status, accountStatus: previous.accountStatus },
          after: { status: user.status, accountStatus: user.accountStatus },
          ...(reason && { reason }),
        },
      },
    ];
    if (teacherBefore && teacherAfter && teacherBefore.employmentStatus !== teacherAfter.employmentStatus) {
      entries.push({
        action: 'teacher.employment_status_changed',
        entityType: 'teacher',
        entityId: teacherBefore._id,
        summary: `Employment status changed from ${teacherBefore.employmentStatus} to ${teacherAfter.employmentStatus}`,
        details: {
          before: { employmentStatus: teacherBefore.employmentStatus },
          after: { employmentStatus: teacherAfter.employmentStatus },
          via: 'account_status',
        },
      });
    }
    await recordAuditBatch(auth, entries);
  }
  return present(user);
}

// ---------------------------------------------- account status, activation and reset links

// Finds the school user behind a student or teacher RECORD (not the user id), in this school only.
async function findProfileUser(auth, Model, recordId, label) {
  const profile = await Model.findOne({ _id: recordId, schoolId: auth.schoolId });
  if (!profile) throw notFound(`${label} not found.`);
  const user = profile.userId ? await User.findOne({ _id: profile.userId, schoolId: auth.schoolId }) : null;
  if (!user) throw notFound(`This ${label.toLowerCase()} has no login account.`);
  return { profile, user };
}

// Reads the LIVE account status from the account service and refreshes the mirror.
async function liveStatusOf(user) {
  if (!user.accountId) throw conflict('This person has no linked login account yet.');
  const live = await getAccountStatus(user.accountId);
  if (user.accountStatus !== live.status) {
    user.accountStatus = live.status;
    user.accountStatusSyncedAt = new Date();
    await user.save();
  }
  return live;
}

const statusView = (user, live) => ({
  userId: String(user._id),
  accountId: user.accountId,
  accountStatus: live.status,
  schoolStatus: user.status, // the school-side access flag, kept apart from the account status
  activatedAt: live.activatedAt,
  lastLoginAt: live.lastLoginAt,
  checkedAt: new Date(),
});

export async function getTeacherAccountStatus(auth, teacherRecordId) {
  const { profile, user } = await findProfileUser(auth, Teacher, teacherRecordId, 'Teacher');
  return { teacherId: profile.teacherId, ...statusView(user, await liveStatusOf(user)) };
}

export async function getStudentAccountStatus(auth, studentRecordId) {
  const { profile, user } = await findProfileUser(auth, Student, studentRecordId, 'Student');
  return { studentId: profile.studentId, ...statusView(user, await liveStatusOf(user)) };
}

// A new activation link for a student whose account is still waiting for activation (the link
// from registration was lost or expired). The previous link stops working. Never stored.
export async function issueStudentActivationLink(auth, studentRecordId) {
  const { profile, user } = await findProfileUser(auth, Student, studentRecordId, 'Student');
  const live = await liveStatusOf(user);
  if (live.status !== 'pending_activation') {
    throw conflict('This account is already activated. Use a password reset link if the student cannot sign in.');
  }
  const issued = await issueActivationLink(user.accountId, { requestedBy: auth });
  await recordAudit(auth, activationEntry(user, profile._id, 'link', { activation: issued }));
  return { studentId: profile.studentId, activation: { link: issued.link, expiresAt: issued.expiresAt } };
}

// Admin-assisted password reset for a student who forgot their password. Only an administrator
// of the student's school gets here (route guard + the school filter). The account must be active:
// a deactivated, suspended or never-activated account is refused, so a reset can never switch an
// account back on. The account service creates the secure, expiring, single-use link and enforces
// the same rule again. Graduated and transferred students may still get a link (they keep access to
// their history). The audit entry names the requesting administrator and never holds the link.
export async function requestStudentPasswordReset(auth, studentRecordId, { reason } = {}) {
  const { profile, user } = await findProfileUser(auth, Student, studentRecordId, 'Student');
  const live = await liveStatusOf(user);
  if (live.status === 'pending_activation') {
    throw new AppError(409, 'This account has not been activated yet. Issue an activation link instead.', { code: 'ACCOUNT_PENDING_ACTIVATION' });
  }
  if (live.status !== 'active' || user.status !== 'active') {
    throw new AppError(409, 'This account is not active, so a password reset cannot be issued. Reactivate the account first.', { code: 'ACCOUNT_NOT_ACTIVE' });
  }
  const issued = await issuePasswordResetLink(user.accountId, { requestedBy: auth, reason });
  await recordAudit(auth, {
    action: 'student.password_reset_requested',
    entityType: 'user',
    entityId: user._id,
    studentId: profile._id,
    summary: `Password reset link requested for student ${profile.studentId}`,
    details: { accountId: user.accountId, requestedBy: auth.userId, expiresAt: issued.expiresAt, ...(reason && { reason }) },
  });
  return { studentId: profile.studentId, reset: { link: issued.link, expiresAt: issued.expiresAt } };
}
