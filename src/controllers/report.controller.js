import { exportReport, listReports, runReport } from '../services/reports/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const list = (req, res) => {
  res.json({ status: 'success', data: { reports: listReports() } });
};

export const run = asyncHandler(async (req, res) => {
  const report = await runReport(req.auth, req.validated.params.key, req.validated.query);
  res.json({ status: 'success', data: { report } });
});

export const download = asyncHandler(async (req, res) => {
  const { format, ...filters } = req.validated.query;
  const file = await exportReport(req.auth, req.validated.params.key, filters, format);
  res.set({
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'Content-Length': String(file.body.length),
  });
  res.send(file.body);
});
