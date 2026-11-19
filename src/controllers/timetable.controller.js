import * as timetables from '../services/timetable.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const get = asyncHandler(async (req, res) => send(res, { timetable: await timetables.getTimetable(req.auth, req.validated.params.classId) }));
export const save = asyncHandler(async (req, res) =>
  send(res, { timetable: await timetables.saveTimetable(req.auth, req.validated.params.classId, req.validated.body) })
);
