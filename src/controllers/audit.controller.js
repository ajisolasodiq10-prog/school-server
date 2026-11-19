import { auditFacets, getAuditLog, listAuditLogs } from '../services/audit.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = asyncHandler(async (req, res) => {
  res.json({ status: 'success', data: await listAuditLogs(req.auth, req.validated.query) });
});

export const facets = asyncHandler(async (req, res) => {
  res.json({ status: 'success', data: await auditFacets(req.auth) });
});

export const get = asyncHandler(async (req, res) => {
  res.json({ status: 'success', data: { entry: await getAuditLog(req.auth, req.validated.params.id) } });
});
