import { describeFilters } from './csv.js';

// A small, dependency-free PDF writer for tabular reports: A4, built-in Helvetica fonts
// (nothing is embedded), a header on the first page and "Page x of y" on every page.
// Text is written in WinAnsi, so characters outside Latin-1 become "?". Cells that are too
// wide for their column are cut with an ellipsis; nothing is ever written outside a page.

const PORTRAIT = { w: 595.28, h: 841.89 };
const LANDSCAPE = { w: 841.89, h: 595.28 };
const MARGIN = 36;
const FONT = 8;
const LEAD = 12;
const AVG = 0.5; // average Helvetica glyph width in em

const latin1 = (text) => String(text ?? '').replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
const escapePdf = (text) => latin1(text).replace(/[\\()]/g, '\\$&');
const fmt = (n) => (Math.round(n * 100) / 100).toString();

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).replace(/\s+/g, ' ');
};

function fit(text, width, size = FONT) {
  const max = Math.max(1, Math.floor(width / (size * AVG)));
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}.`;
}

export function reportToPdf(report) {
  const wide = report.sections.some((s) => s.columns.length > 6);
  const page = wide ? LANDSCAPE : PORTRAIT;
  const usable = page.w - MARGIN * 2;

  const pages = [[]]; // each page: array of content-stream operators
  let y = page.h - MARGIN;
  const ops = () => pages[pages.length - 1];
  const newPage = () => {
    pages.push([]);
    y = page.h - MARGIN;
  };
  const ensure = (height) => {
    if (y - height < MARGIN + 18) newPage();
  };
  const text = (x, str, { bold = false, size = FONT } = {}) =>
    ops().push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${fmt(x)} ${fmt(y)} Td (${escapePdf(str)}) Tj ET`);
  const rule = () => ops().push(`0.6 w ${fmt(MARGIN)} ${fmt(y)} m ${fmt(page.w - MARGIN)} ${fmt(y)} l S`);

  text(MARGIN, report.title, { bold: true, size: 15 });
  y -= 18;
  text(MARGIN, fit(`Generated: ${report.generatedAt}`, usable));
  y -= LEAD;
  text(MARGIN, fit(`Filters: ${describeFilters(report.filters)}`, usable));
  y -= LEAD * 1.5;

  const totals = (report.totals || []).map((t) => [t.label, t.value]);
  if (totals.length > 0) {
    text(MARGIN, 'Summary', { bold: true, size: 10 });
    y -= LEAD + 2;
    for (const [label, value] of totals) {
      ensure(LEAD);
      text(MARGIN, fit(label, usable * 0.6));
      text(MARGIN + usable * 0.6, fit(cellText(value), usable * 0.4));
      y -= LEAD;
    }
    y -= LEAD * 0.5;
  }

  for (const section of report.sections) {
    ensure(LEAD * 4);
    text(MARGIN, fit(section.title, usable), { bold: true, size: 10 });
    y -= LEAD + 2;

    const cols = section.columns;
    // Columns share the width in proportion to the longest text they hold (bounded).
    const weights = cols.map((c) => {
      const longest = Math.max(c.label.length, ...section.rows.slice(0, 200).map((r) => cellText(r[c.key]).length), 4);
      return Math.min(Math.max(longest, 6), 32);
    });
    const total = weights.reduce((a, b) => a + b, 0);
    const widths = weights.map((w) => (w / total) * usable);
    const xs = widths.map((_, i) => MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0));

    const header = () => {
      cols.forEach((c, i) => text(xs[i], fit(c.label, widths[i] - 4), { bold: true }));
      y -= 3;
      rule();
      y -= LEAD - 3;
    };
    header();
    if (section.rows.length === 0) {
      text(MARGIN, 'No records.');
      y -= LEAD;
    }
    for (const row of section.rows) {
      if (y - LEAD < MARGIN + 18) {
        newPage();
        header();
      }
      cols.forEach((c, i) => text(xs[i], fit(cellText(row[c.key]), widths[i] - 4)));
      y -= LEAD;
    }
    if (section.truncated) {
      ensure(LEAD);
      text(MARGIN, fit(`Only the first ${section.rows.length} of ${section.total} rows are included.`, usable));
      y -= LEAD;
    }
    y -= LEAD;
  }

  // ---- assemble the file
  const objects = []; // index = object number - 1
  const add = (body) => objects.push(body) && objects.length;
  const catalog = add('');
  const pagesRoot = add('');
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  pages.forEach((content, index) => {
    const footer = `BT /F1 7 Tf ${fmt(page.w / 2 - 25)} ${fmt(MARGIN - 14)} Td (Page ${index + 1} of ${pages.length}) Tj ET`;
    const stream = [...content, footer].join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${fmt(page.w)} ${fmt(page.h)}] ` +
          `/Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${contentId} 0 R >>`
      )
    );
  });
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
  objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
