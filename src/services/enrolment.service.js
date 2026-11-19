import { Class } from '../models/index.js';

// Which class was this student in during a given academic session? Answered from the
// student's class history (every class they have ever been in), so it stays correct after
// promotions and class changes. Returns the Class document, or null if they were not
// enrolled in that session.
export async function classForSession(schoolId, student, sessionId) {
  const ids = [...student.classHistory.map((e) => e.classId), student.currentClassId].filter(Boolean);
  if (ids.length === 0) return null;
  const classes = await Class.find({ _id: { $in: [...new Set(ids.map(String))] }, schoolId, academicSessionId: sessionId });
  if (classes.length === 0) return null;
  const byId = new Map(classes.map((c) => [String(c._id), c]));
  // Most recent placement first.
  for (const id of [student.currentClassId, ...[...student.classHistory].reverse().map((e) => e.classId)]) {
    const found = id && byId.get(String(id));
    if (found) return found;
  }
  return null;
}
