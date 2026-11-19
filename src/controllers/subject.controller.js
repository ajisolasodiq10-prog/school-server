import * as subjects from '../services/subject.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await subjects.listSubjects(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, await subjects.getSubject(req.auth, req.validated.params.id));
});

export const create = asyncHandler(async (req, res) => {
  send(res, await subjects.createSubject(req.auth, req.validated.body), 201);
});

export const update = asyncHandler(async (req, res) => {
  send(res, await subjects.updateSubject(req.auth, req.validated.params.id, req.validated.body));
});

export const activate = asyncHandler(async (req, res) => {
  send(res, await subjects.setSubjectStatus(req.auth, req.validated.params.id, 'active'));
});

export const deactivate = asyncHandler(async (req, res) => {
  send(res, await subjects.setSubjectStatus(req.auth, req.validated.params.id, 'inactive'));
});
