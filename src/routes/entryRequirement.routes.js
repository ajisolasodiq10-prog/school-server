import { Router } from 'express';
import * as controller from '../controllers/entryRequirement.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { requireRole } from '../middleware/authorize.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();
const id = { params: schemas.idParam };

// The school's admission POLICY, with its full version history. Administrators only; the public
// website reads the current published version from /api/public/entry-requirements instead.
router.use(authenticate, requireRole('admin'));

router.get('/', validate({ query: schemas.listRequirements }), controller.list);
router.post('/', validate({ body: schemas.createRequirementDraft }), controller.createDraft);

router.get('/:id', validate(id), controller.get);
router.patch('/:id', validate({ ...id, body: schemas.updateRequirementDraft }), controller.updateDraft);
router.post('/:id/new-version', validate(id), controller.newVersion);
router.post('/:id/publish', validate({ ...id, body: schemas.publishRequirement }), controller.publish);
router.post('/:id/archive', validate({ ...id, body: schemas.archiveRequirement }), controller.archive);

export default router;
