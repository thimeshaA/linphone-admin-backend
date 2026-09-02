const PDFDocument = require('pdfkit');
const { PRODUCT_NAME, INK, BORDER, ROW_STRIPE, ACCENT, TONES } = require('./pdfTheme');

const PAGE_MARGIN = 50;
const FOOTER_RESERVE = 30;

function toneColors(tone) {
  return TONES[tone] || TONES.neutral;
}

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

  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(PRODUCT_NAME);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK).text(reportTitle);
  doc.moveDown(0.1);
  doc.font('Helvetica').fontSize(11).fillColor(INK).fillOpacity(0.65).text(periodLabel);
  doc.fillOpacity(1);
  doc.font('Helvetica').fontSize(8).fillColor(INK).fillOpacity(0.5).text(`Generated on ${formatDateTime(generatedAt)}`);
  doc.fillOpacity(1);

  doc.moveDown(0.8);
  doc.rect(left, doc.y, width, 2).fill(ACCENT);
  doc.fillColor(INK);
  doc.moveDown(1);
}

function renderStatGrid(doc, stats) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const cols = 3;
  const gap = 12;
  const boxWidth = (width - gap * (cols - 1)) / cols;
  const boxHeight = 66;
  const rows = Math.ceil(stats.length / cols);

  ensureSpace(doc, 20 + rows * (boxHeight + gap));

  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Summary');
  doc.moveDown(0.4);

  const startY = doc.y;
  stats.forEach((stat, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = left + col * (boxWidth + gap);
    const y = startY + row * (boxHeight + gap);
    const tone = toneColors(stat.tone);

    doc.roundedRect(x, y, boxWidth, boxHeight, 6).fill(tone.tint);
    doc
      .fillColor(tone.text)
      .font('Helvetica-Bold')
      .fontSize(22)
      .text(String(stat.value), x + 12, y + 14, { width: boxWidth - 24 });
    doc
      .fillColor(INK)
      .fillOpacity(0.6)
      .font('Helvetica')
      .fontSize(8)
      .text(stat.label.toUpperCase(), x + 12, y + 42, { width: boxWidth - 24 });
    doc.fillOpacity(1);
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = startY + rows * (boxHeight + gap);
  doc.moveDown(0.6);
}

function renderStatusChart(doc, segments) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const barHeight = 22;

  ensureSpace(doc, 90);

  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text('Status Distribution');
  doc.moveDown(0.4);

  const barY = doc.y;
  doc.rect(left, barY, width, barHeight).fill(BORDER);

  let x = left;
  if (total > 0) {
    segments.forEach((seg) => {
      const segWidth = (seg.value / total) * width;
      if (segWidth > 0) {
        doc.rect(x, barY, segWidth, barHeight).fill(toneColors(seg.tone).fill);
        x += segWidth;
      }
    });
  }
  doc.fillColor(INK);

  doc.y = barY + barHeight + 10;

  let legendX = left;
  const legendY = doc.y;
  segments.forEach((seg) => {
    const tone = toneColors(seg.tone);
    const pct = total ? Math.round((seg.value / total) * 100) : 0;
    doc.rect(legendX, legendY + 1, 8, 8).fill(tone.fill);
    doc
      .fillColor(INK)
      .font('Helvetica')
      .fontSize(9)
      .text(`${seg.label} (${seg.value} · ${pct}%)`, legendX + 12, legendY, { width: 140 });
    legendX += 160;
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = legendY + 16;
  doc.moveDown(0.8);
}

function computeColumnWidths(columns, totalWidth) {
  const firstShare = 0.4;
  const firstWidth = columns.length > 1 ? totalWidth * firstShare : totalWidth;
  const restWidth = (totalWidth - firstWidth) / Math.max(columns.length - 1, 1);
  return columns.map((_, i) => (i === 0 ? firstWidth : restWidth));
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

  function drawHeaderRow(y) {
    doc.rect(left, y, width, headerHeight).fill(TONES.neutral.tint);
    let x = left;
    columns.forEach((col, i) => {
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(col.label, x + 8, y + 7, { width: colWidths[i] - 16, align: col.align || 'left' });
      x += colWidths[i];
    });
    doc.fillColor(INK);
  }

  let y = doc.y;
  drawHeaderRow(y);
  y += headerHeight;

  if (rows.length === 0) {
    doc
      .fillColor(INK)
      .fillOpacity(0.5)
      .font('Helvetica')
      .fontSize(9)
      .text('No data for this period.', left + 8, y + 6);
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
      doc
        .fillColor(INK)
        .font('Helvetica')
        .fontSize(9)
        .text(String(row[col.key]), x + 8, y + 6, { width: colWidths[i] - 16, align: col.align || 'left' });
      x += colWidths[i];
    });

    y += rowHeight;
  });

  doc.fillColor(INK);
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

function renderReportPdf(stream, { reportTitle, periodLabel, generatedAt, stats, chart, table }) {
  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  doc.pipe(stream);

  renderHeader(doc, { reportTitle, periodLabel, generatedAt });
  renderStatGrid(doc, stats);
  renderStatusChart(doc, chart);
  if (table) renderTable(doc, table);

  renderFooters(doc);
  doc.end();
}

module.exports = { renderReportPdf };
