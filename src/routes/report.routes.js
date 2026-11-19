import { Router } from 'express';
import * as controller from '../controllers/report.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { reportExportLimiter } from '../middleware/rateLimiter.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Reports are for school administrators only, and read-only (no write routes exist).
router.use(authenticate, requireRole('admin'));

router.get('/', controller.list);
router.get('/:key', validate({ params: schemas.reportKeyParam, query: schemas.runReport }), controller.run);
router.get('/:key/export', reportExportLimiter, validate({ params: schemas.reportKeyParam, query: schemas.exportReport }), controller.download);

export default router;
