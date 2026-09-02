const {
  getAccountStats,
  getAccountCountsByReseller,
  getResellerStats,
  getResellerAccountAssignments,
} = require('../models/reportsModel');
const { findAdminUsernamesByIds, listResellers } = require('../models/adminModel');
const { parsePeriod } = require('../utils/reportPeriod');
const { renderReportPdf } = require('../utils/pdfReport');

function sendPdf(res, filename, options) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  renderReportPdf(res, { generatedAt: new Date(), ...options });
}

async function accountsReport(req, res) {
  const { error, start, end, label, slug } = parsePeriod(req.query);
  if (error) {
    return res.status(400).json({ error });
  }

  const stats = await getAccountStats(req.scopeFilter, start, end);

  let table = null;
  if (req.admin.role === 'admin') {
    const counts = await getAccountCountsByReseller(start, end);
    const usernameMap = await findAdminUsernamesByIds(
      counts.map((c) => c.creatorId).filter((id) => id !== null && id !== undefined)
    );
    const rows = counts
      .map((c) => ({
        reseller: usernameMap[c.creatorId] || `Reseller #${c.creatorId}`,
        count: c.count,
      }))
      .sort((a, b) => b.count - a.count);

    table = {
      title: 'Accounts Created by Reseller',
      columns: [
        { key: 'reseller', label: 'Reseller', align: 'left' },
        { key: 'count', label: 'Accounts Created', align: 'right' },
      ],
      rows,
    };
  }

  sendPdf(res, `account-report-${slug}.pdf`, {
    reportTitle: 'Account Management Report',
    periodLabel: label,
    stats: [
      { label: 'Total Accounts', value: stats.total },
      { label: 'Active', value: stats.active, tone: 'success' },
      { label: 'Disabled', value: stats.disabled, tone: 'neutral' },
      { label: 'Expired', value: stats.expired, tone: 'warning' },
      { label: 'Created in Period', value: stats.created_in_period },
      { label: 'Renewed in Period', value: stats.renewed_in_period },
    ],
    chart: [
      { label: 'Active', value: stats.active, tone: 'success' },
      { label: 'Expired', value: stats.expired, tone: 'warning' },
      { label: 'Disabled', value: stats.disabled, tone: 'neutral' },
    ],
    table,
  });
}

async function resellersReport(req, res) {
  const { error, start, end, label, slug } = parsePeriod(req.query);
  if (error) {
    return res.status(400).json({ error });
  }

  const stats = await getResellerStats(start, end);
  const resellers = await listResellers();
  const assignments = await getResellerAccountAssignments();
  const assignmentsById = new Map(assignments.map((a) => [a.creatorId, a]));

  const rows = resellers
    .map((reseller) => {
      const assigned = assignmentsById.get(reseller.id);
      return {
        reseller: reseller.username,
        total: assigned ? assigned.total : 0,
        active: assigned ? assigned.active : 0,
        disabled: assigned ? assigned.disabled : 0,
      };
    })
    .sort((a, b) => b.total - a.total);

  sendPdf(res, `reseller-report-${slug}.pdf`, {
    reportTitle: 'Reseller Management Report',
    periodLabel: label,
    stats: [
      { label: 'Total Resellers', value: stats.total },
      { label: 'Active', value: stats.active, tone: 'success' },
      { label: 'Disabled', value: stats.disabled, tone: 'neutral' },
      { label: 'Expired', value: stats.expired, tone: 'warning' },
      { label: 'Created in Period', value: stats.created_in_period },
    ],
    chart: [
      { label: 'Active', value: stats.active, tone: 'success' },
      { label: 'Expired', value: stats.expired, tone: 'warning' },
      { label: 'Disabled', value: stats.disabled, tone: 'neutral' },
    ],
    table: {
      title: 'Accounts Assigned per Reseller',
      columns: [
        { key: 'reseller', label: 'Reseller', align: 'left' },
        { key: 'total', label: 'Total Accounts', align: 'right' },
        { key: 'active', label: 'Active', align: 'right' },
        { key: 'disabled', label: 'Disabled', align: 'right' },
      ],
      rows,
    },
  });
}

module.exports = { accountsReport, resellersReport };
