// HTML shells for transactional emails, styled to match the Admin Control
// frontend's brand (the lime "AC" mark, and the SIP/eSIM accent colours used
// for module tags across the app). Table-based markup with inline styles
// only — no <style> block reliance — since Outlook and a lot of mobile mail
// clients strip or ignore embedded stylesheets.

const BRAND = {
  pageBg: '#f4f4f5',
  card: '#ffffff',
  border: '#e4e4e7',
  ink: '#0a0a0a',
  body: '#3f3f46',
  muted: '#71717a',
  accent: '#b7f211', // --success, the lime brand accent used on the "AC" mark
  accentInk: '#0a0a0a',
  sip: '#ee7c43', // --sip
  esim: '#0d9488', // darker teal, not the raw --esim cyan — stays legible as text/pill on a white card
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function moduleColor(module) {
  if (module === 'sip') return BRAND.sip;
  if (module === 'esim') return BRAND.esim;
  return BRAND.accent;
}

function formatSubmittedAt(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function detailRow(label, value) {
  if (!value) return '';
  return `
    <tr>
      <td style="padding:11px 0;border-top:1px solid ${BRAND.border};font:12px/1.4 ${FONT};color:${BRAND.muted};text-transform:uppercase;letter-spacing:.05em;width:132px;vertical-align:top;white-space:nowrap;">${escapeHtml(label)}</td>
      <td style="padding:11px 0 11px 16px;border-top:1px solid ${BRAND.border};font:14px/1.55 ${FONT};color:${BRAND.ink};vertical-align:top;">${escapeHtml(value)}</td>
    </tr>`;
}

/**
 * @param {object} opts
 * @param {"sip"|"esim"} opts.module
 * @param {string} opts.preheader - short hidden preview text (inbox summary line)
 * @param {string} opts.eyebrow - small pill above the heading, e.g. "Reseller application"
 * @param {string} opts.title
 * @param {string[]} opts.intro - paragraphs, pre-escaped/formatted HTML strings
 * @param {string} opts.rowsHtml - pre-built <tr> markup from detailRow()
 * @param {string} opts.footerNote
 */
function renderEmailShell({ module, preheader, eyebrow, title, intro, rowsHtml, footerNote }) {
  const accent = moduleColor(module);
  const introHtml = intro
    .map((p) => `<p style="margin:0 0 12px 0;font:14px/1.6 ${FONT};color:${BRAND.body};">${p}</p>`)
    .join('');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:${BRAND.pageBg};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.pageBg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${BRAND.card};border-radius:16px;border:1px solid ${BRAND.border};">
            <tr>
              <td style="height:4px;line-height:4px;font-size:0;background:${accent};border-radius:16px 16px 0 0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="width:36px;height:36px;background:${BRAND.accent};border-radius:10px;text-align:center;vertical-align:middle;">
                      <span style="font:700 14px ${FONT};color:${BRAND.accentInk};">AC</span>
                    </td>
                    <td style="padding-left:12px;vertical-align:middle;">
                      <div style="font:700 14px ${FONT};color:${BRAND.ink};">Admin Control</div>
                      <div style="font:11px/1.4 ${FONT};color:${BRAND.muted};letter-spacing:.06em;text-transform:uppercase;">Operations</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${accent}1f;color:${accent};font:700 11px/1.4 ${FONT};letter-spacing:.05em;text-transform:uppercase;margin-bottom:14px;">${escapeHtml(eyebrow)}</span>
                <h1 style="margin:14px 0 12px 0;font:700 21px/1.3 ${FONT};color:${BRAND.ink};">${escapeHtml(title)}</h1>
                ${introHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:4px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${rowsHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                <p style="margin:0;font:12px/1.6 ${FONT};color:${BRAND.muted};">${footerNote}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function requestDetailRows(fields) {
  return [
    detailRow('Name', fields.name),
    detailRow('Email', fields.email),
    detailRow('Phone', fields.phone),
    detailRow('Company', fields.company),
    detailRow('Country', fields.country),
    detailRow('Website', fields.website),
    detailRow('Reason', fields.reason),
    detailRow('Note', fields.note),
  ].join('');
}

function kindLabel(kind) {
  return kind === 'reseller' ? 'Reseller application' : 'Account request';
}

function resetButtonRow(url) {
  return `
    <tr>
      <td style="padding:8px 0 4px 0;">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td style="border-radius:8px;background:${BRAND.ink};">
              <a href="${url}" style="display:inline-block;padding:12px 24px;font:700 14px ${FONT};color:#ffffff;text-decoration:none;border-radius:8px;">Reset password</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`;
}

function renderOperationsNotificationHtml(fields, submittedAt) {
  return renderEmailShell({
    module: fields.module,
    preheader: `New ${kindLabel(fields.kind).toLowerCase()} from ${fields.name}`,
    eyebrow: `${kindLabel(fields.kind)} · ${fields.module.toUpperCase()}`,
    title: 'New access request',
    intro: [
      `A new ${kindLabel(fields.kind).toLowerCase()} was submitted through the public intake form on ${escapeHtml(formatSubmittedAt(submittedAt))}.`,
    ],
    rowsHtml: requestDetailRows(fields),
    footerNote: 'Automated notification from the Admin Control public request form.',
  });
}

function renderVisitorConfirmationHtml(fields, submittedAt) {
  return renderEmailShell({
    module: fields.module,
    preheader: `We've received your ${kindLabel(fields.kind).toLowerCase()}`,
    eyebrow: `${kindLabel(fields.kind)} · ${fields.module.toUpperCase()}`,
    title: `We've received your ${kindLabel(fields.kind).toLowerCase()}`,
    intro: [
      `Hi ${escapeHtml(fields.name)},`,
      `This confirms we've received your ${kindLabel(fields.kind).toLowerCase()} for the ${escapeHtml(fields.module.toUpperCase())} module, submitted on ${escapeHtml(formatSubmittedAt(submittedAt))}. Our operations team will follow up with you at this email address.`,
    ],
    rowsHtml: requestDetailRows(fields),
    footerNote:
      "This is an automated confirmation — no reply needed. If you didn't submit this request, you can safely ignore this email.",
  });
}

function renderPasswordResetHtml({ username, resetUrl, expiresInMinutes }) {
  return renderEmailShell({
    module: undefined,
    preheader: 'Reset your Admin Control password',
    eyebrow: 'Password reset',
    title: 'Reset your password',
    intro: [
      `Hi ${escapeHtml(username)},`,
      `We received a request to reset your Admin Control password. Click the button below to choose a new one. This link expires in ${expiresInMinutes} minutes.`,
      "If you didn't request this, you can safely ignore this email — your password won't change.",
    ],
    rowsHtml: resetButtonRow(escapeHtml(resetUrl)),
    footerNote: 'For your security, this link can only be used once.',
  });
}

module.exports = {
  renderOperationsNotificationHtml,
  renderVisitorConfirmationHtml,
  renderPasswordResetHtml,
};
