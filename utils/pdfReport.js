const path = require('path');
const PDFDocument = require('pdfkit');
const { PRODUCT_NAME, INK, BORDER, ROW_STRIPE, ACCENT, TONES } = require('./pdfTheme');

const PAGE_MARGIN = 50;
const FOOTER_RESERVE = 30;
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo-light.png');
const LOGO_SIZE = 26;

function formatDateTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;
  if (doc.y + neededHeight > bottom) {
    doc.addPage();
  }
}

function renderHeader(doc, { reportTitle, periodLabel, generatedAt }) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const top = doc.y;

  try {
    doc.image(LOGO_PATH, left, top, { height: LOGO_SIZE });
  } catch (err) {
    // A missing/corrupt logo asset shouldn't stop a report from generating.
  }

  const textLeft = left + LOGO_SIZE + 10;
  doc
    .font('Helvetica-Bold')
    .fontSize(20)
    .fillColor(INK)
    .text(PRODUCT_NAME, textLeft, top + (LOGO_SIZE - 20) / 2, { width: width - LOGO_SIZE - 10, lineBreak: false });

  doc.x = left;
  doc.y = top + LOGO_SIZE + 6;

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(reportTitle);
  doc.moveDown(0.1);
  doc.font('Helvetica').fontSize(11).fillColor(INK).fillOpacity(0.65).text(periodLabel);
  doc.fillOpacity(1);
  doc.font('Helvetica').fontSize(8).fillColor(INK).fillOpacity(0.5).text(`Generated on ${formatDateTime(generatedAt)}`);
  doc.fillOpacity(1);

  doc.moveDown(0.8);
  doc.rect(left, doc.y, width, 2).fill(ACCENT);
  doc.fillColor(INK);
  doc.x = left;
  doc.moveDown(1);
}

// Columns take either a fixed `width` (pt) for narrow fixed-format fields
// (ids, statuses, dates) or a `flex` weight for free-text fields, splitting
// whatever width is left over after the fixed columns are subtracted.
function computeColumnWidths(columns, totalWidth) {
  const fixedTotal = columns.reduce((sum, c) => sum + (c.width || 0), 0);
  const remaining = Math.max(totalWidth - fixedTotal, 0);
  const flexTotalWeight = columns.reduce((sum, c) => sum + (c.width ? 0 : c.flex || 1), 0) || 1;
  return columns.map((c) => (c.width ? c.width : (remaining * (c.flex || 1)) / flexTotalWeight));
}

function renderTable(doc, { title, columns, rows }) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const rowHeight = 22;
  const headerHeight = 24;
  const colWidths = computeColumnWidths(columns, width);

  ensureSpace(doc, headerHeight + rowHeight + 24);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(title);
  doc.moveDown(0.4);

  function drawCell(text, x, y, colWidth, align, opts = {}) {
    // `height` (not `lineBreak: false`) is what makes pdfkit truncate with an
    // ellipsis instead of wrapping onto a second line within a fixed-height row.
    doc.text(String(text), x + 6, y, {
      width: colWidth - 12,
      height: 10,
      align: align || 'left',
      ellipsis: true,
      ...opts,
    });
  }

  function drawHeaderRow(y) {
    doc.rect(left, y, width, headerHeight).fill(TONES.neutral.tint);
    let x = left;
    columns.forEach((col, i) => {
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(8);
      drawCell(col.label, x, y + 8, colWidths[i], col.align);
      x += colWidths[i];
    });
    doc.fillColor(INK);
  }

  let y = doc.y;
  drawHeaderRow(y);
  y += headerHeight;

  if (rows.length === 0) {
    doc.fillColor(INK).fillOpacity(0.5).font('Helvetica').fontSize(9);
    drawCell('No data for this period.', left, y + 6, width, 'left');
    doc.fillOpacity(1);
    y += rowHeight;
  }

  rows.forEach((row, idx) => {
    const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;
    if (y + rowHeight > bottom) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeaderRow(y);
      y += headerHeight;
    }

    if (idx % 2 === 1) {
      doc.rect(left, y, width, rowHeight).fill(ROW_STRIPE);
    }

    let x = left;
    columns.forEach((col, i) => {
      doc.fillColor(INK).font('Helvetica').fontSize(8);
      drawCell(row[col.key], x, y + 7, colWidths[i], col.align);
      x += colWidths[i];
    });

    y += rowHeight;
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = y + 10;
}

function renderFooters(doc) {
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const width = contentWidth(doc);
    const y = doc.page.height - doc.page.margins.bottom + 10;

    // Text landing below `margins.bottom` reads to pdfkit as overflow, which
    // triggers an unwanted auto page-break — zero the margin for this write.
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc
      .fillColor(INK)
      .fillOpacity(0.5)
      .font('Helvetica')
      .fontSize(8)
      .text(`Generated by ${PRODUCT_NAME}`, left, y, { width: width / 2, align: 'left', lineBreak: false });
    doc
      .fillColor(INK)
      .fillOpacity(0.5)
      .font('Helvetica')
      .fontSize(8)
      .text(`Page ${i - range.start + 1} of ${range.count}`, left, y, { width, align: 'right', lineBreak: false });
    doc.fillOpacity(1);

    doc.page.margins.bottom = originalBottom;
  }
}

function renderReportPdf(stream, { reportTitle, periodLabel, generatedAt, tables }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE_MARGIN, bufferPages: true });
  doc.pipe(stream);

  renderHeader(doc, { reportTitle, periodLabel, generatedAt });
  tables.forEach((table) => renderTable(doc, table));

  renderFooters(doc);
  doc.end();
}

module.exports = { renderReportPdf };
