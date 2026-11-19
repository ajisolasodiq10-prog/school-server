import { Router } from 'express';
import * as controller from '../controllers/academicSession.controller.js';
import * as promotionController from '../controllers/promotion.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import { requireStudentCapability } from '../middleware/lifecycle.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

router.use(authenticate);

const adminOnly = requireRole('admin');
// Reads: every signed-in role, each limited to its own scope (services/access.service.js).
// A student who is not active (transferred, graduated, inactive) gets no current academics.
const readAcademics = requireStudentCapability('currentAcademics');

// ---- Reading ---------------------------------------------------------------------
// "/current" must be declared before "/:id".
router.get('/current', readAcademics, controller.current);
router.get('/', readAcademics, validate({ query: schemas.listSessions }), controller.list);
router.get('/:id', readAcademics, validate({ params: schemas.idParam }), controller.get);

// ---- Starting a new session (administrators only) -------------------------------------
// Closes the previous session, creates and activates the new one, copies the classes and
// moves students on their CONFIRMED promotion decisions - all or nothing, and safe to repeat.
// Declared before the "/:id" routes so "rollover" is never read as an id.
router.post('/rollover/preview', adminOnly, validate({ body: schemas.startNewSession }), promotionController.previewRollover);
router.post('/rollover', adminOnly, validate({ body: schemas.startNewSession }), promotionController.startSession);

// ---- Sessions (administrators only) -------------------------------------------------
router.post('/', adminOnly, validate({ body: schemas.createSession }), controller.create);
router.patch(
  '/:id',
  adminOnly,
  validate({ params: schemas.idParam, body: schemas.updateSession }),
  controller.update
);
router.post('/:id/set-current', adminOnly, validate({ params: schemas.idParam }), controller.setCurrent);
router.delete('/:id', adminOnly, validate({ params: schemas.idParam }), controller.remove);

// ---- Terms (administrators only) ----------------------------------------------------
router.post(
  '/:id/terms',
  adminOnly,
  validate({ params: schemas.idParam, body: schemas.createTerm }),
  controller.addTerm
);
router.patch(
  '/:id/terms/:termId',
  adminOnly,
  validate({ params: schemas.termParams, body: schemas.updateTerm }),
  controller.updateTerm
);
router.post(
  '/:id/terms/:termId/set-current',
  adminOnly,
  validate({ params: schemas.termParams }),
  controller.setCurrentTerm
);
router.delete(
  '/:id/terms/:termId',
  adminOnly,
  validate({ params: schemas.termParams }),
  controller.removeTerm
);

export default router;
