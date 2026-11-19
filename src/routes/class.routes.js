import { Router } from 'express';
import * as controller from '../controllers/class.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

router.use(authenticate);

const adminOnly = requireRole('admin');
// Reads: admins see every class in their school, teachers the classes assigned to them,
// students and parents the class of an ACTIVE student. A student who is no longer active
// is refused (STUDENT_STATUS_RESTRICTED).
const readClasses = requireStudentCapability('currentAcademics');

router.get('/', readClasses, validate({ query: schemas.listClasses }), controller.list);
router.get('/:id', readClasses, validate({ params: schemas.idParam }), controller.get);

// Management: administrators only.
router.post('/', adminOnly, validate({ body: schemas.createClass }), controller.create);
router.patch(
  '/:id',
  adminOnly,
  validate({ params: schemas.idParam, body: schemas.updateClass }),
  controller.update
);
router.post('/:id/activate', adminOnly, validate({ params: schemas.idParam }), controller.activate);
router.post('/:id/deactivate', adminOnly, validate({ params: schemas.idParam }), controller.deactivate);
router.put(
  '/:id/subjects',
  adminOnly,
  validate({ params: schemas.idParam, body: schemas.setClassSubjects }),
  controller.setSubjects
);

router.put(
  '/:id/subject-teachers/:subjectId',
  adminOnly,
  validate({ params: schemas.classSubjectParams, body: schemas.setClassSubjectTeacher }),
  controller.setSubjectTeacher
);
router.delete(
  '/:id/subject-teachers/:subjectId',
  adminOnly,
  validate({ params: schemas.classSubjectParams }),
  controller.clearSubjectTeacher
);

export default router;
