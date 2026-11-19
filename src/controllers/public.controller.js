import { getPublicAnnouncement, listPublicAnnouncements } from '../services/announcement.service.js';
import { getPublicRequirements } from '../services/entryRequirement.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data) => res.json({ status: 'success', data });

export const announcements = asyncHandler(async (req, res) => send(res, await listPublicAnnouncements(req.validated.query)));
export const announcement = asyncHandler(async (req, res) =>
  send(res, await getPublicAnnouncement(req.validated.query, req.validated.params.id))
);
export const entryRequirements = asyncHandler(async (req, res) => send(res, await getPublicRequirements(req.validated.query)));
