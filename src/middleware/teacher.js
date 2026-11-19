import { Teacher } from '../models/index.js';
import { forbidden } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Blocks a signed-in TEACHER whose employment is not 'active' (on leave, inactive, resigned,
// retired). Other roles pass straight through. Use it on every protected teacher function:
//   router.post('/x', authenticate, requireActiveTeacher, handler)
//
// A resigned, retired or deactivated teacher's login is also closed by authenticate(); this
// check additionally covers teachers on leave, whose login stays open. Status is read from
// the database on every request, so a change applies at once.
export const requireActiveTeacher = asyncHandler(async (req, res, next) => {
  if (req.auth?.role !== 'teacher') return next();

  const teacher = await Teacher.findOne({
    schoolId: req.auth.schoolId,
    userId: req.auth.userId,
    employmentStatus: 'active',
  }).select('_id');
  if (!teacher) {
    throw forbidden('Your teacher account is not active. Contact your school administrator.', 'TEACHER_NOT_ACTIVE');
  }
  req.teacher = teacher;
  return next();
});
