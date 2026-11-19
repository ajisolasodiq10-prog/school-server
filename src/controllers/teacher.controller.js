import * as accounts from '../services/account.service.js';
import * as teachers from '../services/teacher.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await teachers.listTeachers(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, { teacher: await teachers.getTeacher(req.auth, req.validated.params.id) });
});

// Registers a teacher together with their login account.
export const register = asyncHandler(async (req, res) => {
  send(res, await accounts.createTeacherAccount(req.auth, req.validated.body), 201);
});

export const update = asyncHandler(async (req, res) => {
  send(res, { teacher: await teachers.updateTeacher(req.auth, req.validated.params.id, req.validated.body) });
});

export const setAssignments = asyncHandler(async (req, res) => {
  send(res, { teacher: await teachers.setTeacherAssignments(req.auth, req.validated.params.id, req.validated.body) });
});

export const setEmploymentStatus = asyncHandler(async (req, res) => {
  const { employmentStatus } = req.validated.body;
  send(res, { teacher: await teachers.setTeacherEmploymentStatus(req.auth, req.validated.params.id, employmentStatus) });
});

export const deactivate = asyncHandler(async (req, res) => {
  send(res, { teacher: await teachers.deactivateTeacher(req.auth, req.validated.params.id) });
});

export const reactivate = asyncHandler(async (req, res) => {
  send(res, { teacher: await teachers.reactivateTeacher(req.auth, req.validated.params.id) });
});

export const accountStatus = asyncHandler(async (req, res) => {
  send(res, await accounts.getTeacherAccountStatus(req.auth, req.validated.params.id));
});
