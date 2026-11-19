import { Student } from '../models/index.js';
import { assertStudentCapability } from '../services/lifecycle.service.js';
import { forbidden } from '../utils/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Blocks a signed-in STUDENT whose status does not include `capability` (see
// services/lifecycle.service.js). Other roles pass straight through.
//   router.get('/x', authenticate, requireStudentCapability('assignments'), handler)
//
// For parents the same rule is applied to each linked child inside the service that reads
// the child's data (a parent has no student status of their own).
export const requireStudentCapability = (capability) =>
  asyncHandler(async (req, res, next) => {
    if (req.auth?.role !== 'student') return next();

    // Always read the status fresh from the database, so a transfer applies immediately.
    const student = await Student.findOne({
      schoolId: req.auth.schoolId,
      userId: req.auth.userId,
    });
    if (!student) {
      throw forbidden('No student record is linked to this account.', 'NO_STUDENT_RECORD');
    }
    assertStudentCapability(student, capability);
    req.student = student;
    return next();
  });
