const { PassThrough } = require('stream');
const { getResellerById } = require('../models/adminModel');
const { findAccountLabelsByIds } = require('../models/accountModel');
const { getUninvoicedRenewalDeductionsInPeriod, linkLedgerEntriesToInvoice, getLedgerEntriesForInvoice } = require('../models/walletLedgerModel');
const { findInvoiceByResellerAndPeriod, createInvoice, getInvoiceById, listInvoices, markInvoiceSent } = require('../models/invoiceModel');
const { createNotification } = require('../models/notificationModel');
const { sendMail } = require('../utils/mailer');
const { renderInvoiceIssuedHtml } = require('../utils/emailTemplates');
const { parsePeriod } = require('../utils/reportPeriod');
const pdfReport = require('../utils/pdfReport');

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

  // An invoice is one document per reseller per exact period - re-running the
  // same period must never create a duplicate (or worse, an empty one, since
  // by then every entry in it would already be `invoiced`). Reject instead of
  // silently recomputing so the admin sees exactly why nothing new happened.
  const existing = await findInvoiceByResellerAndPeriod(resellerId, periodType, periodValue);
  if (existing) {
    return res.status(409).json({
      error: 'An invoice already exists for this reseller and period',
      invoice: existing,
    });
  }

  const entries = await getUninvoicedRenewalDeductionsInPeriod(resellerId, period.start, period.end);
  // amount_usd is stored negative for deductions (see applyRenewalDeduction);
  // the invoice total owed is the positive sum.
  const totalAmountUsd = entries.reduce((sum, e) => sum - Number(e.amount_usd), 0);

  const invoice = await createInvoice({ resellerId, periodType, periodValue, totalAmountUsd });
  await linkLedgerEntriesToInvoice(entries.map((e) => e.id), invoice.id);

  return res.status(201).json(invoice);
}

async function buildInvoiceSections(invoice, reseller, periodLabel) {
  const ledgerRows = await getLedgerEntriesForInvoice(invoice.id);
  const accountIds = [...new Set(ledgerRows.map((r) => r.related_account_id).filter((id) => id !== null))];
  const accountLabels = await findAccountLabelsByIds(accountIds);

  const lineItems = ledgerRows.map((r) => ({
    date: formatDate(r.created_at),
    account: accountLabels[r.related_account_id] || EMPTY,
    amount: formatUsd(Math.abs(Number(r.amount_usd))),
  }));

  return [
    {
      title: 'Invoice Summary',
      kind: 'kpis',
      stats: [
        { label: 'Reseller', value: reseller ? reseller.username : `Reseller #${invoice.reseller_id}` },
        { label: 'Period', value: periodLabel },
        { label: 'Total Owed', value: formatUsd(invoice.total_amount_usd) },
      ],
    },
    {
      title: 'Line Items',
      kind: 'table',
      columns: [
        { key: 'date', label: 'Date', width: 100, align: 'left' },
        { key: 'account', label: 'Account', flex: 2, align: 'left' },
        { key: 'amount', label: 'Amount', width: 100, align: 'right' },
      ],
      rows: lineItems,
    },
  ];
}

function renderInvoicePdfToStream(stream, invoice, periodLabel, sections) {
  pdfReport.renderReportPdf(stream, {
    reportTitle: `Invoice #${invoice.id}`,
    periodLabel,
    generatedAt: new Date(),
    sections,
  });
}

function buildPdfBuffer(invoice, periodLabel, sections) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    renderInvoicePdfToStream(stream, invoice, periodLabel, sections);
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
  const sections = await buildInvoiceSections(invoice, reseller, periodLabel);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.id}.pdf"`);
  renderInvoicePdfToStream(res, invoice, periodLabel, sections);
}

async function send(req, res) {
  const invoice = await getInvoiceById(req.params.id, {});
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (invoice.sent_at) {
    return res.status(400).json({ error: 'Invoice has already been sent' });
  }

  const reseller = await getResellerById(invoice.reseller_id);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  if (!reseller.email) {
    return res.status(400).json({ error: 'Reseller has no email on file' });
  }

  const periodLabel = periodLabelFor(invoice.period_type, invoice.period_value);
  const sections = await buildInvoiceSections(invoice, reseller, periodLabel);
  const pdfBuffer = await buildPdfBuffer(invoice, periodLabel, sections);

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
