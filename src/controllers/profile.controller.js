import * as profile from '../services/profile.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const get = asyncHandler(async (req, res) => send(res, { profile: await profile.getMyProfile(req.auth) }));
export const update = asyncHandler(async (req, res) => send(res, { profile: await profile.updateMyProfile(req.auth, req.validated.body) }));
