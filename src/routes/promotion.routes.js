import { Router } from 'express';
import * as controller from '../controllers/promotion.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Students and parents have no access here at all. Nothing in this file changes a student's
// class: that happens only when an administrator starts a new session.
router.use(authenticate);

router.get('/', requireRole('admin', 'teacher'), validate({ query: schemas.listPromotionDecisions }), controller.list);
// A teacher recommends...
router.put('/recommendation', requireRole('teacher'), validate({ body: schemas.recommendPromotion }), controller.recommend);
// ...an administrator confirms (or decides differently).
router.put('/confirmation', requireRole('admin'), validate({ body: schemas.confirmPromotion }), controller.confirm);

export default router;
