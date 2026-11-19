import { Router } from 'express';
import * as controller from '../controllers/profile.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// A signed-in administrator or teacher reads and edits their own profile details.
router.use(authenticate, requireRole('admin', 'teacher'));
router.get('/me', controller.get);
router.patch('/me', validate({ body: schemas.updateMyProfile }), controller.update);

export default router;
