// Minimal CSV writer (RFC 4180): comma separated, CRLF line ends, quotes doubled.
//
// Spreadsheet safety: a text cell that starts with = + - @ (or a tab / carriage return) can
// be run as a formula when the file is opened in Excel or Sheets. Such text cells get a
// leading apostrophe. Numbers are written as numbers and never altered.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells) => cells.map(csvCell).join(',');

// A report (see services/reports) as CSV: a short heading, then each section as a table.
export function reportToCsv(report) {
  const lines = [
    csvLine(['Report', report.title]),
    csvLine(['Generated', report.generatedAt]),
    csvLine(['Filters', describeFilters(report.filters)]),
  ];
  if (report.totals && report.totals.length > 0) {
    lines.push('', csvLine(['Summary']));
    for (const t of report.totals) lines.push(csvLine([t.label, t.value]));
  }
  for (const section of report.sections) {
    lines.push('', csvLine([section.title]), csvLine(section.columns.map((c) => c.label)));
    for (const row of section.rows) lines.push(csvLine(section.columns.map((c) => row[c.key])));
    if (section.truncated) lines.push(csvLine([`Only the first ${section.rows.length} of ${section.total} rows are included.`]));
  }
  return `﻿${lines.join('\r\n')}\r\n`; // BOM so Excel reads UTF-8 names correctly
}

export function describeFilters(filters) {
  const entries = Object.entries(filters || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return 'none';
  return entries.map(([k, v]) => `${k}=${v instanceof Date ? v.toISOString().slice(0, 10) : v}`).join('; ');
}
