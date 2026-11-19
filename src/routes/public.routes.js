import { Router } from 'express';
import * as controller from '../controllers/public.controller.js';
import { publicReadLimiter } from '../middleware/rateLimiter.js';
import * as schemas from '../utils/schemas.js';
import { validate } from '../utils/validate.js';

const router = Router();

// The public website: no sign-in. Only information meant for the public is ever returned
// (public announcements that are live now, and the current published entry requirements).
// The school is named by ?schoolCode= (or DEFAULT_SCHOOL_CODE on a single-school install).
router.use(publicReadLimiter);

router.get('/announcements', validate({ query: schemas.publicQuery }), controller.announcements);
router.get('/announcements/:id', validate({ params: schemas.idParam, query: schemas.publicSchool }), controller.announcement);
router.get('/entry-requirements', validate({ query: schemas.publicSchool }), controller.entryRequirements);

export default router;
