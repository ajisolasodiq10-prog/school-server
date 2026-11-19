// One-off migration: hands the EXISTING login accounts (created before the Account Management
// Backend existed) over to it, then removes the password hashes from this database.
//
//   node scripts/migrate-accounts.js --dry-run            show what would be sent (counts only)
//   node scripts/migrate-accounts.js                      import every account that has no accountId yet
//   node scripts/migrate-accounts.js --strip-hashes       ALSO remove passwordHash from migrated records
//   node scripts/migrate-accounts.js --school GSS         only one school
//
// For each user the account service receives: school + user id (the stable reference), role,
// login ID, name, email, status and the existing bcrypt hash (so nobody has to reset their
// password). The hash travels only over the authenticated server-to-server call and is never printed.
// The script is safe to repeat: the import is idempotent per user and users that already have an
// accountId are skipped. Hashes are removed only with --strip-hashes AND only for users whose
// import succeeded. Take a database backup before running it.
import { parseArgs } from 'node:util';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { School, User } from '../src/models/index.js';
import { importAccount } from '../src/services/accountManagement.service.js';

const { values } = parseArgs({
  options: { 'dry-run': { type: 'boolean', default: false }, 'strip-hashes': { type: 'boolean', default: false }, school: { type: 'string' } },
});

// old school-side status -> account status
const ACCOUNT_STATUS = { active: 'active', inactive: 'deactivated', suspended: 'suspended' };

let exitCode = 0;
try {
  await connectDB();
  const filter = {};
  if (values.school) {
    const school = await School.findOne({ code: values.school.toUpperCase() });
    if (!school) throw new Error(`No school with code ${values.school}.`);
    filter.schoolId = school._id;
  }
  // The model no longer has passwordHash, so read the raw documents.
  const users = await User.collection.find({ ...filter }).toArray();
  const schoolCodes = new Map((await School.find().select('code')).map((s) => [String(s._id), s.code]));
  const counts = { total: users.length, migrated: 0, skipped: 0, noHash: 0, failed: 0, stripped: 0 };

  for (const user of users) {
    if (user.accountId) {
      counts.skipped += 1;
      if (values['strip-hashes'] && user.passwordHash && !values['dry-run']) {
        await User.collection.updateOne({ _id: user._id }, { $unset: { passwordHash: '' } });
        counts.stripped += 1;
      }
      continue;
    }
    if (!user.passwordHash) {
      counts.noHash += 1;
      console.error(`- ${user._id}: no password hash, cannot be migrated (issue an activation link after creating the account).`);
      continue;
    }
    if (values['dry-run']) {
      counts.migrated += 1;
      continue;
    }
    try {
      const accountStatus = ACCOUNT_STATUS[user.status] ?? 'deactivated';
      const result = await importAccount({
        externalRef: { schoolId: String(user.schoolId), userId: String(user._id) },
        ...(schoolCodes.get(String(user.schoolId)) && { schoolCode: schoolCodes.get(String(user.schoolId)) }),
        role: user.role,
        loginId: user.username,
        fullName: user.fullName,
        ...(user.email && { email: user.email }),
        status: accountStatus,
        credential: { algorithm: 'bcrypt', hash: user.passwordHash },
      });
      await User.collection.updateOne(
        { _id: user._id },
        {
          $set: { accountId: result.accountId, accountStatus: result.status, accountStatusSyncedAt: new Date() },
          ...(values['strip-hashes'] && { $unset: { passwordHash: '' } }),
        }
      );
      counts.migrated += 1;
      if (values['strip-hashes']) counts.stripped += 1;
    } catch (error) {
      counts.failed += 1;
      console.error(`- ${user._id}: ${error.code ?? 'ERROR'} ${error.message}`);
    }
  }
  console.log(`${values['dry-run'] ? '[dry run] ' : ''}${JSON.stringify(counts)}`);
  if (counts.failed > 0 || counts.noHash > 0) exitCode = 2;
} catch (error) {
  exitCode = 1;
  console.error(`Migration failed: ${error.message}`);
} finally {
  await disconnectDB();
}
process.exit(exitCode);
