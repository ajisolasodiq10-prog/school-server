import { Router } from 'express';
import * as controller from '../controllers/student.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { noStore } from '../middleware/noStore.js';
import { accountLinkLimiter } from '../middleware/rateLimiter.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const adminOnly = requireRole('admin');

// Any signed-in role may call the READ routes, but each role only ever sees its own scope
// (see services/access.service.js): admins their school, teachers their classes, students
// themselves, parents their linked children. A student's own profile stays readable whatever
// their lifecycle status (active, transferred, graduated, inactive).
router.use(authenticate);

router.get('/', validate({ query: schemas.listStudents }), controller.list);

// Administrators only from here on. Nothing below ever deletes a student.
router.post('/', adminOnly, noStore, validate({ body: schemas.registerStudent }), controller.register);

// The student's login account lives at the account service. These routes ask it, as the school.
// GET    /:id/account-status         live account status (pending_activation | active | deactivated | suspended)
// POST   /:id/activation-link        a new activation link (only while the account is pending_activation)
// POST   /:id/password-reset-link    admin-assisted reset for a student who forgot the password
router.get('/:id/account-status', adminOnly, noStore, validate({ params: schemas.idParam }), controller.accountStatus);
router.post('/:id/activation-link', adminOnly, noStore, accountLinkLimiter, validate({ params: schemas.idParam }), controller.activationLink);
router.post(
  '/:id/password-reset-link',
  adminOnly,
  noStore,
  accountLinkLimiter,
  validate({ params: schemas.idParam, body: schemas.requestStudentReset }),
  controller.passwordResetLink
);
// Declared before "/:id" routes so "promote" is never read as an id.
router.post('/promote', adminOnly, validate({ body: schemas.promoteStudents }), controller.promote);

router.get('/:id', validate({ params: schemas.idParam }), controller.get);
router.patch('/:id', adminOnly, validate({ params: schemas.idParam, body: schemas.updateStudent }), controller.update);

// What this student may currently use (see services/lifecycle.service.js).
router.get('/:id/access', validate({ params: schemas.idParam }), controller.access);
// Admission, every class the student has been in, and when/how they left.
router.get('/:id/history', validate({ params: schemas.idParam }), controller.history);

router.put('/:id/class', adminOnly, validate({ params: schemas.idParam, body: schemas.assignStudentClass }), controller.assignClass);
// active / inactive / graduated / transferred, with the effective date. Nothing is deleted:
// the account, class history and results all stay.
router.post('/:id/status', adminOnly, validate({ params: schemas.idParam, body: schemas.setStudentStatus }), controller.setStatus);

export default router;
