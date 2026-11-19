import * as results from '../services/result.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
const idParam = (req) => req.validated.params.id;

export const list = asyncHandler(async (req, res) => send(res, await results.listResults(req.auth, req.validated.query)));
export const get = asyncHandler(async (req, res) => send(res, { result: await results.getResult(req.auth, idParam(req)) }));
export const versions = asyncHandler(async (req, res) => send(res, await results.getVersions(req.auth, idParam(req))));
export const saveDraft = asyncHandler(async (req, res) => send(res, { result: await results.saveDraft(req.auth, req.validated.body) }));
export const submit = asyncHandler(async (req, res) => send(res, { result: await results.submitResult(req.auth, idParam(req)) }));
export const startCorrection = asyncHandler(async (req, res) => send(res, { result: await results.startCorrection(req.auth, idParam(req)) }, 201));
export const returnToDraft = asyncHandler(async (req, res) => send(res, { result: await results.returnResult(req.auth, idParam(req), req.validated.body) }));
export const approve = asyncHandler(async (req, res) => send(res, { result: await results.approveResult(req.auth, idParam(req)) }));
export const publish = asyncHandler(async (req, res) => send(res, { result: await results.publishResult(req.auth, idParam(req)) }));
export const recall = asyncHandler(async (req, res) => send(res, { result: await results.recallResult(req.auth, idParam(req), req.validated.body) }));
