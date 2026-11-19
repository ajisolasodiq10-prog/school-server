import { Router } from 'express';
import * as controller from '../controllers/material.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const id = { params: schemas.idParam };

// Teachers add and manage their OWN materials (only for their classes and subjects, checked in
// the service). Administrators see everything and may remove one. Students and parents read the
// materials of the student's current class.
router.use(authenticate);
router.get('/', requireStudentCapability('learningMaterials'), validate({ query: schemas.listMaterials }), controller.list);
router.post('/', requireRole('teacher'), validate({ body: schemas.createMaterial }), controller.create);
router.patch('/:id', requireRole('teacher', 'admin'), validate({ ...id, body: schemas.updateMaterial }), controller.update);
router.delete('/:id', requireRole('teacher', 'admin'), validate(id), controller.remove);

export default router;
