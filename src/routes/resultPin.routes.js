import { Router } from 'express';
import * as controller from '../controllers/resultPin.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// PIN administration: administrators only. Teachers, students and parents get 403. There is
// deliberately no endpoint that returns an existing PIN: it is shown once, on generation.
router.use(authenticate, requireRole('admin'));

router.post('/', validate({ body: schemas.generatePin }), controller.generate);
router.post('/bulk', validate({ body: schemas.generatePinsBulk }), controller.generateBulk);
router.get('/', validate({ query: schemas.listPins }), controller.list);
router.get('/redemptions', validate({ query: schemas.listRedemptions }), controller.redemptions); // before /:id
router.get('/:id', validate({ params: schemas.idParam }), controller.get);
router.post('/:id/revoke', validate({ params: schemas.idParam, body: schemas.resultReason }), controller.revoke);

export default router;
