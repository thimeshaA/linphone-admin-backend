const { sendMail } = require('../utils/mailer');
const { isValidEmail } = require('../utils/validators');
const { renderOperationsNotificationHtml, renderVisitorConfirmationHtml } = require('../utils/emailTemplates');

const REQUEST_RECIPIENT = 'enigma-admin@prometeolk.com';

function kindLabel(kind) {
  return kind === 'reseller' ? 'reseller application' : 'account request';
}

function formatSubmissionDetails({ kind, module, name, email, phone, company, country, website, reason, note }) {
  const lines = [
    `Request type: ${kind}`,
    `Module: ${module}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
  ];

  if (company) lines.push(`Company: ${company}`);
  if (country) lines.push(`Country: ${country}`);
  if (website) lines.push(`Website: ${website}`);
  if (reason) lines.push(`Reason: ${reason}`);
  if (note) lines.push(`Note: ${note}`);

  return lines.join('\n');
}

function buildRequestEmailBody(fields, submittedAt) {
  return [`Submitted at: ${submittedAt}`, '', formatSubmissionDetails(fields)].join('\n');
}

// The visitor's own copy — confirms receipt and repeats what they submitted,
// so they have a record of it and can catch a typo (e.g. in their phone
// number) even though it was sent to their own address.
function buildConfirmationEmailBody(fields, submittedAt) {
  return [
    `Hi ${fields.name},`,
    '',
    `This confirms we've received your ${kindLabel(fields.kind)} for the ${fields.module.toUpperCase()} module, submitted on ${submittedAt}.`,
    "Our operations team will follow up with you at this email address.",
    '',
    'Copy of your submission:',
    formatSubmissionDetails(fields),
  ].join('\n');
}

async function submitAccessRequest(req, res) {
  const { kind, module, name, email, phone, company, country, website, reason, note } = req.body;

  if (kind !== 'reseller' && kind !== 'account') {
    return res.status(400).json({ error: 'kind must be "reseller" or "account"' });
  }

  if (module !== 'sip' && module !== 'esim') {
    return res.status(400).json({ error: 'module must be "sip" or "esim"' });
  }

  if (kind === 'account' && module === 'sip') {
    return res.status(400).json({ error: 'SIP accounts cannot be self-requested' });
  }

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'a valid email is required' });
  }

  if (!phone || !String(phone).trim()) {
    return res.status(400).json({ error: 'phone is required' });
  }

  const fields = { kind, module, name, email, phone, company, country, website, reason, note };
  const submittedAt = new Date().toISOString();

  try {
    await sendMail({
      to: REQUEST_RECIPIENT,
      subject: `New ${kind} access request (${module.toUpperCase()})`,
      text: buildRequestEmailBody(fields, submittedAt),
      html: renderOperationsNotificationHtml(fields, submittedAt),
      replyTo: email,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to send request email' });
  }

  // Best-effort: the visitor's own mailbox rejecting this copy doesn't mean
  // their request failed — operations already has it from the send above.
  try {
    await sendMail({
      to: email,
      subject: `We've received your ${kindLabel(kind)}`,
      text: buildConfirmationEmailBody(fields, submittedAt),
      html: renderVisitorConfirmationHtml(fields, submittedAt),
    });
  } catch (err) {
    console.error('Failed to send request confirmation email:', err);
  }

  return res.status(201).json({ message: 'Request submitted successfully' });
}

module.exports = { submitAccessRequest };
