import { Router } from 'express';
import * as controller from '../controllers/subject.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

router.use(authenticate);

const adminOnly = requireRole('admin');
// Reads: admins every subject, teachers the subjects they teach, students and parents the
// subjects of the class of an ACTIVE student.
const readSubjects = requireStudentCapability('currentAcademics');

router.get('/', readSubjects, validate({ query: schemas.listSubjects }), controller.list);
router.get('/:id', readSubjects, validate({ params: schemas.idParam }), controller.get);

// Management: administrators only. Subjects are deactivated, never deleted.
router.post('/', adminOnly, validate({ body: schemas.createSubject }), controller.create);
router.patch(
  '/:id',
  adminOnly,
  validate({ params: schemas.idParam, body: schemas.updateSubject }),
  controller.update
);
router.post('/:id/activate', adminOnly, validate({ params: schemas.idParam }), controller.activate);
router.post('/:id/deactivate', adminOnly, validate({ params: schemas.idParam }), controller.deactivate);

export default router;
