import { Router } from 'express';
import * as controller from '../controllers/parent.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { noStore } from '../middleware/noStore.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Parent accounts are created and linked by administrators only; there is no self-registration.
// A parent sees a student only while that student's record links to the parent's account.
router.use(authenticate, requireRole('admin'));

router.get('/', validate({ query: schemas.listParents }), controller.list);
router.post('/', noStore, validate({ body: schemas.createParent }), controller.create);
router.get('/:id', validate({ params: schemas.idParam }), controller.get);

// One child at a time (PUT /api/accounts/:id/linked-students replaces the whole list).
router.post('/:id/students/:studentId', validate({ params: schemas.parentStudentParams }), controller.link);
router.delete('/:id/students/:studentId', validate({ params: schemas.parentStudentParams }), controller.unlink);

export default router;
