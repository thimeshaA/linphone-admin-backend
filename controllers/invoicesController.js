const { PassThrough } = require('stream');
const { getResellerById } = require('../models/adminModel');
const { findAccountLabelsByIds } = require('../models/accountModel');
const {
  getUninvoicedRenewalDeductionsInPeriod,
  linkLedgerEntriesToInvoice,
  unlinkLedgerEntriesFromInvoice,
  getLedgerEntriesForInvoice,
} = require('../models/walletLedgerModel');
const {
  findInvoiceByResellerAndPeriod,
  createInvoice,
  replaceInvoiceContents,
  getInvoiceById,
  listInvoices,
  markInvoiceSent,
} = require('../models/invoiceModel');
const { createNotification } = require('../models/notificationModel');
const { sendMail } = require('../utils/mailer');
const { renderInvoiceIssuedHtml } = require('../utils/emailTemplates');
const { parsePeriod } = require('../utils/reportPeriod');
const pdfInvoice = require('../utils/pdfInvoice');

const EMPTY = '-';

function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function formatDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : EMPTY;
}

// Reuses the exact same period math the reports already validate periods
// with (utils/reportPeriod.js), just fed from the invoice body's
// `{ periodType, periodValue }` shape instead of a report's `?period=&month=&year=`
// query string - so "what counts as August 2026" can never drift between the
// two features.
function resolvePeriod(periodType, periodValue) {
  if (periodType === 'monthly') {
    return parsePeriod({ period: 'monthly', month: periodValue });
  }
  if (periodType === 'annual') {
    return parsePeriod({ period: 'annual', year: periodValue });
  }
  return { error: 'periodType must be "monthly" or "annual"' };
}

function periodLabelFor(periodType, periodValue) {
  const period = resolvePeriod(periodType, periodValue);
  return period.error ? periodValue : period.label;
}

// A period's last calendar day - e.g. 2026-09-30 for monthly '2026-09',
// 2026-12-31 for annual '2026' - derived from period.end (the half-open
// upper bound resolvePeriod already produces for gathering ledger entries)
// rather than separate date math, so "when does this period end" can never
// drift from what it already means elsewhere in the invoice flow.
function lastDayOfPeriod(period) {
  return new Date(period.end.getFullYear(), period.end.getMonth(), period.end.getDate() - 1);
}

// Local calendar "today" with time-of-day stripped - local-component Date
// construction/comparison, matching how the rest of the app already compares
// dates (see renewAccount's `new Date(expiresAt) > new Date()` and
// defaultExpiresAt/renewalUnitsForPeriod in accountsController.js), not a
// UTC conversion.
function todayDateOnly() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Local-component "YYYY-MM-DD" formatting - deliberately not reusing
// formatDate() above (which slices a UTC ISO string) for this comparison's
// cutoff date, since that UTC conversion can shift the displayed date by a
// day depending on the server's offset from UTC. This stays on the same
// local-Date convention the comparison itself uses.
function formatDateOnly(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function create(req, res) {
  const { resellerId, periodType, periodValue } = req.body;

  const period = resolvePeriod(periodType, periodValue);
  if (period.error) {
    return res.status(400).json({ error: period.error });
  }

  const reseller = await getResellerById(resellerId);
  if (!reseller) {
    return res.status(400).json({ error: 'resellerId does not reference an existing reseller' });
  }

  // An invoice is one document per reseller per exact period (see the unique
  // constraint in sql/invoices.sql) - but re-running the same period is no
  // longer rejected. Instead the existing invoice is replaced: its old ledger
  // entries are released, the full unclaimed set for the period is regathered
  // (the released entries plus anything new since the last generation), and
  // the invoice is recomputed and re-linked in place. sent_at is reset to
  // NULL since a previously-emailed version no longer matches this content.
  const existing = await findInvoiceByResellerAndPeriod(resellerId, periodType, periodValue);
  if (existing) {
    await unlinkLedgerEntriesFromInvoice(existing.id);

    const entries = await getUninvoicedRenewalDeductionsInPeriod(resellerId, period.start, period.end);
    // amount_usd is stored negative for deductions (see applyRenewalDeduction);
    // the invoice total owed is the positive sum.
    const totalAmountUsd = entries.reduce((sum, e) => sum - Number(e.amount_usd), 0);

    const invoice = await replaceInvoiceContents(existing.id, totalAmountUsd);
    await linkLedgerEntriesToInvoice(entries.map((e) => e.id), existing.id);

    return res.status(200).json(invoice);
  }

  const entries = await getUninvoicedRenewalDeductionsInPeriod(resellerId, period.start, period.end);
  // amount_usd is stored negative for deductions (see applyRenewalDeduction);
  // the invoice total owed is the positive sum.
  const totalAmountUsd = entries.reduce((sum, e) => sum - Number(e.amount_usd), 0);

  const invoice = await createInvoice({ resellerId, periodType, periodValue, totalAmountUsd });
  await linkLedgerEntriesToInvoice(entries.map((e) => e.id), invoice.id);

  return res.status(201).json(invoice);
}

async function buildInvoiceLineItems(invoice) {
  const ledgerRows = await getLedgerEntriesForInvoice(invoice.id);
  const accountIds = [...new Set(ledgerRows.map((r) => r.related_account_id).filter((id) => id !== null))];
  const accountLabels = await findAccountLabelsByIds(accountIds);

  return ledgerRows.map((r) => ({
    date: formatDate(r.created_at),
    account: accountLabels[r.related_account_id] || EMPTY,
    amount: formatUsd(Math.abs(Number(r.amount_usd))),
  }));
}

function renderInvoicePdfToStream(stream, invoice, reseller, periodLabel, lineItems) {
  pdfInvoice.renderInvoicePdf(stream, { invoice, reseller, periodLabel, lineItems });
}

function buildPdfBuffer(invoice, reseller, periodLabel, lineItems) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    renderInvoicePdfToStream(stream, invoice, reseller, periodLabel, lineItems);
  });
}

async function getPdf(req, res) {
  const invoice = await getInvoiceById(req.params.id, req.scopeFilter);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // A reseller can only fetch the PDF once it's been sent - an unsent invoice
  // is admin-eyes-only, same as it can't yet appear in GET /api/invoices for them.
  if (!invoice.sent_at && req.admin.role !== 'admin') {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const reseller = await getResellerById(invoice.reseller_id);
  const periodLabel = periodLabelFor(invoice.period_type, invoice.period_value);
  const lineItems = await buildInvoiceLineItems(invoice);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.id}.pdf"`);
  renderInvoicePdfToStream(res, invoice, reseller, periodLabel, lineItems);
}

async function send(req, res) {
  const invoice = await getInvoiceById(req.params.id, {});
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (invoice.sent_at) {
    return res.status(400).json({ error: 'Invoice has already been sent' });
  }

  // Sending is locked until the period has actually finished - generation,
  // regeneration, and PDF preview (create()/getPdf() above) stay available
  // throughout the period; only the send/email action waits, so what gets
  // emailed reflects every renewal deduction that could still land in it.
  const cutoff = lastDayOfPeriod(resolvePeriod(invoice.period_type, invoice.period_value));
  if (todayDateOnly() < cutoff) {
    return res.status(400).json({
      error: `This invoice can't be sent until the period ends on ${formatDateOnly(cutoff)}.`,
    });
  }

  const reseller = await getResellerById(invoice.reseller_id);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  if (!reseller.email) {
    return res.status(400).json({ error: 'Reseller has no email on file' });
  }

  const periodLabel = periodLabelFor(invoice.period_type, invoice.period_value);
  const lineItems = await buildInvoiceLineItems(invoice);
  const pdfBuffer = await buildPdfBuffer(invoice, reseller, periodLabel, lineItems);

  try {
    await sendMail({
      to: reseller.email,
      subject: `Invoice for ${periodLabel} from SIP Admin Control`,
      text: `Your invoice for ${periodLabel}, totalling ${formatUsd(invoice.total_amount_usd)}, is attached.`,
      html: renderInvoiceIssuedHtml({
        resellerUsername: reseller.username,
        invoiceId: invoice.id,
        periodLabel,
        totalAmountUsd: invoice.total_amount_usd,
      }),
      attachments: [{ filename: `invoice-${invoice.id}.pdf`, content: pdfBuffer }],
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to send invoice email' });
  }

  await markInvoiceSent(invoice.id);

  await createNotification(
    reseller.id,
    'invoice_issued',
    `Invoice for ${periodLabel} issued`,
    `Your invoice for ${periodLabel}, totalling ${formatUsd(invoice.total_amount_usd)}, has been issued.`,
    { invoiceId: invoice.id, periodType: invoice.period_type, periodValue: invoice.period_value, totalAmountUsd: invoice.total_amount_usd }
  ).catch((err) => {
    console.error('Failed to create invoice_issued notification:', err);
  });

  const updated = await getInvoiceById(invoice.id, {});
  return res.json(updated);
}

async function list(req, res) {
  const { resellerId } = req.query;
  const isAdmin = req.admin.role === 'admin';
  const invoices = await listInvoices(req.scopeFilter, { resellerId, sentOnly: !isAdmin });
  return res.json(invoices);
}

module.exports = { create, getPdf, send, list };
