import { Teacher, User, UserProfile } from '../models/index.js';
import { badRequest, forbidden, notFound } from '../utils/AppError.js';
import { recordAudit } from './audit.service.js';
import { syncContact } from './accountAccess.service.js';

// MY PROFILE: the few details a person edits about themselves.
//   administrator  full name, email, title, phone, bio
//   teacher        email, phone, qualification, bio (their name, ID, department, classes and
//                  subjects are set by the school)
// A changed email or name is passed to the account service first, so the login account and the
// school record never disagree. Students edit nothing here (an administrator maintains their
// profile).

const ALLOWED = {
  admin: ['fullName', 'email', 'title', 'phone', 'bio'],
  teacher: ['email', 'phone', 'qualification', 'bio'],
};

const view = (role, source, user) => ({
  email: user?.email ?? '',
  ...(role === 'admin' ? { fullName: user?.fullName ?? '', title: source.title ?? '' } : { qualification: source.qualification ?? '' }),
  phone: source.phone ?? '',
  bio: source.bio ?? '',
});

async function loadOwn(auth) {
  if (!ALLOWED[auth.role]) throw forbidden('This profile is maintained by the school administrator.', 'PROFILE_NOT_EDITABLE');
  const user = await User.findOne({ _id: auth.userId, schoolId: auth.schoolId });
  if (!user) throw notFound('Account not found.');
  if (auth.role === 'teacher') {
    const teacher = await Teacher.findOne({ schoolId: auth.schoolId, userId: auth.userId });
    if (!teacher) throw forbidden('No teacher record is linked to this account.', 'NO_TEACHER_RECORD');
    return { doc: teacher, user };
  }
  const doc = (await UserProfile.findOne({ schoolId: auth.schoolId, userId: auth.userId })) ?? new UserProfile({ schoolId: auth.schoolId, userId: auth.userId });
  return { doc, user };
}

export async function getMyProfile(auth) {
  const { doc, user } = await loadOwn(auth);
  return view(auth.role, doc, user);
}

export async function updateMyProfile(auth, changes) {
  const keys = Object.keys(changes);
  if (keys.length === 0) throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  const bad = keys.filter((k) => !ALLOWED[auth.role]?.includes(k));
  if (bad.length) throw badRequest('Some fields cannot be changed here.', { code: 'VALIDATION_ERROR', details: bad.map((field) => ({ field, message: 'cannot be changed on your own profile' })) });

  const { doc, user } = await loadOwn(auth);
  const accountChange = {};
  if (changes.email !== undefined) accountChange.email = changes.email;
  if (changes.fullName !== undefined) accountChange.fullName = changes.fullName;
  if (Object.keys(accountChange).length) {
    user.set(accountChange);
    await user.validate();
    await syncContact(user, accountChange); // the account service first
    await user.save();
  }
  for (const key of keys) {
    if (key !== 'email' && key !== 'fullName') doc.set(key, changes[key] ?? undefined); // null clears
  }
  await doc.save();
  await recordAudit(auth, { action: 'profile.updated', entityType: auth.role === 'teacher' ? 'teacher' : 'user', entityId: doc._id, summary: 'Own profile updated', details: { fields: keys } });
  return view(auth.role, doc, user);
}
