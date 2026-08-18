const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
  },
});

async function sendResellerCredentialsEmail(toEmail, username, password) {
  const loginUrl = `${process.env.FRONTEND_ORIGIN}/login`;

  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to: toEmail,
    subject: 'Your reseller account has been approved',
    text: `Your reseller account has been created.\n\nUsername: ${username}\nPassword: ${password}\n\nLog in at: ${loginUrl}`,
    html: `<p>Your reseller account has been created.</p><p><strong>Username:</strong> ${username}<br><strong>Password:</strong> ${password}</p><p>Log in at <a href="${loginUrl}">${loginUrl}</a></p>`,
  });
}

module.exports = { sendResellerCredentialsEmail };
