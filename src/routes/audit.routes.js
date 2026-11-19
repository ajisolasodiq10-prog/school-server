import { Router } from 'express';
import * as controller from '../controllers/audit.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { AppError } from '../utils/AppError.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// The audit trail is read-only and for administrators only. There is no write route:
// anything other than a read is refused outright, whoever asks.
router.use(authenticate, requireRole('admin'));
router.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  res.set('Allow', 'GET, HEAD');
  return next(new AppError(405, 'Audit records are append-only and cannot be changed or deleted.', { code: 'AUDIT_READ_ONLY' }));
});

router.get('/', validate({ query: schemas.listAuditLogs }), controller.list);
router.get('/facets', controller.facets);
router.get('/:id', validate({ params: schemas.idParam }), controller.get);

export default router;
