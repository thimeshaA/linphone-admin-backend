const { PassThrough } = require('stream');
const { getResellerById } = require('../models/adminModel');
const { findAccountLabelsByIds } = require('../models/accountModel');
const { adjustWalletBalance } = require('../models/walletModel');
const {
  createLedgerEntry,
  listUninvoicedRenewalDeductions,
  getLedgerEntriesByIds,
  linkLedgerEntriesToInvoice,
  getLedgerEntriesForInvoice,
  sumPaymentsForInvoice,
} = require('../models/walletLedgerModel');
const {
  createInvoice,
  getInvoiceById,
  listInvoices,
  markInvoiceSent,
  updateInvoiceStatus,
} = require('../models/invoiceModel');
const { createNotification } = require('../models/notificationModel');
const { sendMail } = require('../utils/mailer');
const { renderInvoiceIssuedHtml } = require('../utils/emailTemplates');
const pdfReport = require('../utils/pdfReport');

const EMPTY = '-';

function formatUsd(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

function formatDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : EMPTY;
}

async function getUninvoiced(req, res) {
  const reseller = await getResellerById(req.params.id);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  const entries = await listUninvoicedRenewalDeductions(req.params.id);
  return res.json({ resellerId: reseller.id, entries });
}

async function create(req, res) {
  const { resellerId, ledgerEntryIds } = req.body;

  if (!Array.isArray(ledgerEntryIds) || ledgerEntryIds.length === 0) {
    return res.status(400).json({ error: 'ledgerEntryIds must be a non-empty array' });
  }

  const reseller = await getResellerById(resellerId);
  if (!reseller) {
    return res.status(400).json({ error: 'resellerId does not reference an existing reseller' });
  }

  const entries = await getLedgerEntriesByIds(ledgerEntryIds);
  const entriesById = new Map(entries.map((e) => [e.id, e]));

  const allValid = ledgerEntryIds.every((id) => {
    const entry = entriesById.get(id);
    return (
      entry &&
      Number(entry.reseller_id) === Number(resellerId) &&
      entry.type === 'renewal_deduction' &&
      !entry.invoiced
    );
  });

  if (!allValid) {
    return res.status(400).json({
      error: 'ledgerEntryIds must reference uninvoiced renewal_deduction entries belonging to this reseller',
    });
  }

  // amount_usd is stored negative for deductions (see applyRenewalDeduction);
  // the invoice total due is the positive sum.
  const totalAmountUsd = ledgerEntryIds.reduce((sum, id) => sum - Number(entriesById.get(id).amount_usd), 0);

  const invoice = await createInvoice({ resellerId, totalAmountUsd });
  await linkLedgerEntriesToInvoice(ledgerEntryIds, invoice.id);

  return res.status(201).json(invoice);
}

async function buildInvoiceSections(invoice, reseller) {
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
        { label: 'Invoice Date', value: formatDate(invoice.created_at) },
        { label: 'Total Due', value: formatUsd(invoice.total_amount_usd) },
        { label: 'Status', value: invoice.status },
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
    {
      title: 'Payment',
      kind: 'text',
      text:
        'This invoice is settled manually. Payment is recorded by our team once received - no online payment link is provided.',
    },
  ];
}

function renderInvoicePdfToStream(stream, invoice, sections) {
  pdfReport.renderReportPdf(stream, {
    reportTitle: `Invoice #${invoice.id}`,
    periodLabel: formatDate(invoice.created_at),
    generatedAt: new Date(),
    sections,
  });
}

function buildPdfBuffer(invoice, sections) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    renderInvoicePdfToStream(stream, invoice, sections);
  });
}

async function getPdf(req, res) {
  const invoice = await getInvoiceById(req.params.id, req.scopeFilter);
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  // A reseller can only fetch the PDF once it's been sent - a draft is
  // admin-eyes-only, same as it can't yet appear in GET /api/invoices for them.
  if (invoice.status === 'draft' && req.admin.role !== 'admin') {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  const reseller = await getResellerById(invoice.reseller_id);
  const sections = await buildInvoiceSections(invoice, reseller);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="invoice-${invoice.id}.pdf"`);
  renderInvoicePdfToStream(res, invoice, sections);
}

async function send(req, res) {
  const invoice = await getInvoiceById(req.params.id, {});
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  if (invoice.status !== 'draft') {
    return res.status(400).json({ error: 'Only draft invoices can be sent' });
  }

  const reseller = await getResellerById(invoice.reseller_id);
  if (!reseller) {
    return res.status(404).json({ error: 'Reseller not found' });
  }

  if (!reseller.email) {
    return res.status(400).json({ error: 'Reseller has no email on file' });
  }

  const sections = await buildInvoiceSections(invoice, reseller);
  const pdfBuffer = await buildPdfBuffer(invoice, sections);

  try {
    await sendMail({
      to: reseller.email,
      subject: `Invoice #${invoice.id} from SIP Admin Control`,
      text: `Your invoice #${invoice.id} for ${formatUsd(invoice.total_amount_usd)} is attached.`,
      html: renderInvoiceIssuedHtml({
        resellerUsername: reseller.username,
        invoiceId: invoice.id,
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
    `Invoice #${invoice.id} issued`,
    `Invoice #${invoice.id} for ${formatUsd(invoice.total_amount_usd)} has been issued.`,
    { invoiceId: invoice.id, totalAmountUsd: invoice.total_amount_usd }
  ).catch((err) => {
    console.error('Failed to create invoice_issued notification:', err);
  });

  const updated = await getInvoiceById(invoice.id, {});
  return res.json(updated);
}

async function recordPayment(req, res) {
  const { amountPaid, note } = req.body;

  if (typeof amountPaid !== 'number' || !Number.isFinite(amountPaid) || amountPaid <= 0) {
    return res.status(400).json({ error: 'amountPaid must be a positive number' });
  }

  const invoice = await getInvoiceById(req.params.id, {});
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }

  await adjustWalletBalance(invoice.reseller_id, amountPaid);
  await createLedgerEntry({
    resellerId: invoice.reseller_id,
    type: 'payment_received',
    amountUsd: amountPaid,
    invoiceId: invoice.id,
    createdBy: req.admin.id,
    note: note || null,
  });

  // Cumulative payments are summed live from the ledger (not tracked as a
  // separate counter on the invoice row) so status can never drift out of
  // sync across repeated partial `payment` calls.
  const totalPaid = await sumPaymentsForInvoice(invoice.id);
  const newStatus = Number(totalPaid) >= Number(invoice.total_amount_usd) ? 'paid' : 'partially_paid';
  await updateInvoiceStatus(invoice.id, newStatus);

  await createNotification(
    invoice.reseller_id,
    'payment_recorded',
    `Payment recorded for Invoice #${invoice.id}`,
    `A payment of ${formatUsd(amountPaid)} was recorded against invoice #${invoice.id}. Status: ${newStatus}.`,
    { invoiceId: invoice.id, amountPaid, status: newStatus }
  ).catch((err) => {
    console.error('Failed to create payment_recorded notification:', err);
  });

  const updated = await getInvoiceById(invoice.id, {});
  return res.json(updated);
}

async function list(req, res) {
  const { resellerId, status } = req.query;
  const invoices = await listInvoices(req.scopeFilter, { resellerId, status });
  return res.json(invoices);
}

module.exports = { getUninvoiced, create, getPdf, send, recordPayment, list };
