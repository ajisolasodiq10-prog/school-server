import { Router } from 'express';
import * as controller from '../controllers/notification.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Your own in-app notifications only (what you may read is decided by your role and, for
// students, by the student lifecycle policy: see notification.service).
router.use(authenticate);

router.get('/', validate({ query: schemas.listNotifications }), controller.list);
router.post('/read-all', controller.readAll);
router.post('/:id/read', validate({ params: schemas.idParam }), controller.read);

export default router;
