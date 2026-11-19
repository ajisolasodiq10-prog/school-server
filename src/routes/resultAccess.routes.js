import { Router } from 'express';
import * as controller from '../controllers/resultPin.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { pinIpLimiter, pinStudentLimiter, pinUserLimiter } from '../middleware/rateLimiter.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Students and linked parents only. Which students a person may act for is decided in the
// service from their own account, never from the request.
router.use(authenticate, requireRole('student', 'parent'));

router.get('/', validate({ query: schemas.listResultAccess }), controller.access);
router.post('/redeem', validate({ body: schemas.redeemPin }), pinUserLimiter, pinStudentLimiter, pinIpLimiter, controller.redeem);

export default router;
