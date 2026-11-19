import * as sheets from '../services/resultSheet.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
// Results of a student are personal: never cached by a browser or proxy.
const sendPrivate = (res, data, status = 200) => {
  res.set('Cache-Control', 'no-store');
  return send(res, data, status);
};

export const list = asyncHandler(async (req, res) => send(res, await sheets.listSheets(req.auth, req.validated.query)));
export const get = asyncHandler(async (req, res) => send(res, await sheets.getSheet(req.auth, req.validated.params.id)));
export const save = asyncHandler(async (req, res) => send(res, await sheets.saveSheet(req.auth, req.validated.body)));
export const submit = asyncHandler(async (req, res) => send(res, await sheets.submitSheet(req.auth, req.validated.params.id)));
export const approve = asyncHandler(async (req, res) => send(res, await sheets.approveSheet(req.auth, req.validated.params.id)));
export const returnSheet = asyncHandler(async (req, res) =>
  send(res, await sheets.returnSheet(req.auth, req.validated.params.id, req.validated.body))
);
export const publish = asyncHandler(async (req, res) => send(res, await sheets.publishSheet(req.auth, req.validated.params.id)));
export const publishedTerms = asyncHandler(async (req, res) => sendPrivate(res, await sheets.listPublishedTerms(req.auth, req.validated.query)));
export const publishedTerm = asyncHandler(async (req, res) => sendPrivate(res, await sheets.getPublishedTerm(req.auth, req.validated.query)));
