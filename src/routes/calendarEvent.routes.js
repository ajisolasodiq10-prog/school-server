import { Router } from 'express';
import * as controller from '../controllers/calendarEvent.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const id = { params: schemas.idParam };
const adminOnly = requireRole('admin');

// Everyone signed in reads the school calendar; only administrators change it.
router.use(authenticate);
router.get('/', validate({ query: schemas.listCalendarEvents }), controller.list);
router.post('/', adminOnly, validate({ body: schemas.createCalendarEvent }), controller.create);
router.patch('/:id', adminOnly, validate({ ...id, body: schemas.updateCalendarEvent }), controller.update);
router.delete('/:id', adminOnly, validate(id), controller.remove);

export default router;
