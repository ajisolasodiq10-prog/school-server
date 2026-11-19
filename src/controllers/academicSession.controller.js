import * as sessions from '../services/academicSession.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await sessions.listSessions(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, await sessions.getSession(req.auth, req.validated.params.id));
});

export const current = asyncHandler(async (req, res) => {
  send(res, await sessions.getCurrent(req.auth));
});

export const create = asyncHandler(async (req, res) => {
  send(res, await sessions.createSession(req.auth, req.validated.body), 201);
});

export const update = asyncHandler(async (req, res) => {
  send(res, await sessions.updateSession(req.auth, req.validated.params.id, req.validated.body));
});

export const setCurrent = asyncHandler(async (req, res) => {
  send(res, await sessions.setCurrentSession(req.auth, req.validated.params.id));
});

export const remove = asyncHandler(async (req, res) => {
  await sessions.deleteSession(req.auth, req.validated.params.id);
  res.json({ status: 'success', message: 'Academic session deleted.' });
});

export const addTerm = asyncHandler(async (req, res) => {
  send(res, await sessions.addTerm(req.auth, req.validated.params.id, req.validated.body), 201);
});

export const updateTerm = asyncHandler(async (req, res) => {
  const { id, termId } = req.validated.params;
  send(res, await sessions.updateTerm(req.auth, id, termId, req.validated.body));
});

export const setCurrentTerm = asyncHandler(async (req, res) => {
  const { id, termId } = req.validated.params;
  send(res, await sessions.setCurrentTerm(req.auth, id, termId));
});

export const removeTerm = asyncHandler(async (req, res) => {
  const { id, termId } = req.validated.params;
  send(res, await sessions.deleteTerm(req.auth, id, termId));
});
