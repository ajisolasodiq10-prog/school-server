import * as classes from '../services/class.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// The class service already returns { class } (or a paged list), so it is sent as it is.
const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await classes.listClasses(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, await classes.getClass(req.auth, req.validated.params.id));
});

export const create = asyncHandler(async (req, res) => {
  send(res, await classes.createClass(req.auth, req.validated.body), 201);
});

export const update = asyncHandler(async (req, res) => {
  send(res, await classes.updateClass(req.auth, req.validated.params.id, req.validated.body));
});

export const activate = asyncHandler(async (req, res) => {
  send(res, await classes.setClassStatus(req.auth, req.validated.params.id, 'active'));
});

export const deactivate = asyncHandler(async (req, res) => {
  send(res, await classes.setClassStatus(req.auth, req.validated.params.id, 'inactive'));
});

export const setSubjects = asyncHandler(async (req, res) => {
  const { subjectIds } = req.validated.body;
  send(res, await classes.setClassSubjects(req.auth, req.validated.params.id, subjectIds));
});

export const setSubjectTeacher = asyncHandler(async (req, res) => {
  const { id, subjectId } = req.validated.params;
  send(res, await classes.setSubjectTeacher(req.auth, id, subjectId, req.validated.body.teacherId));
});

export const clearSubjectTeacher = asyncHandler(async (req, res) => {
  const { id, subjectId } = req.validated.params;
  send(res, await classes.clearSubjectTeacher(req.auth, id, subjectId));
});
