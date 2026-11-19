import { SESSION_STATUSES, TERM_NAMES, TERM_STATUSES } from '../models/AcademicSession.js';
import { CLASS_STATUSES } from '../models/Class.js';
import { GENDERS, STUDENT_STATUSES } from '../models/Student.js';
import { EMPLOYMENT_STATUSES } from '../models/Teacher.js';
import { PROMOTION_STATUSES, PROMOTION_VALUES } from '../models/PromotionDecision.js';
import { RESULT_STATUSES } from '../models/Result.js';
import { PIN_STATUSES } from '../models/ResultPin.js';
import { ASSIGNMENT_STATUSES, TEACHER_ASSIGNMENT_STATUSES } from '../models/Assignment.js';
import { ANNOUNCEMENT_AUDIENCES, ANNOUNCEMENT_CATEGORIES, ANNOUNCEMENT_STATUSES } from '../models/Announcement.js';
import { EVENT_TYPES } from '../models/CalendarEvent.js';
import { MATERIAL_TYPES } from '../models/LearningMaterial.js';
import { TIMETABLE_DAYS } from '../models/Timetable.js';
import { REQUIREMENT_STATUSES, SECTION_KINDS } from '../models/EntryRequirement.js';
import { SHEET_STATUSES } from '../models/ResultSheet.js';
import { SUBJECT_CATEGORIES, SUBJECT_STATUSES } from '../models/Subject.js';
import { ACCOUNT_STATUSES, USER_ROLES, USER_STATUSES } from '../models/User.js';
import { nullable, optional, rules } from './validate.js';

// Allowed request fields for every endpoint. Anything not listed here is rejected.
// Note what is NOT here on purpose: schoolId, role, status, passwordHash, userId. A client
// can never set those through a request body. There is no password anywhere: credentials belong
// to the Account Management Backend.

const { text, email, username, objectId, enumOf, date, intString, idList, objects } = rules;

const name = (max = 60) => text({ max });
const code = (max) => text({ uppercase: true, max, pattern: /^[A-Z0-9_/-]+$/i, patternMessage: 'may only contain letters, numbers, hyphens, underscores and slashes' });

export const pagination = {
  page: optional(intString({ min: 1, max: 100000 })),
  limit: optional(intString({ min: 1, max: 100 })),
};

export const idParam = { id: objectId() };

export const listAccounts = {
  role: optional(enumOf(USER_ROLES)),
  status: optional(enumOf(USER_STATUSES)),
  accountStatus: optional(enumOf(ACCOUNT_STATUSES)),
  ...pagination,
};

export const createTeacher = {
  username: optional(username()), // defaults to the teacher ID
  email: email(), // required: activation and password-reset emails go here
  teacherId: optional(code(40)), // generated (TCH-0001, ...) when left out
  firstName: name(),
  middleName: optional(name()),
  lastName: name(),
  department: optional(text({ max: 100 })),
  title: optional(text({ max: 20 })),
  phone: optional(text({ max: 30 })),
  subjectIds: optional(idList()),
  classIds: optional(idList()),
};

export const createStudent = {
  username: optional(username()),
  email: optional(email()), // students need neither an email nor a phone number
  studentId: optional(code(40)), // generated (STU-2026-0001, ...) when left out
  firstName: name(),
  middleName: optional(name()),
  lastName: name(),
  gender: enumOf(GENDERS),
  dateOfBirth: date(),
  admissionDate: date(),
  currentClassId: optional(objectId()),
  house: optional(text({ max: 60 })),
  guardianName: optional(text({ max: 150 })),
  guardianPhone: optional(text({ max: 30 })),
  guardianEmail: optional(email()),
  address: optional(text({ max: 300 })),
};

export const createStudentAccountParams = { studentRecordId: objectId() };

export const createStudentAccountBody = {
  username: optional(username()),
  email: optional(email()),
};

export const createParent = {
  fullName: text({ max: 150 }),
  username: username(),
  email: optional(email()), // students need neither an email nor a phone number
  studentIds: optional(idList()),
};

// Superset of every editable field. updateAccount() then allows only the ones that make
// sense for the role of the account being edited.
export const updateAccount = {
  email: optional(email()),
  fullName: optional(text({ max: 150 })),
  firstName: optional(name()),
  middleName: optional(name()),
  lastName: optional(name()),
  department: optional(text({ max: 100 })),
  gender: optional(enumOf(GENDERS)),
  dateOfBirth: optional(date()),
  // Classes and subjects are NOT changed here: use PUT /api/teachers/:id/assignments and
  // PUT /api/students/:id/class, which check the class and keep the history.
};

export const linkStudents = { studentIds: idList() };

export const listStudents = {
  q: optional(text({ max: 60, collapseSpaces: true })),
  classId: optional(objectId()),
  status: optional(enumOf(STUDENT_STATUSES)),
  needsReview: optional(enumOf(['true'])), // students a session rollover could not place
  ...pagination,
};

// Registering a student: the record and a login account waiting for activation.
export const registerStudent = { ...createStudent };

export const updateStudent = {
  firstName: optional(name()),
  middleName: optional(nullable(name())),
  lastName: optional(name()),
  gender: optional(enumOf(GENDERS)),
  dateOfBirth: optional(date()),
  admissionDate: optional(date()),
  email: optional(nullable(email())), // the email of the student's login account
  house: optional(nullable(text({ max: 60 }))),
  guardianName: optional(nullable(text({ max: 150 }))),
  guardianPhone: optional(nullable(text({ max: 30 }))),
  guardianEmail: optional(nullable(email())),
  address: optional(nullable(text({ max: 300 }))),
};

// A reason is required for every manual class change; it is kept in the audit trail.
const reason = () => text({ min: 3, max: 300, collapseSpaces: true });

export const assignStudentClass = { classId: objectId(), reason: reason() };

export const promoteStudents = {
  studentIds: idList({ max: 200 }),
  classId: objectId(),
  reason: optional(reason()),
};

export const setStudentStatus = {
  status: enumOf(STUDENT_STATUSES),
  // When the student actually left (defaults to now). Cannot be in the future.
  effectiveDate: optional(date()),
  note: optional(text({ max: 300, collapseSpaces: true })), // e.g. the new school
};

// --------------------------------------------------------------------- teachers
export const listTeachers = {
  q: optional(text({ max: 60, collapseSpaces: true })),
  status: optional(enumOf(EMPLOYMENT_STATUSES)),
  classId: optional(objectId()),
  subjectId: optional(objectId()),
  ...pagination,
};

export const updateTeacher = {
  firstName: optional(name()),
  middleName: optional(nullable(name())),
  lastName: optional(name()),
  department: optional(nullable(text({ max: 100 }))),
  title: optional(nullable(text({ max: 20 }))),
  phone: optional(nullable(text({ max: 30 }))),
  email: optional(nullable(email())),
};

export const setTeacherAssignments = {
  classIds: optional(idList({ max: 60 })),
  subjectIds: optional(idList({ max: 60 })),
};

export const setEmploymentStatus = { employmentStatus: enumOf(EMPLOYMENT_STATUSES) };

// ---------------------------------------------------------------------- parents
export const listParents = {
  q: optional(text({ max: 60, collapseSpaces: true })),
  status: optional(enumOf(USER_STATUSES)),
  ...pagination,
};

export const parentStudentParams = { id: objectId(), studentId: objectId() };

// ------------------------------------------------------------- academic sessions
const sessionName = () =>
  text({ pattern: /^\d{4}\/\d{4}$/, patternMessage: 'must look like 2026/2027', max: 9, min: 9 });

const termFields = {
  name: enumOf(TERM_NAMES),
  startDate: date(),
  endDate: date(),
};

export const createSession = {
  name: sessionName(),
  startDate: date(),
  endDate: date(),
  terms: optional(rules.objects(termFields, { max: 3 })),
};

export const updateSession = {
  name: optional(sessionName()),
  startDate: optional(date()),
  endDate: optional(date()),
  status: optional(enumOf(SESSION_STATUSES)),
};

export const listSessions = {
  status: optional(enumOf(SESSION_STATUSES)),
  ...pagination,
};

export const createTerm = termFields;

export const updateTerm = {
  name: optional(enumOf(TERM_NAMES)),
  startDate: optional(date()),
  endDate: optional(date()),
  status: optional(enumOf(TERM_STATUSES)),
};

export const termParams = { id: objectId(), termId: objectId() };

// ----------------------------------------------------------------------- classes
const className = () =>
  text({
    uppercase: true,
    collapseSpaces: true,
    max: 30,
    pattern: /^[A-Z0-9][A-Z0-9 ]*$/,
    patternMessage: 'may only contain letters, numbers and spaces (for example "JSS 1")',
  });

const classArm = () =>
  text({ uppercase: true, max: 10, pattern: /^[A-Z0-9]+$/, patternMessage: 'may only contain letters and numbers (for example "A")' });

export const createClass = {
  name: className(),
  arm: classArm(),
  academicSessionId: objectId(),
  classTeacherId: optional(objectId()),
  room: optional(text({ max: 60 })),
};

// The session cannot be changed after creation: a class belongs to one session for good.
export const updateClass = {
  name: optional(className()),
  arm: optional(classArm()),
  classTeacherId: optional(nullable(objectId())),
  room: optional(nullable(text({ max: 60 }))),
};

export const listClasses = {
  academicSessionId: optional(objectId()),
  status: optional(enumOf(CLASS_STATUSES)),
  ...pagination,
};

export const setClassSubjects = { subjectIds: idList({ max: 60 }) };

// One subject's teacher inside one class.
export const classSubjectParams = { id: objectId(), subjectId: objectId() };
export const setClassSubjectTeacher = { teacherId: objectId() };

// --------------------------------------------------------------------- subjects
export const createSubject = {
  name: text({ max: 100, collapseSpaces: true }),
  code: text({
    uppercase: true,
    min: 2,
    max: 20,
    pattern: /^[A-Z0-9_-]+$/,
    patternMessage: 'may only contain letters, numbers, hyphens and underscores',
  }),
  description: optional(text({ max: 500 })),
  category: optional(enumOf(SUBJECT_CATEGORIES)),
};

// The subject code cannot be changed after creation, because printed reports and records
// refer to it.
export const updateSubject = {
  name: optional(text({ max: 100, collapseSpaces: true })),
  description: optional(nullable(text({ max: 500 }))),
  category: optional(nullable(enumOf(SUBJECT_CATEGORIES))),
};

export const listSubjects = {
  status: optional(enumOf(SUBJECT_STATUSES)),
  classId: optional(objectId()),
  ...pagination,
};

// ------------------------------------------------------------ promotion decisions
const promotionValue = () => enumOf(PROMOTION_VALUES);

export const recommendPromotion = {
  studentId: objectId(),
  academicSessionId: objectId(),
  recommendation: promotionValue(),
};

// `decision` left out = confirm the teacher's recommendation as it is.
export const confirmPromotion = {
  studentId: objectId(),
  academicSessionId: objectId(),
  decision: optional(promotionValue()),
};

export const listPromotionDecisions = {
  academicSessionId: optional(objectId()),
  classId: optional(objectId()),
  status: optional(enumOf(PROMOTION_STATUSES)),
  ...pagination,
};

// ---------------------------------------------------------------- new session
export const startNewSession = {
  name: sessionName(),
  startDate: date(),
  endDate: date(),
  terms: optional(rules.objects(termFields, { max: 3 })),
  startFirstTerm: optional(rules.bool()), // default true: the earliest term opens straight away
  allowUnconfirmed: optional(rules.bool()), // default false: missing decisions block the start
};

// --------------------------------------------------------------------- results
const scoreEntries = rules.objects({ subjectId: objectId(), score: rules.number({ min: 0, max: 100 }) }, { max: 40 });

export const saveResult = {
  studentId: objectId(),
  academicSessionId: objectId(),
  termId: objectId(),
  entries: scoreEntries,
  remarks: optional(nullable(text({ max: 500 }))),
  promotionRecommendation: optional(promotionValue()), // Third Term only
};

export const resultReason = { reason: text({ min: 3, max: 500, collapseSpaces: true }) };

export const listResults = {
  academicSessionId: optional(objectId()),
  termId: optional(objectId()),
  classId: optional(objectId()),
  studentId: optional(objectId()),
  status: optional(enumOf(RESULT_STATUSES)),
  ...pagination,
};

// -------------------------------------------------------------- result sheets
// One sheet = one class, one subject and one term, with a CA and an exam score per student.
const sheetScores = rules.objects(
  {
    studentId: objectId(),
    ca: optional(nullable(rules.number({ min: 0, max: 1000 }))),
    exam: optional(nullable(rules.number({ min: 0, max: 1000 }))),
  },
  { max: 300 }
);

export const saveResultSheet = {
  classId: objectId(),
  subjectId: objectId(),
  academicSessionId: objectId(),
  termId: objectId(),
  scores: sheetScores,
};

export const returnResultSheet = { reason: text({ min: 10, max: 500, collapseSpaces: true }) };

export const listResultSheets = {
  academicSessionId: optional(objectId()),
  termId: optional(objectId()),
  classId: optional(objectId()),
  subjectId: optional(objectId()),
  status: optional(enumOf(SHEET_STATUSES)),
  ...pagination,
};

// What a student (or a parent, for a linked child) sees.
export const publishedTerms = { studentId: optional(objectId()) };
export const publishedTerm = { studentId: optional(objectId()), academicSessionId: objectId(), termId: objectId() };

// ------------------------------------------------------------------ result PINs
export const generatePin = { studentId: objectId(), academicSessionId: objectId(), termId: objectId() };

export const generatePinsBulk = {
  academicSessionId: objectId(),
  termId: objectId(),
  studentIds: optional(idList({ max: 100 })), // either these...
  classId: optional(objectId()), // ...or everyone active in this class
};

export const listPins = {
  studentId: optional(objectId()),
  academicSessionId: optional(objectId()),
  termId: optional(objectId()),
  status: optional(enumOf(PIN_STATUSES)),
  q: optional(text({ max: 100, collapseSpaces: true })),
  ...pagination,
};

export const listRedemptions = {
  studentId: optional(objectId()),
  academicSessionId: optional(objectId()),
  termId: optional(objectId()),
  ...pagination,
};

// The PIN is checked in the service (spaces and hyphens allowed); here it only has to be text.
export const redeemPin = {
  studentId: objectId(),
  academicSessionId: objectId(),
  termId: objectId(),
  pin: text({ max: 40 }),
};

export const listResultAccess = { studentId: optional(objectId()) };

// ------------------------------------------------------------------ audit trail
export const listAuditLogs = {
  entityType: optional(text({ max: 40, pattern: /^[a-z_]+$/ })),
  entityId: optional(objectId()),
  studentId: optional(objectId()),
  actorId: optional(objectId()),
  actorRole: optional(enumOf(USER_ROLES)),
  action: optional(text({ max: 60, pattern: /^[a-z_.]+$/ })),
  from: optional(date()),
  to: optional(date()),
  q: optional(text({ max: 100, collapseSpaces: true })),
  ...pagination,
};

// ------------------------------------------------------------------ reports
// Every filter is optional. Which ones a report accepts is decided per report
// (services/reports): a filter that does not apply to it is refused with a clear message.
const reportFilters = {
  academicSessionId: optional(objectId()),
  termId: optional(objectId()),
  classId: optional(objectId()),
  arm: optional(text({ uppercase: true, max: 10 })),
  subjectId: optional(objectId()),
  status: optional(text({ max: 30, pattern: /^[a-z_]+$/ })),
  from: optional(date()),
  to: optional(date()),
};
export const reportKeyParam = { key: text({ max: 40, pattern: /^[a-z-]+$/ }) };
export const runReport = { ...reportFilters, ...pagination };
export const exportReport = { ...reportFilters, format: enumOf(['csv', 'pdf']) };

// ------------------------------------------------------------------ assignments
const longText = (max) => text({ max, collapseSpaces: false });

export const createAssignment = {
  classId: objectId(),
  subjectId: objectId(),
  title: text({ max: 200, collapseSpaces: true }),
  description: longText(5000),
  issueDate: optional(date()), // defaults to now
  dueDate: date(),
};

// The class and subject of an assignment never change (create a new one instead).
export const updateAssignment = {
  title: optional(text({ max: 200, collapseSpaces: true })),
  description: optional(longText(5000)),
  issueDate: optional(date()),
  dueDate: optional(date()),
  status: optional(enumOf(TEACHER_ASSIGNMENT_STATUSES)),
};

export const listAssignments = {
  classId: optional(objectId()),
  subjectId: optional(objectId()),
  studentId: optional(objectId()), // a parent's child (or the student themselves)
  status: optional(enumOf(ASSIGNMENT_STATUSES)),
  q: optional(text({ max: 100, collapseSpaces: true })),
  ...pagination,
};

// ------------------------------------------------------------------ announcements
export const createAnnouncement = {
  title: text({ max: 200, collapseSpaces: true }),
  body: longText(10000),
  audience: enumOf(ANNOUNCEMENT_AUDIENCES),
  classId: optional(objectId()), // required when the audience is a class
  category: optional(enumOf(ANNOUNCEMENT_CATEGORIES)),
  startsAt: optional(date()),
  expiresAt: optional(date()),
};

export const updateAnnouncement = {
  title: optional(text({ max: 200, collapseSpaces: true })),
  body: optional(longText(10000)),
  audience: optional(enumOf(ANNOUNCEMENT_AUDIENCES)), // only while it is still a draft
  classId: optional(nullable(objectId())),
  category: optional(enumOf(ANNOUNCEMENT_CATEGORIES)),
  startsAt: optional(nullable(date())),
  expiresAt: optional(nullable(date())),
};

export const scheduleAnnouncement = { startsAt: date() };

export const listAnnouncements = {
  status: optional(enumOf(ANNOUNCEMENT_STATUSES)), // administrators
  audience: optional(enumOf(ANNOUNCEMENT_AUDIENCES)),
  category: optional(enumOf(ANNOUNCEMENT_CATEGORIES)),
  ...pagination,
};

// ------------------------------------------------------------------ entry requirements
const requirementItem = text({ max: 500, collapseSpaces: true });
const itemList = (max) => (raw) => {
  if (!Array.isArray(raw)) return { error: 'must be a list' };
  if (raw.length > max) return { error: `must contain at most ${max} items` };
  const items = [];
  for (const item of raw) {
    const result = requirementItem(item);
    if (result.error) return { error: `an item ${result.error}` };
    items.push(result.value);
  }
  return { value: items };
};
const sectionShape = {
  kind: enumOf(SECTION_KINDS),
  title: text({ max: 150, collapseSpaces: true }),
  body: optional(text({ max: 3000 })),
  items: optional(itemList(30)),
};
const classRequirementShape = {
  classLevel: text({ max: 30, collapseSpaces: true }),
  items: optional(itemList(30)),
  notes: optional(text({ max: 2000 })),
};

export const createRequirementDraft = {
  title: text({ max: 200, collapseSpaces: true }),
  summary: optional(text({ max: 3000 })),
  sections: optional(objects(sectionShape, { max: 20 })),
  classRequirements: optional(objects(classRequirementShape, { max: 30 })),
  effectiveDate: optional(date()),
};

export const updateRequirementDraft = {
  title: optional(text({ max: 200, collapseSpaces: true })),
  summary: optional(text({ max: 3000 })),
  sections: optional(objects(sectionShape, { max: 20 })),
  classRequirements: optional(objects(classRequirementShape, { max: 30 })),
  effectiveDate: optional(date()),
};

export const publishRequirement = { effectiveDate: optional(date()) };
export const archiveRequirement = { reason: text({ min: 3, max: 500, collapseSpaces: true }) };

export const listRequirements = { status: optional(enumOf(REQUIREMENT_STATUSES)), ...pagination };

// ------------------------------------------------------------------ notifications
export const listNotifications = { unread: optional(enumOf(['true', 'false'])), ...pagination };

// ------------------------------------------------------------------ public (no sign-in)
export const publicQuery = {
  schoolCode: optional(text({ uppercase: true, max: 20, pattern: /^[A-Z0-9_-]+$/ })),
  ...pagination,
};

export const publicSchool = { schoolCode: optional(text({ uppercase: true, max: 20, pattern: /^[A-Z0-9_-]+$/ })) };

// Admin-assisted password reset for a student. The reason is optional and goes to the audit trail.
export const requestStudentReset = { reason: optional(text({ min: 3, max: 300, collapseSpaces: true })) };
export const accountStatusReason = { reason: optional(text({ min: 3, max: 300, collapseSpaces: true })) };

// ------------------------------------------------------------------ calendar events
export const createCalendarEvent = {
  type: enumOf(EVENT_TYPES),
  title: text({ max: 200, collapseSpaces: true }),
  description: optional(longText(2000)),
  startDate: date(),
  endDate: optional(date()),
};

export const updateCalendarEvent = {
  type: optional(enumOf(EVENT_TYPES)),
  title: optional(text({ max: 200, collapseSpaces: true })),
  description: optional(nullable(longText(2000))),
  startDate: optional(date()),
  endDate: optional(nullable(date())),
};

export const listCalendarEvents = {
  type: optional(enumOf(EVENT_TYPES)),
  from: optional(date()),
  to: optional(date()),
  ...pagination,
};

// ------------------------------------------------------------------ learning materials
export const createMaterial = {
  classId: objectId(),
  subjectId: objectId(),
  title: text({ max: 200, collapseSpaces: true }),
  description: longText(5000),
  type: enumOf(MATERIAL_TYPES),
  link: optional(text({ max: 2000 })),
};

// The class and subject of a material never change.
export const updateMaterial = {
  title: optional(text({ max: 200, collapseSpaces: true })),
  description: optional(longText(5000)),
  type: optional(enumOf(MATERIAL_TYPES)),
  link: optional(nullable(text({ max: 2000 }))),
};

export const listMaterials = {
  classId: optional(objectId()),
  subjectId: optional(objectId()),
  ...pagination,
};

// ------------------------------------------------------------------ timetable
const hhmm = text({ max: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/, patternMessage: 'must be a time such as 08:30' });
export const saveTimetable = {
  periods: objects({ start: hhmm, end: hhmm, breakLabel: optional(nullable(text({ max: 60, collapseSpaces: true }))) }, { max: 20 }),
  days: objects(
    {
      name: enumOf(TIMETABLE_DAYS),
      lessons: objects({ subjectId: optional(nullable(objectId())), room: optional(nullable(text({ max: 60, collapseSpaces: true }))) }, { max: 20 }),
    },
    { max: 7 }
  ),
};
export const classIdParam = { classId: objectId() };

// ------------------------------------------------------------------ settings and own profile
export const saveSettings = {
  schoolName: text({ max: 150, collapseSpaces: true }),
  address: text({ max: 300, collapseSpaces: true }),
  email: email(),
  phone: text({ max: 30, pattern: /^\+?[0-9\s()-]{7,20}$/, patternMessage: 'is not a valid phone number' }),
  caMax: rules.number({ min: 1, max: 99 }),
  examMax: rules.number({ min: 1, max: 99 }),
  gradeBands: objects({ grade: text({ max: 2, uppercase: true }), remark: optional(text({ max: 30, collapseSpaces: true })), min: rules.number({ min: 0, max: 100 }) }, { max: 12 }),
  showGrade: rules.bool(),
  showClassAverage: rules.bool(),
  showRemarks: rules.bool(),
};

export const updateMyProfile = {
  fullName: optional(text({ max: 150, collapseSpaces: true })), // administrators only (checked in the service)
  email: optional(email()),
  title: optional(nullable(text({ max: 20 }))),
  phone: optional(nullable(text({ max: 30, pattern: /^\+?[0-9\s()-]{7,20}$/, patternMessage: 'is not a valid phone number' }))),
  qualification: optional(nullable(text({ max: 200 }))),
  bio: optional(nullable(longText(300))),
};
