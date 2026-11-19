import { Router } from 'express';
import * as controller from '../controllers/announcement.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const id = { params: schemas.idParam };
const adminOnly = requireRole('admin');

// Everyone signed in can READ the announcements their access allows (what exactly is decided
// in the service: public, students, staff). A student whose status gives no announcements
// (inactive) is refused here; transferred and graduated students keep the public ones.
// Only administrators write.
router.use(authenticate);

router.get('/', requireStudentCapability('publicAnnouncements'), validate({ query: schemas.listAnnouncements }), controller.list);
router.post('/', adminOnly, validate({ body: schemas.createAnnouncement }), controller.create);

router.get('/:id', requireStudentCapability('publicAnnouncements'), validate(id), controller.get);
router.patch('/:id', adminOnly, validate({ ...id, body: schemas.updateAnnouncement }), controller.update);
router.post('/:id/publish', adminOnly, validate(id), controller.publish);
router.post('/:id/schedule', adminOnly, validate({ ...id, body: schemas.scheduleAnnouncement }), controller.schedule);
router.post('/:id/archive', adminOnly, validate(id), controller.archive);

export default router;
