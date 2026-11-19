import * as pins from '../services/resultPin.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });
// A response that carries a PIN (or an unlock) must never be stored by a browser or proxy.
const sendPrivate = (res, data, status = 200) => {
  res.set('Cache-Control', 'no-store');
  return send(res, data, status);
};

export const generate = asyncHandler(async (req, res) => sendPrivate(res, await pins.generatePin(req.auth, req.validated.body), 201));
export const generateBulk = asyncHandler(async (req, res) => sendPrivate(res, await pins.generateBulk(req.auth, req.validated.body), 201));
export const list = asyncHandler(async (req, res) => send(res, await pins.listPins(req.auth, req.validated.query)));
export const get = asyncHandler(async (req, res) => send(res, { pin: await pins.getPin(req.auth, req.validated.params.id) }));
export const revoke = asyncHandler(async (req, res) =>
  send(res, { pin: await pins.revokePin(req.auth, req.validated.params.id, req.validated.body) })
);
export const redemptions = asyncHandler(async (req, res) => send(res, await pins.listRedemptions(req.auth, req.validated.query)));

export const redeem = asyncHandler(async (req, res) => sendPrivate(res, await pins.redeemPin(req.auth, req.validated.body)));
export const access = asyncHandler(async (req, res) => sendPrivate(res, await pins.listResultAccess(req.auth, req.validated.query)));
