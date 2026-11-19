import { Router } from 'express';
import * as controller from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/authenticate.js';

const router = Router();

// Signing in and out is done at the Account Management Backend, which issues the token.
// The old endpoints answer 410 Gone with a code the frontend can recognise while it is switched over.
router.post('/login', controller.moved);
router.post('/logout', controller.moved);

// GET /api/auth/me       (Authorization: Bearer <token issued by the account service>)
router.get('/me', authenticate, controller.me);

export default router;
