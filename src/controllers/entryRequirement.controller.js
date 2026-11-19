import * as requirements from '../services/entryRequirement.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => send(res, await requirements.listVersions(req.auth, req.validated.query)));
export const get = asyncHandler(async (req, res) => send(res, await requirements.getVersion(req.auth, req.validated.params.id)));
export const createDraft = asyncHandler(async (req, res) => send(res, await requirements.createDraft(req.auth, req.validated.body), 201));
export const newVersion = asyncHandler(async (req, res) => send(res, await requirements.createVersionFrom(req.auth, req.validated.params.id), 201));
export const updateDraft = asyncHandler(async (req, res) =>
  send(res, await requirements.updateDraft(req.auth, req.validated.params.id, req.validated.body))
);
export const publish = asyncHandler(async (req, res) =>
  send(res, await requirements.publishVersion(req.auth, req.validated.params.id, req.validated.body))
);
export const archive = asyncHandler(async (req, res) =>
  send(res, await requirements.archiveVersion(req.auth, req.validated.params.id, req.validated.body))
);
