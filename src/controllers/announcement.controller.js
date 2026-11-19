import * as announcements from '../services/announcement.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => send(res, await announcements.listAnnouncements(req.auth, req.validated.query)));
export const get = asyncHandler(async (req, res) => send(res, await announcements.getAnnouncement(req.auth, req.validated.params.id)));
export const create = asyncHandler(async (req, res) => send(res, await announcements.createAnnouncement(req.auth, req.validated.body), 201));
export const update = asyncHandler(async (req, res) =>
  send(res, await announcements.updateAnnouncement(req.auth, req.validated.params.id, req.validated.body))
);
export const publish = asyncHandler(async (req, res) => send(res, await announcements.publishAnnouncement(req.auth, req.validated.params.id)));
export const schedule = asyncHandler(async (req, res) =>
  send(res, await announcements.scheduleAnnouncement(req.auth, req.validated.params.id, req.validated.body))
);
export const archive = asyncHandler(async (req, res) => send(res, await announcements.archiveAnnouncement(req.auth, req.validated.params.id)));
