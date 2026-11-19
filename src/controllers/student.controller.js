import * as accounts from '../services/account.service.js';
import * as students from '../services/student.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await students.listStudents(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, { student: await students.getStudent(req.auth, req.validated.params.id) });
});

// Registers a student (and a login account waiting for activation).
export const register = asyncHandler(async (req, res) => {
  const result = await accounts.registerStudent(req.auth, req.validated.body);
  send(res, accounts.presentRegisteredStudent(result), 201);
});

export const update = asyncHandler(async (req, res) => {
  send(res, { student: await students.updateStudent(req.auth, req.validated.params.id, req.validated.body) });
});

// What the student may currently use, according to their lifecycle status.
export const access = asyncHandler(async (req, res) => {
  send(res, await students.getStudentAccessInfo(req.auth, req.validated.params.id));
});

export const history = asyncHandler(async (req, res) => {
  send(res, await students.getStudentHistory(req.auth, req.validated.params.id));
});

export const assignClass = asyncHandler(async (req, res) => {
  send(res, { student: await students.assignStudentToClass(req.auth, req.validated.params.id, req.validated.body) });
});

export const promote = asyncHandler(async (req, res) => {
  send(res, await students.promoteStudents(req.auth, req.validated.body));
});

// Administrator action: active / inactive / graduated / transferred.
export const setStatus = asyncHandler(async (req, res) => {
  send(res, { student: await students.setStudentStatus(req.auth, req.validated.params.id, req.validated.body) });
});

export const accountStatus = asyncHandler(async (req, res) => {
  send(res, await accounts.getStudentAccountStatus(req.auth, req.validated.params.id));
});

export const activationLink = asyncHandler(async (req, res) => {
  send(res, await accounts.issueStudentActivationLink(req.auth, req.validated.params.id));
});

export const passwordResetLink = asyncHandler(async (req, res) => {
  send(res, await accounts.requestStudentPasswordReset(req.auth, req.validated.params.id, req.validated.body));
});
