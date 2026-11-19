import { Router } from 'express';
import * as controller from '../controllers/result.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const teacherOnly = requireRole('teacher');
const adminOnly = requireRole('admin');
const staff = requireRole('admin', 'teacher');
const id = { params: schemas.idParam };

// Workflow foundation: Draft -> Submitted -> Approved -> Published, recall and correction.
// Teachers write and submit; only administrators return, approve, publish and recall.
// Students and parents can only read published results (a student whose status does not
// allow results is refused by requireStudentCapability).
router.use(authenticate);

router.get('/', requireStudentCapability('results'), validate({ query: schemas.listResults }), controller.list);
router.put('/', teacherOnly, validate({ body: schemas.saveResult }), controller.saveDraft);

router.get('/:id', requireStudentCapability('results'), validate(id), controller.get);
router.get('/:id/versions', staff, validate(id), controller.versions);

router.post('/:id/submit', teacherOnly, validate(id), controller.submit);
router.post('/:id/corrections', teacherOnly, validate(id), controller.startCorrection);

router.post('/:id/return', adminOnly, validate({ ...id, body: schemas.resultReason }), controller.returnToDraft);
router.post('/:id/approve', adminOnly, validate(id), controller.approve);
router.post('/:id/publish', adminOnly, validate(id), controller.publish);
router.post('/:id/recall', adminOnly, validate({ ...id, body: schemas.resultReason }), controller.recall);

export default router;
