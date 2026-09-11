const path = require('path');
const PDFDocument = require('pdfkit');
const { PRODUCT_NAME, INK, PAPER, BORDER, ROW_STRIPE, ACCENT } = require('./pdfTheme');

const PAGE_MARGIN = 42;
const FRAME_INSET = 14; // gap between the page margin and the drawn border frame
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo-light.png');

// Reserved for the totals box + footer note on whichever page ends up last -
// renderTable checks against this so those two never get squeezed off the
// bottom of the page.
const BOTTOM_RESERVE = 110;

function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function formatLongDate(date) {
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(date));
}

function contentBounds(doc) {
  return {
    left: PAGE_MARGIN,
    width: doc.page.width - PAGE_MARGIN * 2,
    bottom: doc.page.height - PAGE_MARGIN,
  };
}

// The visible bordered frame the whole document sits inside, plus a thick
// accent rule along the top edge - drawn fresh on every page, including
// pagination overflow pages, so the "one bordered page" look holds even in
// the rare case an invoice spills past a single page.
function drawFrame(doc) {
  const x = PAGE_MARGIN - FRAME_INSET;
  const y = PAGE_MARGIN - FRAME_INSET;
  const w = doc.page.width - x * 2;
  const h = doc.page.height - y * 2;

  doc.lineWidth(1).strokeColor(BORDER).rect(x, y, w, h).stroke();
  doc.lineWidth(4).strokeColor(ACCENT).moveTo(x, y).lineTo(x + w, y).stroke();
  doc.lineWidth(1).strokeColor(INK);
}

function renderHeader(doc, { invoice }) {
  const { left, width } = contentBounds(doc);
  const top = PAGE_MARGIN + 8;

  try {
    const logo = doc.openImage(LOGO_PATH);
    const logoHeight = 20;
    const logoWidth = logoHeight * (logo.width / logo.height);
    doc.image(logo, left, top, { height: logoHeight });
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(PRODUCT_NAME, left + logoWidth + 10, top + (logoHeight - 11) / 2, { lineBreak: false });
  } catch (err) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(PRODUCT_NAME, left, top, { lineBreak: false });
  }

  doc
    .font('Helvetica-Bold')
    .fontSize(26)
    .fillColor(INK)
    .text('INVOICE', left, top - 4, { width, align: 'right', lineBreak: false });
  doc
    .fillColor(INK)
    .fillOpacity(0.55)
    .font('Helvetica')
    .fontSize(10)
    .text(`#${String(invoice.id).padStart(6, '0')}`, left, top + 25, { width, align: 'right', lineBreak: false });
  doc.fillOpacity(1);

  const dividerY = top + 46;
  doc.lineWidth(1).strokeColor(BORDER).moveTo(left, dividerY).lineTo(left + width, dividerY).stroke();
  doc.fillColor(INK);

  return dividerY + 22;
}

function renderMeta(doc, { reseller, invoice, periodLabel, startY }) {
  const { left, width } = contentBounds(doc);
  const colWidth = width / 2;

  doc
    .font('Helvetica-Bold')
    .fontSize(8)
    .fillColor(INK)
    .fillOpacity(0.5)
    .text('BILLED TO', left, startY, { lineBreak: false });
  doc.fillOpacity(1);
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(INK)
    .text(reseller ? reseller.username : `Reseller #${invoice.reseller_id}`, left, startY + 13, { lineBreak: false });
  if (reseller && reseller.email) {
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(INK)
      .fillOpacity(0.6)
      .text(reseller.email, left, startY + 29, { lineBreak: false });
    doc.fillOpacity(1);
  }

  const detailX = left + colWidth;
  const labelWidth = colWidth * 0.45;
  const valueWidth = colWidth - labelWidth;
  const rows = [
    ['Invoice #', String(invoice.id)],
    ['Period', periodLabel],
    ['Issue date', formatLongDate(invoice.created_at)],
    ['Status', invoice.sent_at ? 'Sent' : 'Draft'],
  ];
  rows.forEach(([label, value], i) => {
    const y = startY + i * 15;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(INK)
      .fillOpacity(0.5)
      .text(label, detailX, y, { width: labelWidth, lineBreak: false });
    doc
      .fillOpacity(1)
      .font('Helvetica-Bold')
      .fontSize(9)
      .fillColor(INK)
      .text(value, detailX + labelWidth, y, { width: valueWidth, align: 'right', lineBreak: false });
  });

  doc.fillColor(INK);
  return startY + 60;
}

const TABLE_COLUMNS = [
  { key: 'date', label: 'Date', widthRatio: 0.22, align: 'left' },
  { key: 'account', label: 'Account', widthRatio: 0.53, align: 'left' },
  { key: 'amount', label: 'Amount', widthRatio: 0.25, align: 'right' },
];
const TABLE_HEADER_HEIGHT = 22;
const TABLE_IDEAL_ROW_HEIGHT = 20;
const TABLE_MIN_ROW_HEIGHT = 12;

function drawTableHeaderRow(doc, { left, width, colWidths, y }) {
  doc.rect(left, y, width, TABLE_HEADER_HEIGHT).fill(INK);
  let x = left;
  TABLE_COLUMNS.forEach((col, i) => {
    doc
      .fillColor(PAPER)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(col.label.toUpperCase(), x + 8, y + 7, { width: colWidths[i] - 16, align: col.align, lineBreak: false });
    x += colWidths[i];
  });
  doc.fillColor(INK);
}

// Renders the line-item table with a full grid (outer border, header
// underline, column separators, row separators) rather than just header
// styling - that grid is what makes it read as an actual invoice table
// rather than a plain list. Row height shrinks (down to a readable minimum)
// so a normal-sized invoice always fits on one page; only if a reseller has
// enough renewals in one period to blow past even the minimum row height
// does it fall back to a continuation page, redrawing the frame and table
// header there so the grid stays intact.
function renderTable(doc, { lineItems, startY, addContinuationPage }) {
  const { left, width } = contentBounds(doc);
  const colWidths = TABLE_COLUMNS.map((c) => c.widthRatio * width);
  const rows = lineItems.length ? lineItems : [{ date: '', account: 'No renewals in this period.', amount: '' }];

  // Math.floor, not a plain division - a row height that exactly fills
  // availableFirstPage (e.g. 17.43px) drifts over budget by the time N rows'
  // worth of floating-point additions accumulate, triggering a spurious
  // extra page for content that should have fit. Flooring to a whole pixel
  // guarantees rowHeight * rows.length never exceeds availableFirstPage.
  const availableFirstPage = doc.page.height - PAGE_MARGIN - BOTTOM_RESERVE - startY - TABLE_HEADER_HEIGHT;
  const rowHeight = Math.max(
    TABLE_MIN_ROW_HEIGHT,
    Math.min(TABLE_IDEAL_ROW_HEIGHT, Math.floor(availableFirstPage / Math.max(rows.length, 1)))
  );

  let y = startY;
  let tableTop = startY;
  const rowBoundaries = [];

  drawTableHeaderRow(doc, { left, width, colWidths, y });
  y += TABLE_HEADER_HEIGHT;

  rows.forEach((row, idx) => {
    const pageBottom = doc.page.height - PAGE_MARGIN - BOTTOM_RESERVE;
    if (y + rowHeight > pageBottom) {
      drawGrid(doc, { left, width, colWidths, top: tableTop, boundaries: rowBoundaries, headerHeight: TABLE_HEADER_HEIGHT });
      y = addContinuationPage();
      tableTop = y;
      rowBoundaries.length = 0;
      drawTableHeaderRow(doc, { left, width, colWidths, y });
      y += TABLE_HEADER_HEIGHT;
    }

    if (idx % 2 === 1) {
      doc.rect(left, y, width, rowHeight).fill(ROW_STRIPE);
    }

    let x = left;
    TABLE_COLUMNS.forEach((col, i) => {
      doc
        .fillColor(INK)
        .font('Helvetica')
        .fontSize(8)
        .text(String(row[col.key] ?? ''), x + 8, y + (rowHeight - 8) / 2, {
          width: colWidths[i] - 16,
          align: col.align,
          ellipsis: true,
          lineBreak: false,
        });
      x += colWidths[i];
    });

    y += rowHeight;
    rowBoundaries.push(y);
  });

  drawGrid(doc, { left, width, colWidths, top: tableTop, boundaries: rowBoundaries, headerHeight: TABLE_HEADER_HEIGHT });

  doc.fillColor(INK);
  return y;
}

function drawGrid(doc, { left, width, colWidths, top, boundaries, headerHeight }) {
  const bottom = boundaries.length ? boundaries[boundaries.length - 1] : top + headerHeight;

  doc.lineWidth(1).strokeColor(BORDER);
  doc.rect(left, top, width, bottom - top).stroke();
  doc.moveTo(left, top + headerHeight).lineTo(left + width, top + headerHeight).stroke();

  let x = left;
  colWidths.forEach((colWidth, i) => {
    if (i > 0) doc.moveTo(x, top).lineTo(x, bottom).stroke();
    x += colWidth;
  });

  boundaries.slice(0, -1).forEach((y) => {
    doc.moveTo(left, y).lineTo(left + width, y).stroke();
  });

  doc.strokeColor(INK);
}

function renderTotals(doc, { invoice, startY }) {
  const { left, width } = contentBounds(doc);
  const boxWidth = 220;
  const boxHeight = 40;
  const x = left + width - boxWidth;
  const y = startY + 18;

  doc.rect(x, y, boxWidth, boxHeight).fill(INK);
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(PAPER)
    .fillOpacity(0.65)
    .text('TOTAL DUE', x + 16, y + 10, { lineBreak: false });
  doc.fillOpacity(1);
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(ACCENT)
    .text(formatUsd(invoice.total_amount_usd), x, y + 9, { width: boxWidth - 16, align: 'right', lineBreak: false });

  doc.fillColor(INK);
}

function renderFooter(doc) {
  const { left, width, bottom } = contentBounds(doc);

  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(INK)
    .fillOpacity(0.55)
    .text('Payments are handled by our team crediting your wallet directly - no separate action is required.', left, bottom - 26, {
      width,
      align: 'center',
    });
  doc
    .font('Helvetica')
    .fontSize(7)
    .fillColor(INK)
    .fillOpacity(0.4)
    .text(`Generated by ${PRODUCT_NAME} on ${formatLongDate(new Date())}`, left, bottom - 12, {
      width,
      align: 'center',
      lineBreak: false,
    });
  doc.fillOpacity(1).fillColor(INK);
}

function renderInvoicePdf(stream, { invoice, reseller, periodLabel, lineItems }) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: PAGE_MARGIN });
  doc.pipe(stream);

  drawFrame(doc);
  const dividerBottom = renderHeader(doc, { invoice });
  const metaBottom = renderMeta(doc, { reseller, invoice, periodLabel, startY: dividerBottom });

  const addContinuationPage = () => {
    doc.addPage();
    drawFrame(doc);
    return PAGE_MARGIN + 10;
  };

  const tableBottom = renderTable(doc, { lineItems, startY: metaBottom, addContinuationPage });

  // If the table's last page doesn't have room left for the totals box, spill
  // those onto one more page rather than crowding/overlapping the frame edge.
  let totalsStartY = tableBottom;
  if (tableBottom + BOTTOM_RESERVE > doc.page.height - PAGE_MARGIN) {
    totalsStartY = addContinuationPage();
  }

  renderTotals(doc, { invoice, startY: totalsStartY });
  renderFooter(doc);

  doc.end();
}

module.exports = { renderInvoicePdf };
