import * as notifications from '../services/notification.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data) => res.json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => send(res, await notifications.listNotifications(req.auth, req.validated.query)));
export const read = asyncHandler(async (req, res) => send(res, { notification: await notifications.markRead(req.auth, req.validated.params.id) }));
export const readAll = asyncHandler(async (req, res) => send(res, await notifications.markAllRead(req.auth)));
