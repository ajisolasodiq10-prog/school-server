import * as promotion from '../services/promotion.service.js';
import * as rollover from '../services/sessionRollover.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const recommend = asyncHandler(async (req, res) => {
  send(res, { decision: await promotion.recommendPromotion(req.auth, req.validated.body) });
});

export const confirm = asyncHandler(async (req, res) => {
  send(res, { decision: await promotion.confirmPromotion(req.auth, req.validated.body) });
});

export const list = asyncHandler(async (req, res) => {
  send(res, await promotion.listDecisions(req.auth, req.validated.query));
});

// What starting the new session would do, and what stops it. Changes nothing.
export const previewRollover = asyncHandler(async (req, res) => {
  send(res, await rollover.previewRollover(req.auth, req.validated.body));
});

export const startSession = asyncHandler(async (req, res) => {
  const result = await rollover.startNewSession(req.auth, req.validated.body);
  send(res, result, result.alreadyApplied ? 200 : 201);
});
