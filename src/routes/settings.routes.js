import { Router } from 'express';
import * as controller from '../controllers/settings.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// Everyone signed in reads the settings (score maximums and grade boundaries); only
// administrators change them.
router.use(authenticate);
router.get('/', controller.get);
router.put('/', requireRole('admin'), validate({ body: schemas.saveSettings }), controller.save);
router.delete('/', requireRole('admin'), controller.reset);

export default router;
