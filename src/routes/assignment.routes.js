import { Router } from 'express';
import * as controller from '../controllers/assignment.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const id = { params: schemas.idParam };
const readAssignments = requireStudentCapability('assignments'); // transferred, graduated and inactive students: 403

// Teachers set and manage their OWN assignments (only for their classes and subjects, checked
// in the service). Administrators see everything in the school, may edit, and may remove an
// inappropriate one. Students and parents only read: the assignments of the student's current
// class. Nothing is ever deleted.
router.use(authenticate);

router.get('/', readAssignments, validate({ query: schemas.listAssignments }), controller.list);
router.post('/', requireRole('teacher'), validate({ body: schemas.createAssignment }), controller.create);

router.get('/:id', readAssignments, validate(id), controller.get);
router.patch('/:id', requireRole('teacher', 'admin'), validate({ ...id, body: schemas.updateAssignment }), controller.update);

router.delete('/:id', requireRole('teacher'), validate(id), controller.deleteOwn);
router.post('/:id/remove', requireRole('admin'), validate({ ...id, body: schemas.resultReason }), controller.remove);
router.post('/:id/restore', requireRole('admin'), validate(id), controller.restore);

export default router;
