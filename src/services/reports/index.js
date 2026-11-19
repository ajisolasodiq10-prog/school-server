import { notFound } from '../../utils/AppError.js';
import { recordAudit } from '../audit.service.js';
import { reportToCsv } from '../../utils/csv.js';
import { reportToPdf } from '../../utils/pdf.js';
import { awaitingPromotionReport, distributionReport, enrolmentReport, populationReport, promotionReport, sessionsReport } from './academic.js';
import { resolveFilters } from './common.js';
import { announcementsReport, assignmentsReport, pinsReport } from './operational.js';
import { resultsReport } from './results.js';
import { newStudentsReport, studentsReport } from './students.js';
import { teachersReport } from './teachers.js';

// The report catalogue. Every report is admin-only (see routes/report.routes.js), works for the
// administrator's own school and accepts only the filters listed here: any other filter is
// refused rather than silently ignored.
const GROUPS = {
  students: ['students', 'new-students'],
  teachers: ['teachers'],
  academic: ['enrolment', 'population', 'distribution', 'promotion', 'awaiting-promotion', 'sessions'],
  results: ['results'],
  operational: ['assignments', 'announcements', 'pins'],
};
const DEFINITIONS = [studentsReport, newStudentsReport, teachersReport, enrolmentReport, populationReport, distributionReport, promotionReport, awaitingPromotionReport, sessionsReport, resultsReport, assignmentsReport, announcementsReport, pinsReport];
const registry = new Map(DEFINITIONS.map((d) => [d.key, d]));
const groupOf = (key) => Object.entries(GROUPS).find(([, keys]) => keys.includes(key))?.[0];

export const REPORT_KEYS = DEFINITIONS.map((d) => d.key);

export function listReports() {
  return DEFINITIONS.map((d) => ({
    key: d.key,
    group: groupOf(d.key),
    title: d.title,
    description: d.description,
    filters: d.filters,
    ...(d.statuses && { statuses: d.statuses }),
    paginated: Boolean(d.paged),
    exports: ['csv', 'pdf'],
  }));
}

const definitionFor = (key) => {
  const def = registry.get(key);
  if (!def) throw notFound('Report not found.');
  return def;
};

async function build(auth, def, query, paging) {
  const f = await resolveFilters(auth, def, query);
  const { totals, sections } = await def.run({ auth, f, paging });
  return { key: def.key, title: def.title, generatedAt: new Date().toISOString(), filters: f.echo, totals, sections };
}

export async function runReport(auth, key, query) {
  const def = definitionFor(key);
  const { page = 1, limit = 20 } = query;
  return build(auth, def, query, { page, limit });
}

const MIME = { csv: 'text/csv; charset=utf-8', pdf: 'application/pdf' };

// The same report, filters and school scoping as runReport, written as a file.
export async function exportReport(auth, key, query, format) {
  const def = definitionFor(key);
  const report = await build(auth, def, query, { all: true });
  const body = format === 'pdf' ? reportToPdf(report) : Buffer.from(reportToCsv(report), 'utf8');
  const rows = report.sections.reduce((n, s) => n + s.rows.length, 0);

  // Exporting school data is itself worth a trail entry (what, in which format, with which filters).
  await recordAudit(auth, {
    action: 'report.exported',
    entityType: 'report',
    entityId: auth.schoolId,
    summary: `Exported the ${def.title} report as ${format.toUpperCase()}`,
    details: { report: def.key, format, filters: report.filters, rows },
  });
  const stamp = report.generatedAt.slice(0, 10);
  return { body, contentType: MIME[format], filename: `${def.key}-report-${stamp}.${format}` };
}
