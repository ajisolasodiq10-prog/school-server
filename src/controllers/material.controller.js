import * as materials from '../services/material.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const send = (res, data, status = 200) => res.status(status).json({ status: 'success', data });

export const list = asyncHandler(async (req, res) => send(res, await materials.listMaterials(req.auth, req.validated.query)));
export const create = asyncHandler(async (req, res) => send(res, { material: await materials.createMaterial(req.auth, req.validated.body) }, 201));
export const update = asyncHandler(async (req, res) =>
  send(res, { material: await materials.updateMaterial(req.auth, req.validated.params.id, req.validated.body) })
);
export const remove = asyncHandler(async (req, res) => send(res, await materials.removeMaterial(req.auth, req.validated.params.id)));
