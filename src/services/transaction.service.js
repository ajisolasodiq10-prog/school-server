import mongoose from 'mongoose';

// "All or nothing" for operations that change many documents.
//
// MongoDB transactions need a replica set (or a sharded cluster); a plain local install has
// none. So runAtomically() uses a real transaction where the server supports it, and
// otherwise falls back to a compensating undo log: every step registers how to reverse
// itself, and if anything fails the steps are reversed in the opposite order. Either way a
// failure part-way leaves nothing half-done.
//
//   await runAtomically(async ({ session, journal }) => {
//     await Thing.updateOne(filter, change, { session });       // always pass `session`
//     journal.add(() => Thing.updateOne(filter, undoChange));   // how to put it back
//   });
//
// `session` is undefined without transactions (passing it to Mongoose is then harmless).
// The undo steps are only used without transactions, but are always registered, so the
// same code runs in both modes. The work function must be safe to run again: a transaction
// can be retried by the driver on a transient error.
//
// Known limit of the fallback: if the server process itself dies mid-operation, nothing can
// run the undo steps. Use a replica set in production to remove that gap.

let supported = null; // null = not checked yet
let forcedOff = false; // tests can switch transactions off to exercise the fallback

export async function transactionsSupported() {
  if (forcedOff) return false;
  if (supported !== null) return supported;
  try {
    const db = mongoose.connection.db;
    const info = await db.admin().command({ hello: 1 }).catch(() => db.admin().command({ isMaster: 1 }));
    supported = Boolean(info.setName) || info.msg === 'isdbgrid';
  } catch {
    supported = false;
  }
  return supported;
}

// For tests only: true forces the undo-log fallback even on a replica set.
export function forceCompensationMode(on) {
  forcedOff = Boolean(on);
}

export class Journal {
  #undo = [];

  add(undo) {
    this.#undo.push(undo);
  }

  get size() {
    return this.#undo.length;
  }

  // Runs every undo step, newest first. A failing step does not stop the others.
  async rollback() {
    const failures = [];
    for (const undo of this.#undo.reverse()) {
      try {
        await undo();
      } catch (error) {
        failures.push(error);
      }
    }
    this.#undo = [];
    return failures;
  }
}

export async function runAtomically(work) {
  if (await transactionsSupported()) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await work({ session, journal: new Journal() });
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  const journal = new Journal();
  try {
    return await work({ session: undefined, journal });
  } catch (error) {
    const failures = await journal.rollback();
    if (failures.length > 0) error.rollbackFailures = failures.map((f) => f.message);
    throw error;
  }
}
