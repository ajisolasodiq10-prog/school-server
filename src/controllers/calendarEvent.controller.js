import * as events from '../services/calendarEvent.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => send(res, await events.listEvents(req.auth, req.validated.query)));
export const create = asyncHandler(async (req, res) => send(res, { event: await events.createEvent(req.auth, req.validated.body) }, 201));
export const update = asyncHandler(async (req, res) => send(res, { event: await events.updateEvent(req.auth, req.validated.params.id, req.validated.body) }));
export const remove = asyncHandler(async (req, res) => send(res, await events.deleteEvent(req.auth, req.validated.params.id)));
