// ══════════════════════════════════════════════════════════════════
// MAILER — lib/mailer.js
//
// Deliberately built on plain SMTP via nodemailer rather than a
// transactional-email API (Resend/SendGrid/etc). Reasoning, stated
// honestly: those providers only let a free-tier account send to
// arbitrary recipients once a sending domain is verified — extra setup
// this band doesn't need. Gmail (or any mailbox the band already has)
// works over SMTP with an app password, for free, and can send to the
// band's official address with no domain work at all.
//
// Required env vars (set in Railway → Variables):
//   SMTP_HOST        e.g. smtp.gmail.com
//   SMTP_PORT        e.g. 465 (SSL) or 587 (STARTTLS)
//   SMTP_USER        the sending mailbox address
//   SMTP_PASS        an APP PASSWORD, not the account's normal password
//                    (Gmail: Google Account → Security → 2-Step Verification
//                    → App Passwords. Regular passwords are rejected by
//                    Gmail's SMTP for security reasons.)
//   SMTP_FROM        optional — display name/address for the From header,
//                    defaults to SMTP_USER
//   BAND_OFFICIAL_EMAIL   the recipient address for scheduled reports
// ══════════════════════════════════════════════════════════════════
const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465'),
    secure: parseInt(process.env.SMTP_PORT || '465') === 465, // true for 465, false for 587/STARTTLS
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  return _transporter;
}

async function sendMail({ to, subject, html, attachments = [] }) {
  if (!isConfigured()) {
    throw new Error(
      'Email is not configured. Set SMTP_HOST, SMTP_USER, and SMTP_PASS in Railway Variables ' +
      '(e.g. Gmail SMTP with an App Password — see lib/mailer.js header comment for exact steps).'
    );
  }
  if (!to) throw new Error('No recipient address provided.');

  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    attachments,
  });
  return info;
}

module.exports = { sendMail, isConfigured };
