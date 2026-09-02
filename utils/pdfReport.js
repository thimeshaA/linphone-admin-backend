const path = require('path');
const PDFDocument = require('pdfkit');
const { PRODUCT_NAME, INK, PAPER, BORDER, ROW_STRIPE, ACCENT, ORANGE, TONES } = require('./pdfTheme');

const PAGE_MARGIN = 50;
const FOOTER_RESERVE = 30;
const RUNNING_HEADER_HEIGHT = 30;
const LOGO_PATH = path.join(__dirname, '..', 'assets', 'logo-light.png');
const LOGO_MARK_DARK_PATH = path.join(__dirname, '..', 'assets', 'logo-mark-dark.png');
const LOGO_SIZE = 26;

// The report is portrait A4 throughout except sections carrying a wide data
// table (see sectionNeedsLandscape), which switch to landscape so columns
// stay legible. `doc._pageOptions` tracks which one new pages should use —
// addPage() with no options reverts pdfkit to the *document's original*
// options, not the current page's, so every page-break site must go through
// addReportPage() rather than a bare doc.addPage().
const PORTRAIT_OPTIONS = { size: 'A4', margin: PAGE_MARGIN };
const LANDSCAPE_OPTIONS = { size: 'A4', layout: 'landscape', margin: PAGE_MARGIN };

function addReportPage(doc) {
  doc.addPage(doc._pageOptions);
}

function sectionNeedsLandscape(section) {
  return section.kind === 'table' || (section.kind === 'bar-and-table' && !!section.table);
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

function toneColors(tone) {
  return TONES[tone] || TONES.neutral;
}

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, neededHeight) {
  const bottom = doc.page.height - doc.page.margins.bottom - FOOTER_RESERVE;
  if (doc.y + neededHeight > bottom) {
    addReportPage(doc);
  }
}

// ---------------------------------------------------------------------------
// Cover page
// ---------------------------------------------------------------------------

function renderCover(doc, { reportTitle, periodLabel, generatedAt }) {
  const w = doc.page.width;
  const h = doc.page.height;
  const left = PAGE_MARGIN;

  doc.rect(0, 0, w, h).fill(INK);

  // Decorative abstract accent - not data-driven, just brand presence.
  doc.fillOpacity(0.9);
  doc.circle(w - 90, h - 160, 190).fill(ACCENT);
  doc.fillOpacity(0.75);
  doc.circle(w - 260, h - 40, 130).fill(ORANGE);
  doc.fillOpacity(0.45);
  doc.circle(w - 40, h - 320, 110).fill(ORANGE);
  doc.fillOpacity(1);

  try {
    const logo = doc.openImage(LOGO_MARK_DARK_PATH);
    const logoHeight = 54;
    const logoWidth = logoHeight * (logo.width / logo.height);
    doc.image(logo, left, PAGE_MARGIN, { height: logoHeight });
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(PAPER)
      .text(PRODUCT_NAME, left + logoWidth + 14, PAGE_MARGIN + (logoHeight - 20) / 2, {
        width: w - left - logoWidth - 14,
        lineBreak: false,
      });
  } catch (err) {
    doc.font('Helvetica-Bold').fontSize(20).fillColor(PAPER).text(PRODUCT_NAME, left, PAGE_MARGIN, { lineBreak: false });
  }

  doc.x = left;
  doc.y = h * 0.42;
  doc.font('Helvetica-Bold').fontSize(36).fillColor(PAPER).text(reportTitle, left, doc.y, { width: w - left * 2 });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(16).fillColor(PAPER).fillOpacity(0.8).text(periodLabel);
  doc.fillOpacity(1);
  doc.moveDown(0.2);
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(PAPER)
    .fillOpacity(0.55)
    .text(`Generated on ${formatDateTime(generatedAt)}`);
  doc.fillOpacity(1);
  doc.fillColor(INK);
}

// ---------------------------------------------------------------------------
// Running header / footer (content pages only, never the cover)
// ---------------------------------------------------------------------------

function drawRunningHeader(doc, sectionLabel) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const top = doc.page.margins.top;

  try {
    doc.image(LOGO_PATH, left, top, { height: 14 });
  } catch (err) {
    // A missing/corrupt logo asset shouldn't stop a report from generating.
  }

  doc
    .fillColor(INK)
    .fillOpacity(0.55)
    .font('Helvetica-Bold')
    .fontSize(8)
    .text(sectionLabel || '', left, top + 3, { width, height: 10, align: 'right', ellipsis: true });
  doc.fillOpacity(1);

  doc.rect(left, top + RUNNING_HEADER_HEIGHT - 10, width, 1).fill(BORDER);
  doc.fillColor(INK);

  doc.x = left;
  doc.y = top + RUNNING_HEADER_HEIGHT;
}

function renderFooters(doc) {
  const range = doc.bufferedPageRange();
  const coverOffset = 1; // page index 0 is the cover; it never gets a footer.
  const totalContentPages = Math.max(range.count - coverOffset, 0);

  for (let i = coverOffset; i < range.count; i++) {
    doc.switchToPage(i);
    const left = doc.page.margins.left;
    const width = contentWidth(doc);
    const y = doc.page.height - doc.page.margins.bottom + 10;

    // Text landing below `margins.bottom` reads to pdfkit as overflow, which
    // triggers an unwanted auto page-break - zero the margin for this write.
    const originalBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc.rect(left, y - 6, width, 1).fill(ACCENT);

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
      .text(`Page ${i - coverOffset + 1} of ${totalContentPages}`, left, y, { width, align: 'right', lineBreak: false });
    doc.fillOpacity(1);

    doc.page.margins.bottom = originalBottom;
  }
}

// ---------------------------------------------------------------------------
// Section heading - bold numbered treatment, alternating brand accent
// ---------------------------------------------------------------------------

function renderSectionHeading(doc, number, title) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const blockSize = 34;

  ensureSpace(doc, blockSize + 60);
  doc.moveDown(1.4);

  const y = doc.y;
  const accent = number % 2 === 1 ? ACCENT : ORANGE;
  const numStr = String(number).padStart(2, '0');

  doc.rect(left, y, blockSize, blockSize).fill(accent);
  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(15)
    .text(numStr, left, y + (blockSize - 15) / 2 - 2, { width: blockSize, align: 'center', lineBreak: false });

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(17)
    .text(title, left + blockSize + 14, y + (blockSize - 17) / 2 - 2, {
      width: width - blockSize - 14,
      lineBreak: false,
    });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = y + blockSize + 16;
}

// ---------------------------------------------------------------------------
// KPI grid - bold-number cards with an alternating left-border accent
// ---------------------------------------------------------------------------

function renderKpiGrid(doc, stats) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const cols = Math.min(stats.length, 4) || 1;
  const gap = 14;
  const cardWidth = (width - gap * (cols - 1)) / cols;
  const cardHeight = 76;
  const rows = Math.ceil(stats.length / cols);

  ensureSpace(doc, rows * (cardHeight + gap) + 10);
  const startY = doc.y;

  stats.forEach((stat, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = left + col * (cardWidth + gap);
    const y = startY + row * (cardHeight + gap);
    const accent = i % 2 === 0 ? ACCENT : ORANGE;

    doc.rect(x, y, cardWidth, cardHeight).fill('#f7f7f7');
    doc.rect(x, y, 5, cardHeight).fill(accent);

    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(25)
      .text(String(stat.value), x + 18, y + 16, { width: cardWidth - 32, height: 30, ellipsis: true });
    doc
      .fillColor(INK)
      .fillOpacity(0.6)
      .font('Helvetica')
      .fontSize(8)
      .text(stat.label.toUpperCase(), x + 18, y + 48, { width: cardWidth - 32, height: 22 });
    doc.fillOpacity(1);
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = startY + rows * (cardHeight + gap);
  doc.moveDown(0.6);
}

// ---------------------------------------------------------------------------
// Donut chart - status distribution, colored via the shared TONES map
// ---------------------------------------------------------------------------

function polarPoint(cx, cy, r, angle) {
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function renderDonut(doc, segments) {
  const left = doc.page.margins.left;
  const outerR = 68;
  const innerR = 38;
  const total = segments.reduce((sum, seg) => sum + seg.value, 0);

  ensureSpace(doc, outerR * 2 + 20);

  const startY = doc.y;
  const cx = left + outerR;
  const cy = startY + outerR;
  const STEP = Math.PI / 90; // 2-degree sampling

  if (total > 0) {
    let angle = -Math.PI / 2;
    segments.forEach((seg) => {
      if (seg.value <= 0) return;
      const sweep = (seg.value / total) * Math.PI * 2;
      const endAngle = angle + sweep;

      const points = [];
      for (let a = angle; a < endAngle; a += STEP) points.push(polarPoint(cx, cy, outerR, a));
      points.push(polarPoint(cx, cy, outerR, endAngle));
      for (let a = endAngle; a > angle; a -= STEP) points.push(polarPoint(cx, cy, innerR, a));
      points.push(polarPoint(cx, cy, innerR, angle));

      doc.polygon(...points).fill(toneColors(seg.tone).fill);
      angle = endAngle;
    });
  } else {
    doc.circle(cx, cy, outerR).fill(BORDER);
    doc.circle(cx, cy, innerR).fill(PAPER);
  }

  doc
    .fillColor(INK)
    .font('Helvetica-Bold')
    .fontSize(20)
    .text(String(total), cx - innerR, cy - 12, { width: innerR * 2, align: 'center', lineBreak: false });
  doc
    .fillColor(INK)
    .fillOpacity(0.55)
    .font('Helvetica')
    .fontSize(7)
    .text('TOTAL', cx - innerR, cy + 10, { width: innerR * 2, align: 'center', lineBreak: false });
  doc.fillOpacity(1);

  const legendX = cx + outerR + 36;
  let legendY = startY + 4;
  segments.forEach((seg) => {
    const pct = total ? Math.round((seg.value / total) * 100) : 0;
    doc.rect(legendX, legendY, 10, 10).fill(toneColors(seg.tone).fill);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(9)
      .text(seg.label, legendX + 16, legendY - 1, { width: 180, lineBreak: false });
    doc
      .fillColor(INK)
      .fillOpacity(0.6)
      .font('Helvetica')
      .fontSize(8)
      .text(`${seg.value} (${pct}%)`, legendX + 16, legendY + 11, { width: 180, lineBreak: false });
    doc.fillOpacity(1);
    legendY += 34;
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = startY + outerR * 2 + 16;
}

// ---------------------------------------------------------------------------
// Horizontal bar chart - e.g. top resellers by volume
// ---------------------------------------------------------------------------

function renderBarChart(doc, bars) {
  if (bars.length === 0) return;

  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const maxValue = Math.max(...bars.map((b) => b.value), 1);
  const barHeight = 16;
  const gap = 10;
  const labelWidth = 150;
  const valueWidth = 40;
  const trackWidth = width - labelWidth - valueWidth;

  ensureSpace(doc, bars.length * (barHeight + gap) + 10);

  bars.forEach((bar, i) => {
    ensureSpace(doc, barHeight + gap);
    const y = doc.y;
    const color = i % 2 === 0 ? ACCENT : ORANGE;
    const barWidth = Math.max((bar.value / maxValue) * trackWidth, 2);

    doc
      .fillColor(INK)
      .font('Helvetica')
      .fontSize(8)
      .text(bar.label, left, y + (barHeight - 8) / 2, { width: labelWidth - 10, height: 10, ellipsis: true });

    doc.rect(left + labelWidth, y, trackWidth, barHeight).fill(BORDER);
    doc.rect(left + labelWidth, y, barWidth, barHeight).fill(color);

    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(8)
      .text(String(bar.value), left + labelWidth + trackWidth + 8, y + (barHeight - 8) / 2, {
        width: valueWidth - 8,
        align: 'right',
        lineBreak: false,
      });

    doc.y = y + barHeight + gap;
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.moveDown(0.4);
}

// ---------------------------------------------------------------------------
// Data table - dark header, alternating rows, status badges, repeats on break
// ---------------------------------------------------------------------------

function computeColumnWidths(columns, totalWidth) {
  const fixedTotal = columns.reduce((sum, c) => sum + (c.width || 0), 0);
  const remaining = Math.max(totalWidth - fixedTotal, 0);
  const flexTotalWeight = columns.reduce((sum, c) => sum + (c.width ? 0 : c.flex || 1), 0) || 1;
  return columns.map((c) => (c.width ? c.width : (remaining * (c.flex || 1)) / flexTotalWeight));
}

function drawBadge(doc, tone, label, x, y, colWidth, rowHeight) {
  const t = toneColors(tone);
  const badgeHeight = 14;
  const badgeWidth = Math.min(colWidth - 12, 74);
  const bx = x + 6;
  const by = y + (rowHeight - badgeHeight) / 2;

  doc.roundedRect(bx, by, badgeWidth, badgeHeight, 7).fill(t.fill);
  doc
    .fillColor(t.text)
    .font('Helvetica-Bold')
    .fontSize(7)
    .text(label, bx, by + 4, { width: badgeWidth, height: 8, align: 'center', ellipsis: true });
  doc.fillColor(INK);
}

function renderTable(doc, { title, columns, rows }) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  const rowHeight = 22;
  const headerHeight = 24;
  const colWidths = computeColumnWidths(columns, width);

  ensureSpace(doc, headerHeight + rowHeight + 24);

  if (title) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(title);
    doc.moveDown(0.4);
  }

  function drawCell(text, x, y, colWidth, align) {
    doc.text(String(text), x + 6, y, {
      width: colWidth - 12,
      height: 10,
      align: align || 'left',
      ellipsis: true,
    });
  }

  function drawHeaderRow(y) {
    doc.rect(left, y, width, headerHeight).fill(INK);
    let x = left;
    columns.forEach((col, i) => {
      doc.fillColor(PAPER).font('Helvetica-Bold').fontSize(8);
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
      addReportPage(doc);
      y = doc.y; // the 'pageAdded' running-header handler already reserved this
      drawHeaderRow(y);
      y += headerHeight;
    }

    if (idx % 2 === 1) {
      doc.rect(left, y, width, rowHeight).fill(ROW_STRIPE);
    }

    let x = left;
    columns.forEach((col, i) => {
      const value = row[col.key];
      if (col.badge && value && typeof value === 'object') {
        drawBadge(doc, value.tone, value.label, x, y, colWidths[i], rowHeight);
      } else {
        doc.fillColor(INK).font('Helvetica').fontSize(8);
        drawCell(value, x, y + 7, colWidths[i], col.align);
      }
      x += colWidths[i];
    });

    y += rowHeight;
  });

  doc.fillColor(INK);
  doc.x = left;
  doc.y = y + 10;
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

function renderReportPdf(stream, { reportTitle, periodLabel, generatedAt, sections }) {
  const doc = new PDFDocument({ ...PORTRAIT_OPTIONS, bufferPages: true });
  doc._pageOptions = PORTRAIT_OPTIONS;
  doc.pipe(stream);

  let currentLabel = sections.length ? `01 - ${sections[0].title}` : '';
  doc.on('pageAdded', () => drawRunningHeader(doc, currentLabel));

  renderCover(doc, { reportTitle, periodLabel, generatedAt });
  addReportPage(doc);

  let isLandscape = false;

  sections.forEach((section, i) => {
    const number = i + 1;
    currentLabel = `${String(number).padStart(2, '0')} - ${section.title}`;

    const needsLandscape = sectionNeedsLandscape(section);
    if (needsLandscape !== isLandscape) {
      isLandscape = needsLandscape;
      doc._pageOptions = isLandscape ? LANDSCAPE_OPTIONS : PORTRAIT_OPTIONS;
      addReportPage(doc);
    }

    renderSectionHeading(doc, number, section.title);

    if (section.kind === 'kpis') {
      renderKpiGrid(doc, section.stats);
    } else if (section.kind === 'donut') {
      renderDonut(doc, section.segments);
    } else if (section.kind === 'bar-and-table') {
      renderBarChart(doc, section.bars);
      if (section.table) {
        doc.moveDown(0.6);
        renderTable(doc, section.table);
      }
    } else if (section.kind === 'table') {
      renderTable(doc, section);
    }
  });

  renderFooters(doc);
  doc.end();
}

module.exports = { renderReportPdf };
