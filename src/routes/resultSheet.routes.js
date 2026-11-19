import { Router } from 'express';
import * as controller from '../controllers/resultSheet.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
router.use(authenticate);

const teacherOnly = requireRole('teacher');
const adminOnly = requireRole('admin');
const staff = requireRole('admin', 'teacher');
const family = requireRole('student', 'parent');
const id = { params: schemas.idParam };

// Students and parents: published results only (these paths come before /:id).
router.get('/published/terms', family, validate({ query: schemas.publishedTerms }), controller.publishedTerms);
router.get('/published/term', family, validate({ query: schemas.publishedTerm }), controller.publishedTerm);

// Teachers and administrators.
router.get('/', staff, validate({ query: schemas.listResultSheets }), controller.list);
router.put('/', teacherOnly, validate({ body: schemas.saveResultSheet }), controller.save);
router.get('/:id', staff, validate(id), controller.get);
router.post('/:id/submit', teacherOnly, validate(id), controller.submit);
router.post('/:id/approve', adminOnly, validate(id), controller.approve);
router.post('/:id/return', adminOnly, validate({ ...id, body: schemas.returnResultSheet }), controller.returnSheet);
router.post('/:id/publish', adminOnly, validate(id), controller.publish);

export default router;
