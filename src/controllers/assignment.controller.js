import * as assignments from '../services/assignment.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => send(res, await assignments.listAssignments(req.auth, req.validated.query)));
export const get = asyncHandler(async (req, res) => send(res, { assignment: await assignments.getAssignment(req.auth, req.validated.params.id) }));
export const create = asyncHandler(async (req, res) => send(res, { assignment: await assignments.createAssignment(req.auth, req.validated.body) }, 201));
export const update = asyncHandler(async (req, res) =>
  send(res, { assignment: await assignments.updateAssignment(req.auth, req.validated.params.id, req.validated.body) })
);
export const remove = asyncHandler(async (req, res) =>
  send(res, { assignment: await assignments.removeAssignment(req.auth, req.validated.params.id, req.validated.body) })
);
export const restore = asyncHandler(async (req, res) =>
  send(res, { assignment: await assignments.restoreAssignment(req.auth, req.validated.params.id) })
);
export const deleteOwn = asyncHandler(async (req, res) => send(res, await assignments.deleteOwnAssignment(req.auth, req.validated.params.id)));
