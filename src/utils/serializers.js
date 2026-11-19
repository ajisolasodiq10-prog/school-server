// Every API response is built from these explicit allow-lists. Documents are never
// returned directly, so a field added to a model later (or a password hash) can never
// leak by accident.

const str = (value) => (value == null ? undefined : String(value));
const strs = (values) => (values || []).map(String);

export const toPublicUser = (user) => ({
  id: str(user._id),
  schoolId: str(user.schoolId),
  fullName: user.fullName,
  email: user.email ?? null,
  username: user.username,
  role: user.role,
  status: user.status,
  accountStatus: user.accountStatus ?? null, // owned by the account service; mirrored here
  lastLoginAt: user.lastLoginAt ?? null,
  createdAt: user.createdAt,
});

export const toTeacherView = (teacher, { admin = false } = {}) => ({
  id: str(teacher._id),
  teacherId: teacher.teacherId,
  firstName: teacher.firstName,
  middleName: teacher.middleName ?? null,
  lastName: teacher.lastName,
  department: teacher.department ?? null,
  title: teacher.title ?? null,
  phone: teacher.phone ?? null,
  qualification: teacher.qualification ?? null,
  bio: teacher.bio ?? null,
  subjectIds: strs(teacher.subjectIds),
  classIds: strs(teacher.classIds),
  employmentStatus: teacher.employmentStatus,
  ...(admin && {
    userId: str(teacher.userId),
    employmentStatusChangedAt: teacher.employmentStatusChangedAt ?? null,
  }),
});

// Administrators also see the account links; other roles do not need them.
export const toStudentView = (student, { admin = false } = {}) => ({
  id: str(student._id),
  studentId: student.studentId,
  firstName: student.firstName,
  middleName: student.middleName ?? null,
  lastName: student.lastName,
  gender: student.gender,
  dateOfBirth: student.dateOfBirth,
  admissionDate: student.admissionDate,
  currentClassId: str(student.currentClassId) ?? null,
  house: student.house ?? null,
  guardianName: student.guardianName ?? null,
  guardianPhone: student.guardianPhone ?? null,
  guardianEmail: student.guardianEmail ?? null,
  address: student.address ?? null,
  status: student.status,
  statusChangedAt: student.statusChangedAt ?? null,
  ...(admin && {
    userId: str(student.userId) ?? null,
    guardianUserIds: strs(student.guardianUserIds),
    statusNote: student.statusNote ?? null,
    reviewFlag: student.reviewFlag?.reason
      ? { reason: student.reviewFlag.reason, academicSessionId: str(student.reviewFlag.academicSessionId) ?? null, flaggedAt: student.reviewFlag.flaggedAt }
      : null,
  }),
});

export const toClassView = (klass) => ({
  id: str(klass._id),
  name: klass.name,
  arm: klass.arm,
  displayName: `${klass.name}${klass.arm}`,
  classTeacherId: str(klass.classTeacherId) ?? null,
  academicSessionId: str(klass.academicSessionId),
  subjectIds: strs(klass.subjectIds),
  room: klass.room ?? null,
  subjectTeachers: (klass.subjectTeachers || []).map((st) => ({ subjectId: str(st.subjectId), teacherId: str(st.teacherId) })),
  status: klass.status,
});

export const toSubjectView = (subject) => ({
  id: str(subject._id),
  name: subject.name,
  code: subject.code,
  description: subject.description ?? null,
  category: subject.category ?? null,
  status: subject.status,
});

export const toTermView = (term) => ({
  id: str(term._id),
  name: term.name,
  startDate: term.startDate,
  endDate: term.endDate,
  status: term.status,
  isCurrent: Boolean(term.isCurrent),
});

export const toSessionView = (session) => ({
  id: str(session._id),
  name: session.name,
  startDate: session.startDate,
  endDate: session.endDate,
  status: session.status,
  isCurrent: Boolean(session.isCurrent),
  terms: [...(session.terms || [])]
    .sort((a, b) => a.startDate - b.startDate)
    .map(toTermView),
});

// Short version used inside a parent's profile.
export const toStudentSummary = (student) => ({
  id: str(student._id),
  studentId: student.studentId,
  firstName: student.firstName,
  lastName: student.lastName,
  currentClassId: str(student.currentClassId) ?? null,
  status: student.status,
});

export const joinName = (...parts) => parts.filter(Boolean).join(' ');

export const toAuditView = (log) => ({
  id: str(log._id),
  action: log.action,
  entityType: log.entityType,
  entityId: str(log.entityId),
  studentId: str(log.studentId) ?? null,
  actorId: str(log.actorId),
  actorRole: log.actorRole,
  summary: log.summary ?? null,
  details: log.details ?? null,
  createdAt: log.createdAt,
});

export const toDecisionView = (d) => ({
  id: str(d._id),
  studentId: str(d.studentId),
  academicSessionId: str(d.academicSessionId),
  classId: str(d.classId),
  recommendation: d.recommendation ?? null,
  recommendedBy: str(d.recommendedBy) ?? null,
  recommendedAt: d.recommendedAt ?? null,
  decision: d.decision ?? null,
  confirmedBy: str(d.confirmedBy) ?? null,
  confirmedAt: d.confirmedAt ?? null,
  status: d.status,
  appliedAt: d.appliedAt ?? null,
});

const versionMeta = (v) => ({
  number: v.number,
  status: v.status,
  createdBy: str(v.createdBy),
  createdAt: v.createdAt,
  correctionOf: v.correctionOf ?? null,
  submittedBy: str(v.submittedBy) ?? null,
  submittedAt: v.submittedAt ?? null,
  returnedBy: str(v.returnedBy) ?? null,
  returnedAt: v.returnedAt ?? null,
  returnReason: v.returnReason ?? null,
  approvedBy: str(v.approvedBy) ?? null,
  approvedAt: v.approvedAt ?? null,
  publishedBy: str(v.publishedBy) ?? null,
  publishedAt: v.publishedAt ?? null,
  recalledBy: str(v.recalledBy) ?? null,
  recalledAt: v.recalledAt ?? null,
  recallReason: v.recallReason ?? null,
});

const versionFull = (v) => ({
  ...versionMeta(v),
  remarks: v.remarks ?? null,
  entries: (v.entries || []).map((e) => ({ subjectId: str(e.subjectId), score: e.score })),
});

const resultBase = (r) => ({
  id: str(r._id),
  studentId: str(r.studentId),
  academicSessionId: str(r.academicSessionId),
  termId: str(r.termId),
  classId: str(r.classId),
});

// Staff (administrators and teachers of the class) see the whole workflow and every version.
export const toResultStaffView = (r, { versions = true } = {}) => ({
  ...resultBase(r),
  status: r.status,
  currentVersion: r.currentVersion,
  publishedVersion: r.publishedVersion ?? null,
  ...(versions && { versions: r.versions.map(versionFull) }),
});

// Students and parents see ONLY the published version, and nothing while it is recalled.
export const toResultPublishedView = (r) => {
  const v = r.versions.find((x) => x.number === r.publishedVersion);
  return {
    ...resultBase(r),
    version: v.number,
    publishedAt: v.publishedAt,
    remarks: v.remarks ?? null,
    entries: v.entries.map((e) => ({ subjectId: str(e.subjectId), score: e.score })),
  };
};

// ------------------------------------------------------------------ result PINs
// Never includes a PIN, its hash or its salt: the plaintext exists only in the response to
// the request that generated it.
const studentRef = (s) => (s ? { id: str(s._id), studentId: s.studentId, name: joinName(s.firstName, s.middleName, s.lastName) } : null);

export const toPinView = (p, student) => ({
  id: str(p._id),
  studentId: str(p.studentId),
  student: studentRef(student),
  academicSessionId: str(p.academicSessionId),
  termId: str(p.termId),
  status: p.status,
  generatedBy: str(p.generatedBy),
  generatedAt: p.createdAt,
  batchId: str(p.batchId) ?? null,
  redeemedBy: str(p.redeemedBy) ?? null,
  redeemedByRole: p.redeemedByRole ?? null,
  redeemedAt: p.redeemedAt ?? null,
  revokedBy: str(p.revokedBy) ?? null,
  revokedAt: p.revokedAt ?? null,
  revokeReason: p.revokeReason ?? null,
  failedAttempts: p.failedAttempts ?? 0,
});

export const toResultAccessView = (a) => ({
  studentId: str(a.studentId),
  academicSessionId: str(a.academicSessionId),
  termId: str(a.termId),
  unlockedAt: a.redeemedAt,
});

export const toRedemptionView = (a, student, redeemedByName) => ({
  id: str(a._id),
  pinId: str(a.pinId),
  studentId: str(a.studentId),
  student: studentRef(student),
  academicSessionId: str(a.academicSessionId),
  termId: str(a.termId),
  redeemedBy: str(a.redeemedBy),
  redeemedByName: redeemedByName ?? null,
  redeemedByRole: a.redeemedByRole,
  redeemedAt: a.redeemedAt,
});

// ------------------------------------------------------------------ assignments
// `refs` are optional lookups ({ subjects, classes, teachers } as Maps keyed by id string).
export const toAssignmentView = (a, refs = {}, { admin = false, forStudentIds } = {}) => {
  const subject = refs.subjects?.get(str(a.subjectId));
  const klass = refs.classes?.get(str(a.classId));
  const teacher = refs.teachers?.get(str(a.teacherId));
  return {
    id: str(a._id),
    title: a.title,
    description: a.status === 'removed' && !admin ? null : a.description,
    classId: str(a.classId),
    class: klass ? { id: str(klass._id), name: klass.name, arm: klass.arm } : undefined,
    subjectId: str(a.subjectId),
    subject: subject ? { id: str(subject._id), name: subject.name, code: subject.code } : undefined,
    teacher: teacher ? { id: str(teacher._id), name: joinName(teacher.firstName, teacher.middleName, teacher.lastName) } : undefined,
    academicSessionId: str(a.academicSessionId),
    issueDate: a.issueDate,
    dueDate: a.dueDate,
    status: a.status,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    ...(forStudentIds && { forStudentIds }),
    ...(admin && { createdBy: str(a.createdBy), teacherId: str(a.teacherId) }),
    ...(a.status === 'removed' && { removedAt: a.removedAt ?? null, removalReason: a.removalReason ?? null }),
  };
};

// ------------------------------------------------------------------ announcements
export const toAnnouncementStaffView = (a, state) => ({
  id: str(a._id),
  title: a.title,
  body: a.body,
  audience: a.audience,
  classId: str(a.classId) ?? null,
  category: a.category,
  status: a.status,
  state,
  startsAt: a.startsAt ?? null,
  expiresAt: a.expiresAt ?? null,
  createdBy: str(a.createdBy),
  publishedBy: str(a.publishedBy) ?? null,
  publishedAt: a.publishedAt ?? null,
  archivedAt: a.archivedAt ?? null,
  createdAt: a.createdAt,
  updatedAt: a.updatedAt,
});

// Everything a reader (or the public website) is allowed to see: no author, no workflow.
export const toAnnouncementReaderView = (a) => ({
  id: str(a._id),
  title: a.title,
  body: a.body,
  audience: a.audience,
  classId: str(a.classId) ?? null,
  category: a.category,
  startsAt: a.startsAt ?? null,
  expiresAt: a.expiresAt ?? null,
  publishedAt: a.publishedAt ?? null,
});

// ------------------------------------------------------------------ entry requirements
const sectionView = (s) => ({ kind: s.kind, title: s.title, body: s.body ?? null, items: [...(s.items || [])] });
const classRequirementView = (c) => ({ classLevel: c.classLevel, items: [...(c.items || [])], notes: c.notes ?? null });

export const toRequirementSummary = (r, { isCurrent = false } = {}) => ({
  id: str(r._id),
  versionNumber: r.versionNumber,
  basedOnVersion: r.basedOnVersion ?? null,
  title: r.title,
  status: r.status,
  isCurrent,
  effectiveDate: r.effectiveDate ?? null,
  publishedAt: r.publishedAt ?? null,
  publishedBy: str(r.publishedBy) ?? null,
  archivedAt: r.archivedAt ?? null,
  archiveReason: r.archiveReason ?? null,
  createdBy: str(r.createdBy),
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

export const toRequirementFullView = (r, options) => ({
  ...toRequirementSummary(r, options),
  summary: r.summary ?? null,
  sections: (r.sections || []).map(sectionView),
  classRequirements: (r.classRequirements || []).map(classRequirementView),
});

// What the public website gets: the content and when it took effect, nothing internal.
export const toRequirementPublicView = (r) => ({
  versionNumber: r.versionNumber,
  title: r.title,
  summary: r.summary ?? null,
  sections: (r.sections || []).map(sectionView),
  classRequirements: (r.classRequirements || []).map(classRequirementView),
  effectiveDate: r.effectiveDate,
  publishedAt: r.publishedAt ?? null,
});

// ------------------------------------------------------------------ notifications
export const toNotificationView = (n) => ({
  id: str(n._id),
  type: n.type,
  title: n.title,
  message: n.message ?? null,
  entityType: n.entityType ?? null,
  entityId: str(n.entityId) ?? null,
  studentId: str(n.studentId) ?? null,
  availableAt: n.availableAt,
  read: Boolean(n.readAt),
  readAt: n.readAt ?? null,
});

// ------------------------------------------------------------------ result sheets
export const toSheetView = (sheet) => ({
  id: str(sheet._id),
  classId: str(sheet.classId),
  subjectId: str(sheet.subjectId),
  academicSessionId: str(sheet.academicSessionId),
  termId: str(sheet.termId),
  teacherId: str(sheet.teacherId),
  status: sheet.status,
  scores: (sheet.scores || []).map((x) => ({ studentId: str(x.studentId), ca: x.ca ?? null, exam: x.exam ?? null })),
  submittedAt: sheet.submittedAt ?? null,
  reviewedAt: sheet.reviewedAt ?? null,
  reviewedByName: sheet.reviewedByName ?? null,
  feedback: sheet.feedback?.message ? { message: sheet.feedback.message, at: sheet.feedback.at ?? null, byName: sheet.feedback.byName ?? null } : null,
  publishedAt: sheet.publishedAt ?? null,
  publishedByName: sheet.publishedByName ?? null,
  createdAt: sheet.createdAt,
  updatedAt: sheet.updatedAt,
});

// ------------------------------------------------------------------ calendar, materials, timetable
export const toEventView = (e) => ({
  id: str(e._id),
  type: e.type,
  title: e.title,
  description: e.description ?? null,
  startDate: e.startDate,
  endDate: e.endDate ?? null,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
});

export const toMaterialView = (m, refs = {}) => {
  const subject = refs.subjects?.get(str(m.subjectId));
  const klass = refs.classes?.get(str(m.classId));
  const teacher = refs.teachers?.get(str(m.teacherId));
  return {
    id: str(m._id),
    title: m.title,
    description: m.description,
    type: m.type,
    link: m.link ?? null,
    classId: str(m.classId),
    class: klass ? { id: str(klass._id), name: klass.name, arm: klass.arm } : undefined,
    subjectId: str(m.subjectId),
    subject: subject ? { id: str(subject._id), name: subject.name, code: subject.code } : undefined,
    teacher: teacher ? { id: str(teacher._id), name: joinName(teacher.firstName, teacher.middleName, teacher.lastName) } : undefined,
    academicSessionId: str(m.academicSessionId),
    status: m.status,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
  };
};

export const toTimetableView = (t, subjects = new Map()) => ({
  classId: str(t.classId),
  periods: t.periods.map((p) => ({ start: p.start, end: p.end, breakLabel: p.breakLabel ?? null })),
  days: t.days.map((d) => ({
    name: d.name,
    lessons: d.lessons.map((l) => {
      const subject = l.subjectId ? subjects.get(str(l.subjectId)) : null;
      return { subjectId: str(l.subjectId) ?? null, subject: subject ? subject.name : null, room: l.room ?? null };
    }),
  })),
  updatedAt: t.updatedAt,
});
