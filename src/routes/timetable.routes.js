import { Router } from 'express';
import * as controller from '../controllers/timetable.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const cls = { params: schemas.classIdParam };

// Read: the timetable of a class the person can see. Write: administrators only.
router.use(authenticate);
router.get('/:classId', requireStudentCapability('currentAcademics'), validate(cls), controller.get);
router.put('/:classId', requireRole('admin'), validate({ ...cls, body: schemas.saveTimetable }), controller.save);

export default router;
