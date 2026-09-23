const { getAccountRows, getAccountCreationCounts } = require('../models/reportsModel');
const { findAdminUsernamesByIds, listResellers } = require('../models/adminModel');
const {
  getLedgerTotalsByType,
  getLedgerTotalsByTypeAndReseller,
  getBalanceAsOf,
  getBalancesAsOfByReseller,
  getLedgerEntriesInPeriod,
} = require('../models/walletLedgerModel');
const { parsePeriod } = require('../utils/reportPeriod');
const pdfReport = require('../utils/pdfReport');

const EMPTY = '-';
const TOP_RESELLERS_LIMIT = 10;

// Neither auth_users.status nor admins.status is ever lazily flipped to
// "expired" outside of reseller login (see markResellerExpired) - so status
// pills/charts are classified live from expires_at, same 3-way split as the
// frontend dashboard's "Active / Expiring ≤30 days / Disabled / expired"
// stat cards, rather than trusting the stored status column.
const EXPIRING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function classifyStatus(row, now) {
  if (row.status === 'disabled') return { label: 'Disabled', tone: 'neutral' };
  if (row.expires_at) {
    const expiresAt = new Date(row.expires_at);
    if (expiresAt <= now) return { label: 'Disabled', tone: 'neutral' };
    if (expiresAt - now <= EXPIRING_WINDOW_MS) return { label: 'Expiring', tone: 'warning' };
  }
  return { label: 'Active', tone: 'success' };
}

function summarizeStatuses(rows, now) {
  const counts = { active: 0, expiring: 0, disabledOrExpired: 0 };
  for (const row of rows) {
    const tone = classifyStatus(row, now).tone;
    if (tone === 'success') counts.active++;
    else if (tone === 'warning') counts.expiring++;
    else counts.disabledOrExpired++;
  }
  return counts;
}

function statusDonutSegments(counts) {
  return [
    { label: 'Active', value: counts.active, tone: 'success' },
    { label: 'Expiring Soon', value: counts.expiring, tone: 'warning' },
    { label: 'Disabled / Expired', value: counts.disabledOrExpired, tone: 'neutral' },
  ];
}

function formatDate(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : EMPTY;
}

function sendPdf(res, filename, options) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  pdfReport.renderReportPdf(res, { generatedAt: new Date(), ...options });
}

// Deterministic "{report-type}-{scope}-{period}.pdf" name shared by both report
// endpoints, so the convention can't drift between them. Scope is "platform"
// for admins (platform-wide data) or the reseller's own username, sanitized to
// lowercase alphanumerics only, so it's always a safe Content-Disposition token.
function reportFilename(reportType, req, slug) {
  const scope = req.admin.role === 'admin' ? 'platform' : req.admin.username.toLowerCase().replace(/[^a-z0-9]/g, '');
  return `${reportType}-${scope}-${slug}.pdf`;
}

// This table renders on a landscape page (see sectionNeedsLandscape in
// pdfReport.js) — the rest of the report is portrait A4, but 11 columns of
// real data don't fit legibly in portrait's ~495pt content width.
const ACCOUNT_DETAIL_COLUMNS = [
  { key: 'id', label: 'ID', width: 32, align: 'right' },
  { key: 'authid', label: 'Auth ID', flex: 2, align: 'left' },
  { key: 'domain', label: 'Domain', flex: 2, align: 'left' },
  { key: 'email', label: 'Email', flex: 2, align: 'left' },
  { key: 'status', label: 'Status', width: 70, align: 'left', badge: true },
  { key: 'created_at', label: 'Created', width: 64, align: 'left' },
  { key: 'expires_at', label: 'Expires', width: 64, align: 'left' },
  { key: 'disabled_at', label: 'Disabled', width: 64, align: 'left' },
  { key: 'expired_at', label: 'Expired', width: 64, align: 'left' },
  { key: 'renewed_at', label: 'Renewed', width: 64, align: 'left' },
];
const CREATED_BY_COLUMN = { key: 'created_by', label: 'Created By', flex: 1.5, align: 'left' };

function buildAccountRow(a, now) {
  return {
    id: a.id,
    authid: a.authid,
    domain: a.domain,
    email: a.email || EMPTY,
    status: classifyStatus(a, now),
    created_at: formatDate(a.created_at),
    expires_at: formatDate(a.expires_at),
    disabled_at: formatDate(a.disabled_at),
    expired_at: formatDate(a.expired_at),
    renewed_at: formatDate(a.renewed_at),
  };
}

function withCreatedBy(row, account, usernameMap) {
  return { ...row, created_by: usernameMap[account.creator_id] || `Reseller #${account.creator_id}` };
}

async function usernamesForAccounts(accounts) {
  const creatorIds = [...new Set(accounts.map((a) => a.creator_id).filter((id) => id !== null && id !== undefined))];
  return findAdminUsernamesByIds(creatorIds);
}

function countByCreator(accounts) {
  const counts = new Map();
  for (const a of accounts) {
    counts.set(a.creator_id, (counts.get(a.creator_id) || 0) + 1);
  }
  return counts;
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

// One bucket key per day of the report's month (monthly reports) or per
// month of the report's year (annual reports), so the timeline chart always
// shows every slot in the period - including ones the count query has no
// row for - rather than only the days/months that had at least one account.
function buildTimelineBuckets(periodType, start) {
  const year = start.getFullYear();
  if (periodType === 'monthly') {
    const month = start.getMonth(); // 0-indexed
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      return { key: `${year}-${pad2(month + 1)}-${pad2(day)}`, label: String(day) };
    });
  }

  return Array.from({ length: 12 }, (_, i) => ({ key: `${year}-${pad2(i + 1)}`, label: MONTH_ABBR[i] }));
}

function buildTimelineSeries(buckets, counts) {
  const countMap = new Map(counts.map((c) => [c.bucket, Number(c.count)]));
  return buckets.map((b) => ({ label: b.label, value: countMap.get(b.key) || 0 }));
}

// ---------------------------------------------------------------------------
// Billing section (Phase 5) - pulled directly from wallet_ledger/invoices for
// the report's period, never re-derived from some other computed figure, so
// it can't drift from what those tables actually contain.
// ---------------------------------------------------------------------------

// Negative balances render as "-$50.00", not "$-50.00" - the sign belongs
// outside the currency symbol.
function formatUsd(amount) {
  const n = Number(amount);
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`;
}

// Same as formatUsd but always signed (e.g. "+$30.00" / "-$5.00") - used for
// individual statement line items, where the sign is the whole point of the
// column (a credit vs. a deduction), unlike a balance which just happens to
// be negative or positive.
function formatSignedUsd(amount) {
  const n = Number(amount);
  return n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `+$${n.toFixed(2)}`;
}

// wallet_ledger.type -> the two report figures they roll up into. Deductions
// are stored negative (see applyRenewalDeduction in accountsController), so
// "total deducted" is the absolute value. Top-up is the only credit type
// (Phase 4 corrected: payments and top-ups are the same admin action, and
// there's no separate payment_received type any more).
function summarizeLedgerTotals(rows) {
  const byType = Object.fromEntries(rows.map((r) => [r.type, Number(r.total)]));
  return {
    credited: (byType.initial_credit || 0) + (byType.admin_topup || 0),
    deducted: Math.abs(byType.renewal_deduction || 0),
  };
}

// Every billing figure is derived from wallet_ledger - the append-only real
// record - rather than the wallets.balance_usd snapshot column, so a report
// can never disagree with itself (or need a wallets row to exist at all: a
// reseller with real ledger activity but no backfilled wallets row still
// gets a correct "owed" figure here). "Owed" is intentionally a *current*
// (as of now), not period-end, snapshot - the other figures describe what
// happened during the period, but "owed" is "how much do they owe today".
//
// Platform-wide (scopeFilter without creator_id), "owed" sums only the
// resellers who are actually in debt right now - never netting one
// reseller's credit balance against another's debt, which a single combined
// getBalanceAsOf({}, now) would silently do.
async function getBillingTotals(scopeFilter, start, end) {
  const isSingleReseller = Boolean(scopeFilter && scopeFilter.creator_id !== undefined);

  const [ledgerRows, balanceAtEnd, owed] = await Promise.all([
    getLedgerTotalsByType(scopeFilter, start, end),
    getBalanceAsOf(scopeFilter, end),
    isSingleReseller
      ? getBalanceAsOf(scopeFilter, new Date()).then((b) => (Number(b) < 0 ? Math.abs(Number(b)) : 0))
      : getBalancesAsOfByReseller(new Date()).then((rows) =>
          rows.reduce((sum, r) => sum + (Number(r.balance) < 0 ? Math.abs(Number(r.balance)) : 0), 0)
        ),
  ]);

  const { credited, deducted } = summarizeLedgerTotals(ledgerRows);

  return {
    balanceAtPeriodEnd: Number(balanceAtEnd),
    credited,
    deducted,
    owed,
  };
}

function billingKpiSection(totals) {
  return {
    title: 'Billing',
    kind: 'kpis',
    stats: [
      { label: 'Wallet Balance (Period End)', value: formatUsd(totals.balanceAtPeriodEnd) },
      { label: 'Total Credited', value: formatUsd(totals.credited) },
      { label: 'Total Deducted', value: formatUsd(totals.deducted) },
      { label: 'Amount Owed', value: formatUsd(totals.owed) },
    ],
  };
}

const BILLING_TABLE_COLUMNS = [
  { key: 'reseller', label: 'Reseller', flex: 2, align: 'left' },
  { key: 'balance_period_end', label: 'Balance (Period End)', width: 110, align: 'right' },
  { key: 'credited', label: 'Credited', width: 90, align: 'right' },
  { key: 'deducted', label: 'Deducted', width: 90, align: 'right' },
  { key: 'owed', label: 'Owed', width: 80, align: 'right' },
];

function billingRow(label, totals) {
  return {
    reseller: label,
    balance_period_end: formatUsd(totals.balanceAtPeriodEnd),
    credited: formatUsd(totals.credited),
    deducted: formatUsd(totals.deducted),
    owed: formatUsd(totals.owed),
  };
}

// Admin-only per-reseller billing breakdown (reseller report), plus a
// platform-wide total row. The per-reseller rows are assembled from the bulk
// *ByReseller queries (one round trip each, not one per reseller); the total
// row is computed by the same getBillingTotals() the account report's
// platform-wide KPIs use, rather than re-summing the per-reseller rows, so
// the two reports can never disagree about the platform total.
async function buildBillingTableSection(resellers, start, end) {
  const [ledgerByReseller, balancesByReseller, currentBalancesByReseller, platformTotals] = await Promise.all([
    getLedgerTotalsByTypeAndReseller(start, end),
    getBalancesAsOfByReseller(end),
    getBalancesAsOfByReseller(new Date()),
    getBillingTotals({}, start, end),
  ]);

  const ledgerMap = new Map();
  for (const row of ledgerByReseller) {
    if (!ledgerMap.has(row.reseller_id)) ledgerMap.set(row.reseller_id, []);
    ledgerMap.get(row.reseller_id).push(row);
  }
  const balanceAtEndMap = new Map(balancesByReseller.map((r) => [r.reseller_id, Number(r.balance)]));
  const currentBalanceMap = new Map(currentBalancesByReseller.map((r) => [r.reseller_id, Number(r.balance)]));

  const rows = resellers.map((r) => {
    const { credited, deducted } = summarizeLedgerTotals(ledgerMap.get(r.id) || []);
    const currentBalance = currentBalanceMap.get(r.id) || 0;
    const totals = {
      balanceAtPeriodEnd: balanceAtEndMap.get(r.id) || 0,
      credited,
      deducted,
      owed: currentBalance < 0 ? Math.abs(currentBalance) : 0,
    };
    return billingRow(r.username, totals);
  });

  rows.push(billingRow('Platform Total', platformTotals));

  return {
    title: 'Billing',
    kind: 'table',
    columns: BILLING_TABLE_COLUMNS,
    rows,
  };
}

const LEDGER_TYPE_LABELS = {
  initial_credit: 'Initial Credit',
  admin_topup: 'Top-Up',
  renewal_deduction: 'Renewal Deduction',
};

function billingStatementColumns(includeReseller) {
  const columns = [
    { key: 'date', label: 'Date', width: 68, align: 'left' },
    { key: 'type', label: 'Type', width: 100, align: 'left' },
    { key: 'description', label: 'Description', flex: 2, align: 'left' },
    { key: 'amount', label: 'Amount', width: 80, align: 'right' },
    { key: 'balance', label: 'Balance', width: 80, align: 'right' },
  ];
  if (includeReseller) {
    columns.splice(1, 0, { key: 'reseller', label: 'Reseller', flex: 1.3, align: 'left' });
  }
  return columns;
}

// A real itemized statement, not just the KPIs/table above: every
// wallet_ledger row in this scope+period, oldest first, with a running
// balance - so the ending figure is always traceable back to actual rows,
// never a separately-computed number that could silently drift from what's
// shown here. Platform-wide (admin) statements track the running balance per
// reseller (seeded from that reseller's own balance as of the period start),
// since a single combined running total across different wallets wouldn't
// mean anything.
async function buildBillingStatementSection(scopeFilter, resellerId, start, end) {
  const entries = await getLedgerEntriesInPeriod(scopeFilter, start, end);
  const includeReseller = !resellerId;

  let usernameMap = {};
  let runningByReseller;
  let runningSingle;
  if (includeReseller) {
    const [openings, names] = await Promise.all([
      getBalancesAsOfByReseller(start),
      findAdminUsernamesByIds([...new Set(entries.map((e) => e.reseller_id))]),
    ]);
    runningByReseller = new Map(openings.map((r) => [r.reseller_id, Number(r.balance)]));
    usernameMap = names;
  } else {
    runningSingle = Number(await getBalanceAsOf(scopeFilter, start));
  }

  const rows = entries.map((e) => {
    const amount = Number(e.amount_usd);
    let balance;
    if (includeReseller) {
      const previous = runningByReseller.get(e.reseller_id) || 0;
      balance = previous + amount;
      runningByReseller.set(e.reseller_id, balance);
    } else {
      runningSingle += amount;
      balance = runningSingle;
    }

    const row = {
      date: formatDate(e.created_at),
      type: LEDGER_TYPE_LABELS[e.type] || e.type,
      description: e.account_sip_id || e.note || EMPTY,
      amount: formatSignedUsd(amount),
      balance: formatUsd(balance),
    };
    if (includeReseller) {
      row.reseller = usernameMap[e.reseller_id] || `Reseller #${e.reseller_id}`;
    }
    return row;
  });

  return {
    title: 'Billing Statement',
    kind: 'table',
    columns: billingStatementColumns(includeReseller),
    rows,
  };
}

async function accountsReport(req, res) {
  const { error, start, end, label, slug } = parsePeriod(req.query);
  if (error) {
    return res.status(400).json({ error });
  }

  const now = new Date();
  const bucketUnit = req.query.period === 'monthly' ? 'day' : 'month';
  const [accounts, creationCounts] = await Promise.all([
    getAccountRows(req.scopeFilter, start, end),
    getAccountCreationCounts(req.scopeFilter, start, end, bucketUnit),
  ]);
  const isAdmin = req.admin.role === 'admin';

  const usernameMap = isAdmin ? await usernamesForAccounts(accounts) : {};
  const statusCounts = summarizeStatuses(accounts, now);
  const timelinePoints = buildTimelineSeries(buildTimelineBuckets(req.query.period, start), creationCounts);
  const resellerId = isAdmin ? null : req.admin.id;
  const [billingTotals, billingStatementSection] = await Promise.all([
    getBillingTotals(req.scopeFilter, start, end),
    buildBillingStatementSection(req.scopeFilter, resellerId, start, end),
  ]);

  const detailRows = accounts.map((a) => {
    const row = buildAccountRow(a, now);
    return isAdmin ? withCreatedBy(row, a, usernameMap) : row;
  });

  const sections = [
    {
      title: 'Summary',
      kind: 'kpis',
      stats: [
        { label: 'Accounts Created', value: accounts.length },
        { label: 'Active', value: statusCounts.active },
        { label: 'Expiring Soon', value: statusCounts.expiring },
        { label: 'Disabled / Expired', value: statusCounts.disabledOrExpired },
      ],
    },
    {
      title: 'Status Breakdown',
      kind: 'donut-and-timeline',
      segments: statusDonutSegments(statusCounts),
      timeline: { points: timelinePoints },
    },
    billingKpiSection(billingTotals),
    billingStatementSection,
  ];

  if (isAdmin) {
    const summaryRows = [...countByCreator(accounts).entries()]
      .map(([creatorId, count]) => ({ reseller: usernameMap[creatorId] || `Reseller #${creatorId}`, count }))
      .sort((a, b) => b.count - a.count);

    // Bar chart only (no table underneath): the chart already labels every
    // reseller with its count, so a flat table of the same two columns would
    // just repeat it. Unlike the "Top Resellers" bar in the resellers report
    // (which highlights a top-10 above a richer table), this is the only
    // place this breakdown appears, so every reseller gets a bar - not just
    // the top 10.
    sections.push({
      title: 'Reseller Breakdown',
      kind: 'bar-and-table',
      bars: summaryRows.map((r) => ({ label: r.reseller, value: r.count })),
    });
  }

  sections.push({
    title: 'Account Detail',
    kind: 'table',
    columns: isAdmin ? [...ACCOUNT_DETAIL_COLUMNS, CREATED_BY_COLUMN] : ACCOUNT_DETAIL_COLUMNS,
    rows: detailRows,
  });

  sendPdf(res, reportFilename('account-report', req, slug), {
    reportTitle: 'Account Management Report',
    periodLabel: label,
    sections,
  });
}

async function resellersReport(req, res) {
  const { error, start, end, label, slug } = parsePeriod(req.query);
  if (error) {
    return res.status(400).json({ error });
  }

  const now = new Date();
  // Unscoped (admin-only endpoint): every account created in the period,
  // across every reseller, backs both the per-reseller counts below and the
  // full account-level detail table.
  const [resellers, accounts] = await Promise.all([listResellers(), getAccountRows({}, start, end)]);
  const usernameMap = await usernamesForAccounts(accounts);
  const counts = countByCreator(accounts);
  const resellerStatusCounts = summarizeStatuses(resellers, now);

  const resellerRows = resellers
    .map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email || EMPTY,
      status: classifyStatus(r, now),
      created_at: formatDate(r.created_at),
      expires_at: formatDate(r.expires_at),
      expired_at: formatDate(r.expired_at),
      accounts_created: counts.get(r.id) || 0,
    }))
    .sort((a, b) => b.accounts_created - a.accounts_created);

  const accountRows = accounts.map((a) => withCreatedBy(buildAccountRow(a, now), a, usernameMap));
  const [billingSection, billingStatementSection] = await Promise.all([
    buildBillingTableSection(resellers, start, end),
    buildBillingStatementSection({}, null, start, end),
  ]);

  sendPdf(res, reportFilename('reseller-report', req, slug), {
    reportTitle: 'Reseller Management Report',
    periodLabel: label,
    sections: [
      {
        title: 'Summary',
        kind: 'kpis',
        stats: [
          { label: 'Total Resellers', value: resellers.length },
          { label: 'Active', value: resellerStatusCounts.active },
          { label: 'Expiring Soon', value: resellerStatusCounts.expiring },
          { label: 'Disabled / Expired', value: resellerStatusCounts.disabledOrExpired },
          { label: 'Accounts Created', value: accounts.length },
        ],
      },
      {
        title: 'Status Breakdown',
        kind: 'donut',
        segments: statusDonutSegments(resellerStatusCounts),
      },
      {
        title: 'Top Resellers',
        kind: 'bar-and-table',
        bars: resellerRows.slice(0, TOP_RESELLERS_LIMIT).map((r) => ({ label: r.username, value: r.accounts_created })),
        table: {
          title: 'Resellers',
          columns: [
            { key: 'id', label: 'ID', width: 36, align: 'right' },
            { key: 'username', label: 'Username', flex: 2, align: 'left' },
            { key: 'email', label: 'Email', flex: 2, align: 'left' },
            { key: 'status', label: 'Status', width: 70, align: 'left', badge: true },
            { key: 'created_at', label: 'Created', width: 68, align: 'left' },
            { key: 'expires_at', label: 'Expires', width: 68, align: 'left' },
            { key: 'expired_at', label: 'Expired', width: 68, align: 'left' },
            { key: 'accounts_created', label: 'Accounts Created', width: 120, align: 'right' },
          ],
          rows: resellerRows,
        },
      },
      billingSection,
      billingStatementSection,
      {
        title: 'Account Detail',
        kind: 'table',
        columns: [...ACCOUNT_DETAIL_COLUMNS, CREATED_BY_COLUMN],
        rows: accountRows,
      },
    ],
  });
}

module.exports = { accountsReport, resellersReport };
