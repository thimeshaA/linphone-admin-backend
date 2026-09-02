const { getAccountRows, getAccountCountsByReseller } = require('../models/reportsModel');
const { findAdminUsernamesByIds, listResellers } = require('../models/adminModel');
const { parsePeriod } = require('../utils/reportPeriod');
const pdfReport = require('../utils/pdfReport');

const EMPTY = '—';

function formatDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : EMPTY;
}

function sendPdf(res, filename, options) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  pdfReport.renderReportPdf(res, { generatedAt: new Date(), ...options });
}

const ACCOUNT_DETAIL_COLUMNS = [
  { key: 'id', label: 'ID', width: 32, align: 'right' },
  { key: 'authid', label: 'Auth ID', flex: 2, align: 'left' },
  { key: 'domain', label: 'Domain', flex: 2, align: 'left' },
  { key: 'email', label: 'Email', flex: 2, align: 'left' },
  { key: 'status', label: 'Status', width: 56, align: 'left' },
  { key: 'created_at', label: 'Created', width: 64, align: 'left' },
  { key: 'expires_at', label: 'Expires', width: 64, align: 'left' },
  { key: 'disabled_at', label: 'Disabled', width: 64, align: 'left' },
  { key: 'expired_at', label: 'Expired', width: 64, align: 'left' },
  { key: 'renewed_at', label: 'Renewed', width: 64, align: 'left' },
];

async function accountsReport(req, res) {
  const { error, start, end, label, slug } = parsePeriod(req.query);
  if (error) {
    return res.status(400).json({ error });
  }

  const accounts = await getAccountRows(req.scopeFilter, start, end);
  const isAdmin = req.admin.role === 'admin';

  let usernameMap = {};
  if (isAdmin) {
    const creatorIds = [...new Set(accounts.map((a) => a.creator_id).filter((id) => id !== null && id !== undefined))];
    usernameMap = await findAdminUsernamesByIds(creatorIds);
  }

  const detailRows = accounts.map((a) => ({
    id: a.id,
    authid: a.authid,
    domain: a.domain,
    email: a.email || EMPTY,
    status: a.status,
    created_at: formatDate(a.created_at),
    expires_at: formatDate(a.expires_at),
    disabled_at: formatDate(a.disabled_at),
    expired_at: formatDate(a.expired_at),
    renewed_at: formatDate(a.renewed_at),
    ...(isAdmin ? { created_by: usernameMap[a.creator_id] || `Reseller #${a.creator_id}` } : {}),
  }));

  const tables = [];

  if (isAdmin) {
    const countsByCreator = new Map();
    for (const a of accounts) {
      countsByCreator.set(a.creator_id, (countsByCreator.get(a.creator_id) || 0) + 1);
    }
    const summaryRows = [...countsByCreator.entries()]
      .map(([creatorId, count]) => ({ reseller: usernameMap[creatorId] || `Reseller #${creatorId}`, count }))
      .sort((a, b) => b.count - a.count);

    tables.push({
      title: 'Accounts Created by Reseller',
      columns: [
        { key: 'reseller', label: 'Reseller', flex: 1, align: 'left' },
        { key: 'count', label: 'Accounts Created', width: 130, align: 'right' },
      ],
      rows: summaryRows,
    });
  }

  tables.push({
    title: 'Accounts',
    columns: isAdmin
      ? [...ACCOUNT_DETAIL_COLUMNS, { key: 'created_by', label: 'Created By', flex: 1.5, align: 'left' }]
      : ACCOUNT_DETAIL_COLUMNS,
    rows: detailRows,
  });

  sendPdf(res, `account-report-${slug}.pdf`, {
    reportTitle: 'Account Management Report',
    periodLabel: label,
    tables,
  });
}

async function resellersReport(req, res) {
  const { error, start, end, label, slug } = parsePeriod(req.query);
  if (error) {
    return res.status(400).json({ error });
  }

  const [resellers, counts] = await Promise.all([listResellers(), getAccountCountsByReseller(start, end)]);
  const countsById = new Map(counts.map((c) => [c.creatorId, c.count]));

  const rows = resellers
    .map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email || EMPTY,
      status: r.status,
      created_at: formatDate(r.created_at),
      expires_at: formatDate(r.expires_at),
      expired_at: formatDate(r.expired_at),
      accounts_created: countsById.get(r.id) || 0,
    }))
    .sort((a, b) => b.accounts_created - a.accounts_created);

  sendPdf(res, `reseller-report-${slug}.pdf`, {
    reportTitle: 'Reseller Management Report',
    periodLabel: label,
    tables: [
      {
        title: 'Resellers',
        columns: [
          { key: 'id', label: 'ID', width: 36, align: 'right' },
          { key: 'username', label: 'Username', flex: 2, align: 'left' },
          { key: 'email', label: 'Email', flex: 2, align: 'left' },
          { key: 'status', label: 'Status', width: 60, align: 'left' },
          { key: 'created_at', label: 'Created', width: 68, align: 'left' },
          { key: 'expires_at', label: 'Expires', width: 68, align: 'left' },
          { key: 'expired_at', label: 'Expired', width: 68, align: 'left' },
          { key: 'accounts_created', label: 'Accounts Created', width: 120, align: 'right' },
        ],
        rows,
      },
    ],
  });
}

module.exports = { accountsReport, resellersReport };
