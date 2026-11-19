import * as accounts from '../services/account.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await accounts.listAccounts(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, await accounts.getAccount(req.auth, req.validated.params.id));
});

export const createTeacher = asyncHandler(async (req, res) => {
  send(res, await accounts.createTeacherAccount(req.auth, req.validated.body), 201);
});

export const createStudent = asyncHandler(async (req, res) => {
  send(res, await accounts.createStudentAccount(req.auth, req.validated.body), 201);
});

export const createAccountForStudent = asyncHandler(async (req, res) => {
  const { studentRecordId } = req.validated.params;
  send(res, await accounts.createAccountForStudent(req.auth, studentRecordId, req.validated.body), 201);
});

export const createParent = asyncHandler(async (req, res) => {
  send(res, await accounts.createParentAccount(req.auth, req.validated.body), 201);
});

export const update = asyncHandler(async (req, res) => {
  send(res, await accounts.updateAccount(req.auth, req.validated.params.id, req.validated.body));
});

export const linkStudents = asyncHandler(async (req, res) => {
  const { studentIds } = req.validated.body;
  send(res, await accounts.setLinkedStudents(req.auth, req.validated.params.id, studentIds));
});

export const activate = asyncHandler(async (req, res) => {
  send(res, await accounts.setAccountStatus(req.auth, req.validated.params.id, 'active', req.validated.body));
});

export const deactivate = asyncHandler(async (req, res) => {
  send(res, await accounts.setAccountStatus(req.auth, req.validated.params.id, 'deactivated', req.validated.body));
});

export const suspend = asyncHandler(async (req, res) => {
  send(res, await accounts.setAccountStatus(req.auth, req.validated.params.id, 'suspended', req.validated.body));
});
