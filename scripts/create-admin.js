// Platform-operator script: provisions the FIRST administrator of a school through the
// Account Management Backend. Run it on the server, where .env lives.
//
//   node scripts/create-admin.js --school GSS --name "Ada Obi" --email ada@school.example [--username ada.obi]
//
// What it does:
//   1. creates the school-side administrator record (no password is ever asked for or stored here);
//   2. asks the account service to create the login account (pending_activation) and email the
//      activation link, or to return it when --print-link is given (it is shown ONCE, never stored);
//   3. if the account service refuses or cannot be reached, the school-side record is removed again.
// The administrator then opens the activation link, chooses a password at the account service and
// signs in there. Further administrators are provisioned the same way.
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { School, User } from '../src/models/index.js';
import { createAccount, voidAccount } from '../src/services/accountManagement.service.js';

const { values } = parseArgs({
  options: {
    school: { type: 'string' },
    name: { type: 'string' },
    email: { type: 'string' },
    username: { type: 'string' },
    'print-link': { type: 'boolean', default: false },
  },
});

const missing = ['school', 'name', 'email'].filter((key) => !values[key]);
if (missing.length > 0) {
  console.error(`Missing option(s): ${missing.map((key) => `--${key}`).join(', ')}`);
  console.error('Usage: node scripts/create-admin.js --school CODE --name "Full Name" --email admin@school.example [--username login.id] [--print-link]');
  process.exit(1);
}

let exitCode = 0;
let user = null;
try {
  await connectDB();
  await User.init();
  const school = await School.findOne({ code: values.school.toUpperCase() });
  if (!school) throw new Error(`No school with code ${values.school}. Create it first with scripts/create-school.js.`);

  user = await User.create({
    schoolId: school._id,
    fullName: values.name,
    email: values.email,
    username: values.username ?? values.email.split('@')[0],
    role: 'admin',
    status: 'active',
    accountStatus: 'pending_activation',
  });

  const delivery = values['print-link'] ? 'link' : 'email';
  const result = await createAccount({
    idempotencyKey: `create-account:${user._id}`,
    schoolId: school._id,
    schoolCode: school.code,
    userId: user._id,
    role: 'admin',
    loginId: user.username,
    fullName: user.fullName,
    email: user.email,
    delivery,
    requestedBy: { userId: 'operator', role: 'operator' },
  }).catch(async (error) => {
    if (error.ambiguous) await voidAccount({ schoolId: school._id, userId: user._id }).catch(() => {});
    throw error;
  });
  await User.updateOne({ _id: user._id }, { $set: { accountId: result.accountId, accountStatusSyncedAt: new Date() } });

  console.log(`Administrator created for ${school.name}: ${user.fullName} (login ID ${user.username}).`);
  if (delivery === 'email') console.log(`An activation email was requested for ${user.email}.`);
  else {
    console.log('Activation link (shown once; it is not stored anywhere):');
    console.log(`  ${result.activation.link}`);
  }
  if (result.activation?.expiresAt) console.log(`It expires at ${result.activation.expiresAt.toISOString()}.`);
  user = null; // success: keep the record
} catch (error) {
  exitCode = 1;
  if (error.code === 11000) console.error('An account with that username or email already exists in this school.');
  else if (error.name === 'ValidationError') for (const e of Object.values(error.errors)) console.error(`- ${e.message}`);
  else {
    console.error(`Could not create the administrator: ${error.message}`);
    if (error.detail) console.error(`Reason: ${error.detail}`);
    if (error.code === 'ACCOUNT_SERVICE_UNAVAILABLE') {
      console.error('Check: 1) the account backend is running (open <ACCOUNT_SERVICE_URL>/health), 2) ACCOUNT_SERVICE_URL in server/.env is exactly its address, e.g. http://127.0.0.1:5100, 3) the account backend terminal shows no errors.');
    }
  }
  if (user) await User.deleteOne({ _id: user._id }, { allowHardDelete: true }); // nothing is left half-made
} finally {
  await disconnectDB();
}
process.exit(exitCode);
