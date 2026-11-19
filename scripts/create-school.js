// Platform-operator script: registers a school. Run it on the server, where .env lives.
//
//   node scripts/create-school.js --name "Greenfield Secondary School" --code GSS \
//        --address "12 School Road, Ikeja, Lagos" --email info@school.example --phone "+2348012345678"
//
// Nothing is created automatically anywhere else: the database only ever contains the
// schools you register with this script.
import { parseArgs } from 'node:util';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { School } from '../src/models/index.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    code: { type: 'string' },
    address: { type: 'string' },
    email: { type: 'string' },
    phone: { type: 'string' },
    'logo-url': { type: 'string' },
  },
});

const missing = ['name', 'code', 'address', 'email', 'phone'].filter((key) => !values[key]);
if (missing.length > 0) {
  console.error(`Missing option(s): ${missing.map((key) => `--${key}`).join(', ')}`);
  console.error(
    'Usage: node scripts/create-school.js --name "..." --code CODE --address "..." --email ... --phone ...'
  );
  process.exit(1);
}

let exitCode = 0;
try {
  await connectDB();
  await School.init(); // make sure the unique index on "code" exists before inserting

  const school = await School.create({
    name: values.name,
    code: values.code,
    address: values.address,
    contactEmail: values.email,
    contactPhone: values.phone,
    ...(values['logo-url'] && { logoUrl: values['logo-url'] }),
  });

  console.log(`School created: ${school.name} (code ${school.code}).`);
  console.log('Next: node scripts/create-admin.js --school ' + school.code);
} catch (error) {
  exitCode = 1;
  if (error.code === 11000) console.error('A school with that code already exists.');
  else if (error.name === 'ValidationError') {
    for (const e of Object.values(error.errors)) console.error(`- ${e.message}`);
  } else console.error(`Could not create the school: ${error.message}`);
} finally {
  await disconnectDB();
}
process.exit(exitCode);
