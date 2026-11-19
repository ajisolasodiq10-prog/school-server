import { Router } from 'express';
import * as controller from '../controllers/account.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { noStore } from '../middleware/noStore.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Everything under /api/accounts is for school administrators only.
router.use(authenticate, requireRole('admin'), noStore);

router.get('/', validate({ query: schemas.listAccounts }), controller.list);

// Creating accounts. There is intentionally no route that creates administrators.
router.post('/teachers', validate({ body: schemas.createTeacher }), controller.createTeacher);
router.post('/students', validate({ body: schemas.createStudent }), controller.createStudent);
router.post(
  '/students/:studentRecordId/account',
  validate({ params: schemas.createStudentAccountParams, body: schemas.createStudentAccountBody }),
  controller.createAccountForStudent
);
router.post('/parents', validate({ body: schemas.createParent }), controller.createParent);

router.get('/:id', validate({ params: schemas.idParam }), controller.get);
router.patch(
  '/:id',
  validate({ params: schemas.idParam, body: schemas.updateAccount }),
  controller.update
);
router.put(
  '/:id/linked-students',
  validate({ params: schemas.idParam, body: schemas.linkStudents }),
  controller.linkStudents
);
// Access changes are made at the account service first, then mirrored here. A reason is optional.
router.post('/:id/activate', validate({ params: schemas.idParam, body: schemas.accountStatusReason }), controller.activate);
router.post('/:id/deactivate', validate({ params: schemas.idParam, body: schemas.accountStatusReason }), controller.deactivate);
router.post('/:id/suspend', validate({ params: schemas.idParam, body: schemas.accountStatusReason }), controller.suspend);

export default router;
