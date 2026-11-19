import * as settings from '../services/settings.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const get = asyncHandler(async (req, res) => send(res, { settings: await settings.getSettings(req.auth.schoolId) }));
export const save = asyncHandler(async (req, res) => send(res, { settings: await settings.saveSettings(req.auth, req.validated.body) }));
export const reset = asyncHandler(async (req, res) => send(res, { settings: await settings.resetSettings(req.auth) }));
