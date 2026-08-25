const { sendMail } = require('../utils/mailer');
const { isValidEmail } = require('../utils/validators');

const REQUEST_RECIPIENT = 'enigma-admin@prometeolk.com';

function buildRequestEmailBody({ kind, module, name, email, phone, company, country, website, reason, note, submittedAt }) {
  const lines = [
    `Request type: ${kind}`,
    `Module: ${module}`,
    `Submitted at: ${submittedAt}`,
    '',
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

  const submittedAt = new Date().toISOString();
  const body = buildRequestEmailBody({ kind, module, name, email, phone, company, country, website, reason, note, submittedAt });

  try {
    await sendMail({
      to: REQUEST_RECIPIENT,
      subject: `New ${kind} access request (${module.toUpperCase()})`,
      text: body,
    });
  } catch (err) {
    return res.status(502).json({ error: 'Failed to send request email' });
  }

  return res.status(201).json({ message: 'Request submitted successfully' });
}

module.exports = { submitAccessRequest };
