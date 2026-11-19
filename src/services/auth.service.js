// Sign-in, sign-out, passwords and tokens belong to the Account Management Backend.
// This file only describes the signed-in person (GET /api/auth/me).

import { Student, Teacher } from '../models/index.js';
import {
  toPublicUser,
  toStudentSummary,
  toStudentView,
  toTeacherView,
} from '../utils/serializers.js';

// The role-specific record that belongs to a login account, in its safe API shape.
export async function getProfile(user) {
  const where = { schoolId: user.schoolId };
  switch (user.role) {
    case 'teacher': {
      const teacher = await Teacher.findOne({ ...where, userId: user._id });
      return teacher ? { type: 'teacher', ...toTeacherView(teacher) } : null;
    }
    case 'student': {
      const student = await Student.findOne({ ...where, userId: user._id });
      return student ? { type: 'student', ...toStudentView(student) } : null;
    }
    case 'parent': {
      const children = await Student.find({ ...where, guardianUserIds: user._id }).sort({
        lastName: 1,
        firstName: 1,
      });
      return { type: 'parent', students: children.map(toStudentSummary) };
    }
    default:
      return null; // administrators have no separate profile record
  }
}

export async function getCurrentUser(user) {
  return { user: toPublicUser(user), profile: await getProfile(user) };
}
