import * as accounts from '../services/account.service.js';
import * as parents from '../services/parent.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => {
  send(res, await parents.listParents(req.auth, req.validated.query));
});

export const get = asyncHandler(async (req, res) => {
  send(res, await parents.getParent(req.auth, req.validated.params.id));
});

// Creates a parent account, optionally linked to children. There is no public sign-up.
export const create = asyncHandler(async (req, res) => {
  send(res, await accounts.createParentAccount(req.auth, req.validated.body), 201);
});

export const link = asyncHandler(async (req, res) => {
  const { id, studentId } = req.validated.params;
  send(res, await parents.linkStudent(req.auth, id, studentId));
});

export const unlink = asyncHandler(async (req, res) => {
  const { id, studentId } = req.validated.params;
  send(res, await parents.unlinkStudent(req.auth, id, studentId));
});
