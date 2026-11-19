import { conflict } from '../utils/AppError.js';
import { getAccountStatus, setAccountStatus as setRemoteStatus, updateAccountContact } from './accountManagement.service.js';

// Keeping a person's school-side record and their login account in step.
//
// The account service owns the account status; this backend mirrors it on the User record
// (accountStatus) and keeps its own school-side access flag (status). The rule everywhere:
// change the ACCOUNT SERVICE first, and only when that succeeded change the local record. If the
// local save then fails, the account service is put back, so the two never disagree silently.

// account status -> school-side access flag
const LOCAL_STATUS = { active: 'active', deactivated: 'inactive', suspended: 'suspended' };
export const localStatusFor = (accountStatus) => LOCAL_STATUS[accountStatus];

// The mirror says 'pending_activation' until something refreshes it, but the person may have used
// their link since. Ask the account service before deciding anything from a pending mirror.
export async function refreshPendingMirror(user) {
  if (user.accountId && user.accountStatus === 'pending_activation') {
    const live = await getAccountStatus(user.accountId);
    if (live.status !== 'pending_activation') {
      user.accountStatus = live.status;
      user.accountStatusSyncedAt = new Date();
    }
  }
}

// Moves the account to `desired` ('active' | 'deactivated' | 'suspended') and updates the
// in-memory user (the caller saves it). Returns { changed, previous } so the caller can undo.
export async function changeAccess(auth, user, desired, reason) {
  if (!user.accountId) {
    throw conflict('This person has no linked login account yet, so access cannot be changed. Run the account migration first.');
  }
  await refreshPendingMirror(user);
  const previous = { status: user.status, accountStatus: user.accountStatus };

  // An account that was never activated has nothing to switch on: it becomes active only when the
  // person uses their activation link. Other states are still allowed (a pending account may be deactivated).
  if (desired === 'active' && user.accountStatus === 'pending_activation') return { changed: false, previous };

  if (user.accountStatus !== desired) {
    await setRemoteStatus(user.accountId, desired, { requestedBy: auth, reason });
    user.accountStatus = desired;
    user.accountStatusSyncedAt = new Date();
  }
  user.status = LOCAL_STATUS[desired];
  return { changed: true, previous };
}

// Best-effort undo of changeAccess() after the local save failed.
export async function undoAccess(auth, user, previous) {
  if (!user.accountId || previous.accountStatus === user.accountStatus || previous.accountStatus === 'pending_activation') return;
  try {
    await setRemoteStatus(user.accountId, previous.accountStatus, { requestedBy: auth, reason: 'rollback' });
  } catch {
    // The caller is already reporting the original failure. The next status read repairs the mirror.
  }
}

// Passes a changed email or name on to the account service BEFORE the local save, so a failure
// leaves both sides unchanged. Does nothing when the person has no account or nothing changed.
export async function syncContact(user, { email, fullName }) {
  if (!user?.accountId) return;
  const change = {};
  if (email !== undefined) change.email = email ?? null;
  if (fullName !== undefined) change.fullName = fullName;
  if (Object.keys(change).length > 0) await updateAccountContact(user.accountId, change);
}
