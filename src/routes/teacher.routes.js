import { Router } from 'express';
import * as controller from '../controllers/teacher.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { noStore } from '../middleware/noStore.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Managing teachers is for school administrators only. Teachers, students and parents get 403.
// Nothing here deletes a teacher: leaving or deactivation only changes status.
router.use(authenticate, requireRole('admin'));

router.get('/', validate({ query: schemas.listTeachers }), controller.list);
router.post('/', noStore, validate({ body: schemas.createTeacher }), controller.register);
router.get('/:id', validate({ params: schemas.idParam }), controller.get);
// Live account status from the account service. (Teachers' forgotten passwords are handled
// entirely by the account service by email; there is deliberately no reset route here.)
router.get('/:id/account-status', validate({ params: schemas.idParam }), controller.accountStatus);
router.patch('/:id', validate({ params: schemas.idParam, body: schemas.updateTeacher }), controller.update);

// The classes and subjects the teacher teaches (send either list or both).
router.put('/:id/assignments', validate({ params: schemas.idParam, body: schemas.setTeacherAssignments }), controller.setAssignments);

// active / on_leave / inactive / resigned / retired. Closes or reopens the login to match.
router.post('/:id/employment-status', validate({ params: schemas.idParam, body: schemas.setEmploymentStatus }), controller.setEmploymentStatus);
router.post('/:id/deactivate', validate({ params: schemas.idParam }), controller.deactivate);
router.post('/:id/reactivate', validate({ params: schemas.idParam }), controller.reactivate);

export default router;
