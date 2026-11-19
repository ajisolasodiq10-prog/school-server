import { AcademicSession } from '../models/index.js';
import { AppError, badRequest, conflict, notFound } from '../utils/AppError.js';
import { toSessionView, toTermView } from '../utils/serializers.js';
import { sessionHasRecords, termHasRecords } from './academicRecords.service.js';
import { sessionScope } from './access.service.js';
import { diffFields, pickFields, recordAudit, recordAuditBatch } from './audit.service.js';

// Academic sessions and their terms.
//
// Lifecycle:  upcoming -> open -> closed. Exactly one session per school is "current" (and
// it is open); within it at most one term is current (and open). Closed sessions are kept
// forever as history: they stay readable, are never deleted, and can only be re-opened.
//
// Writes always filter on auth.schoolId. Reads go through sessionScope(), so non-admins see
// only the sessions relevant to them.

const sessionClosed = () =>
  new AppError(409, 'This academic session is closed and read-only. Re-open it first to change it.', {
    code: 'SESSION_CLOSED',
  });

const SESSION_KEYS = ['name', 'startDate', 'endDate'];
const TERM_KEYS = ['name', 'startDate', 'endDate', 'status'];

const sessionEntry = (session, action, summary, details) => ({
  action,
  entityType: 'academic_session',
  entityId: session._id,
  summary,
  details,
});
const termEntry = (session, term, action, summary, details) => ({
  action,
  entityType: 'term',
  entityId: term._id,
  summary,
  details: { academicSessionId: session._id, academicSessionName: session.name, termName: term.name, ...details },
});

const present = (session) => ({ session: toSessionView(session) });

async function findManaged(auth, id) {
  const session = await AcademicSession.findOne({ _id: id, schoolId: auth.schoolId });
  if (!session) throw notFound('Academic session not found.');
  return session;
}

const findTerm = (session, termId) => {
  const term = session.terms.id(termId);
  if (!term) throw notFound('Term not found.');
  return term;
};

// Closing a session also closes its terms and removes every "current" flag.
function closeSession(session) {
  session.isCurrent = false;
  session.status = 'closed';
  for (const term of session.terms) {
    term.isCurrent = false;
    term.status = 'closed';
  }
}

const requireChanges = (changes) => {
  if (Object.keys(changes).length === 0) {
    throw badRequest('Provide at least one field to update.', { code: 'VALIDATION_ERROR' });
  }
};

// ------------------------------------------------------------------------ reading

export async function listSessions(auth, { status, page = 1, limit = 20 } = {}) {
  const scope = await sessionScope(auth);
  const filter = status ? { $and: [scope, { status }] } : scope;
  const [sessions, total] = await Promise.all([
    AcademicSession.find(filter)
      .sort({ startDate: -1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    AcademicSession.countDocuments(filter),
  ]);
  return { items: sessions.map(toSessionView), page, limit, total };
}

export async function getSession(auth, id) {
  const scope = await sessionScope(auth);
  const session = await AcademicSession.findOne({ $and: [scope, { _id: id }] });
  if (!session) throw notFound('Academic session not found.');
  return present(session);
}

// The school calendar's "today": visible to every signed-in user of the school.
export async function getCurrent(auth) {
  const session = await AcademicSession.findOne({ schoolId: auth.schoolId, isCurrent: true });
  if (!session) {
    throw new AppError(404, 'No current academic session has been set.', { code: 'NO_CURRENT_SESSION' });
  }
  const currentTerm = session.terms.find((term) => term.isCurrent);
  return { session: toSessionView(session), currentTerm: currentTerm ? toTermView(currentTerm) : null };
}

// ------------------------------------------------------------------------ sessions

export async function createSession(auth, data) {
  const { terms = [], ...details } = data;
  const session = await AcademicSession.create({
    ...details,
    schoolId: auth.schoolId,
    status: 'upcoming',
    isCurrent: false, // becoming current is a separate, deliberate action
    terms: terms.map((term) => ({ ...term, status: 'upcoming', isCurrent: false })),
  });
  await recordAudit(auth, {
    ...sessionEntry(session, 'session.created', `Academic session ${session.name} created`, {
      name: session.name,
      startDate: session.startDate,
      endDate: session.endDate,
      terms: session.terms.map((t) => ({ id: t._id, name: t.name, startDate: t.startDate, endDate: t.endDate })),
    }),
  });
  return present(session);
}

export async function updateSession(auth, id, changes) {
  requireChanges(changes);
  const session = await findManaged(auth, id);
  const { status, ...details } = changes;
  const before = { ...pickFields(session, SESSION_KEYS), status: session.status };

  if (session.status === 'closed' && Object.keys(details).length > 0) throw sessionClosed();
  for (const key of ['name', 'startDate', 'endDate']) {
    if (details[key] !== undefined) session.set(key, details[key]);
  }

  if (status !== undefined && status !== session.status) {
    if (status === 'closed') {
      if (session.isCurrent) {
        throw conflict('This is the current session. Make another session current before closing it.');
      }
      closeSession(session);
    } else if (session.isCurrent) {
      throw conflict('The current session must stay open.');
    } else {
      session.status = status;
    }
  }

  await session.save(); // model rules check dates, term fit and overlaps

  const after = { ...pickFields(session, SESSION_KEYS), status: session.status };
  const diff = diffFields(before, after, SESSION_KEYS);
  const entries = [];
  if (diff.changed.length > 0) {
    entries.push(sessionEntry(session, 'session.updated', `Academic session ${session.name} updated: ${diff.changed.join(', ')}`, { before: diff.before, after: diff.after }));
  }
  if (before.status !== after.status) {
    const action = after.status === 'closed' ? 'session.closed' : before.status === 'closed' ? 'session.reopened' : 'session.status_changed';
    entries.push(sessionEntry(session, action, `Academic session ${session.name} ${before.status} -> ${after.status}`, { before: { status: before.status }, after: { status: after.status } }));
  }
  await recordAuditBatch(auth, entries);
  return present(session);
}

// Makes one session the school's current session. The previous current session (if any) is
// closed together with its terms, so there is never more than one current session.
export async function setCurrentSession(auth, id) {
  const target = await findManaged(auth, id);
  if (target.isCurrent) return { ...present(target), previousSessionId: null };
  const targetBefore = target.status;

  target.isCurrent = true;
  target.status = 'open';
  await target.validate(); // fail BEFORE touching the old session

  const previous = await AcademicSession.findOne({ schoolId: auth.schoolId, isCurrent: true });
  if (!previous) {
    await target.save();
    await recordAudit(auth, sessionEntry(target, 'session.activated', `Academic session ${target.name} made current`, { before: { status: targetBefore }, previousSessionId: null }));
    return { ...present(target), previousSessionId: null };
  }

  // The database allows only one current session per school, so the old one is released
  // first. Without transactions (not available on a standalone MongoDB), the old state is
  // restored if the second save fails, so a school is never left without a current session.
  const snapshot = {
    isCurrent: true,
    status: previous.status,
    terms: previous.terms.map((term) => term.toObject()),
  };
  closeSession(previous);
  await previous.save();
  try {
    await target.save();
  } catch (error) {
    await AcademicSession.updateOne({ _id: previous._id, schoolId: auth.schoolId }, { $set: snapshot });
    throw error;
  }
  await recordAuditBatch(auth, [
    sessionEntry(target, 'session.activated', `Academic session ${target.name} made current; ${previous.name} closed`, {
      before: { status: targetBefore },
      previousSessionId: previous._id,
    }),
    sessionEntry(previous, 'session.closed', `Academic session ${previous.name} closed because ${target.name} became current`, {
      before: { status: snapshot.status },
      after: { status: 'closed' },
      closedBecauseSessionId: target._id,
    }),
  ]);
  return { ...present(target), previousSessionId: String(previous._id) };
}

// Only a session that never opened, is not current and holds no records may be deleted.
// Everything else is history: close it instead.
export async function deleteSession(auth, id) {
  const session = await findManaged(auth, id);
  if (session.isCurrent) throw conflict('The current session cannot be deleted.');
  if (session.status !== 'upcoming') {
    throw conflict('Only sessions that never opened can be deleted. Close it instead to keep its history.');
  }
  const reason = await sessionHasRecords(auth.schoolId, session._id);
  if (reason) {
    throw new AppError(409, `This session contains ${reason} and cannot be deleted. It is kept as history.`, {
      code: 'HAS_ACADEMIC_RECORDS',
    });
  }
  await AcademicSession.deleteOne({ _id: session._id, schoolId: auth.schoolId }, { allowHardDelete: true });
  await recordAudit(auth, sessionEntry(session, 'session.deleted', `Unused academic session ${session.name} deleted`, { name: session.name, startDate: session.startDate, endDate: session.endDate }));
}

// --------------------------------------------------------------------------- terms

export async function addTerm(auth, id, data) {
  const session = await findManaged(auth, id);
  if (session.status === 'closed') throw sessionClosed();
  session.terms.push({ ...data, status: 'upcoming', isCurrent: false });
  await session.save(); // at most 3 terms, no repeats, inside the session, no overlaps
  const added = session.terms[session.terms.length - 1];
  await recordAudit(auth, termEntry(session, added, 'term.created', `${added.name} added to session ${session.name}`, {
    startDate: added.startDate,
    endDate: added.endDate,
  }));
  return present(session);
}

export async function updateTerm(auth, id, termId, changes) {
  requireChanges(changes);
  const session = await findManaged(auth, id);
  if (session.status === 'closed') throw sessionClosed();
  const term = findTerm(session, termId);

  if (changes.status !== undefined && changes.status !== 'open' && term.isCurrent) {
    throw conflict('This is the current term and must stay open. Make another term current first.');
  }
  const before = pickFields(term, TERM_KEYS);
  for (const key of TERM_KEYS) {
    if (changes[key] !== undefined) term.set(key, changes[key]);
  }
  await session.save();
  const diff = diffFields(before, pickFields(term, TERM_KEYS), TERM_KEYS);
  const entries = [];
  const detailKeys = diff.changed.filter((k) => k !== 'status');
  if (detailKeys.length > 0) {
    entries.push(termEntry(session, term, 'term.updated', `${term.name} updated: ${detailKeys.join(', ')}`, {
      before: Object.fromEntries(detailKeys.map((k) => [k, diff.before[k]])),
      after: Object.fromEntries(detailKeys.map((k) => [k, diff.after[k]])),
    }));
  }
  if (diff.changed.includes('status')) {
    entries.push(termEntry(session, term, 'term.status_changed', `${term.name} ${diff.before.status} -> ${diff.after.status}`, {
      before: { status: diff.before.status },
      after: { status: diff.after.status },
    }));
  }
  await recordAuditBatch(auth, entries);
  return present(session);
}

// Makes one term the current term of the CURRENT session. The previously current term is
// closed. All terms live inside one session document, so this is a single atomic save.
export async function setCurrentTerm(auth, id, termId) {
  const session = await findManaged(auth, id);
  if (!session.isCurrent) {
    throw new AppError(409, 'Make this session the current session before choosing its current term.', {
      code: 'SESSION_NOT_CURRENT',
    });
  }
  const term = findTerm(session, termId);
  if (term.isCurrent) return present(session);

  let previousTerm = null;
  for (const other of session.terms) {
    if (other.isCurrent) {
      previousTerm = { id: other._id, name: other.name };
      other.isCurrent = false;
      if (other.status === 'open') other.status = 'closed';
    }
  }
  const termStatusBefore = term.status;
  term.isCurrent = true;
  term.status = 'open';
  await session.save();
  await recordAudit(auth, termEntry(session, term, 'term.activated', `${term.name} of ${session.name} made current`, {
    before: { status: termStatusBefore },
    previousTerm,
  }));
  return present(session);
}

// Only a term that never opened, is not current and holds no records may be deleted.
export async function deleteTerm(auth, id, termId) {
  const session = await findManaged(auth, id);
  if (session.status === 'closed') throw sessionClosed();
  const term = findTerm(session, termId);

  if (term.isCurrent) throw conflict('The current term cannot be deleted.');
  if (term.status !== 'upcoming') {
    throw conflict('Only terms that never opened can be deleted. Close it instead to keep its history.');
  }
  const reason = await termHasRecords(auth.schoolId, session._id, term._id);
  if (reason) {
    throw new AppError(409, `This term contains ${reason} and cannot be deleted. It is kept as history.`, {
      code: 'HAS_ACADEMIC_RECORDS',
    });
  }
  const removed = { id: term._id, name: term.name, startDate: term.startDate, endDate: term.endDate };
  session.terms.pull(term._id);
  await session.save();
  await recordAudit(auth, termEntry(session, removed, 'term.deleted', `Unused ${removed.name} removed from session ${session.name}`, removed));
  return present(session);
}
