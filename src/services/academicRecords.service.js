import { Class } from '../models/index.js';

// "Does this session / term already hold academic records?" - the question that decides
// whether it may ever be deleted. Anything that does is history and is kept for good.
//
// Today the only thing that points at a session is a Class. When results, attendance,
// assignments and so on are added, each feature registers one small check here (see
// registerAcademicRecordCheck) and session/term deletion automatically respects it. No
// change to the session code is needed.

const checks = [];

// `check({ schoolId, sessionId, termId? })` returns a short reason string (e.g. "results")
// when records exist, or a falsy value when there are none. Returns a function that
// removes the check again (used by tests).
export function registerAcademicRecordCheck(check) {
  checks.push(check);
  return () => {
    const index = checks.indexOf(check);
    if (index >= 0) checks.splice(index, 1);
  };
}

const firstReason = async (context) => {
  for (const check of checks) {
    const reason = await check(context);
    if (reason) return typeof reason === 'string' ? reason : 'academic records';
  }
  return null;
};

export async function sessionHasRecords(schoolId, sessionId) {
  if (await Class.exists({ schoolId, academicSessionId: sessionId })) return 'classes';
  return firstReason({ schoolId, sessionId });
}

export async function termHasRecords(schoolId, sessionId, termId) {
  return firstReason({ schoolId, sessionId, termId });
}
