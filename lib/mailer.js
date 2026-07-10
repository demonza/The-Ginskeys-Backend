// ══════════════════════════════════════════════════════════════════
// MAILER — lib/mailer.js  (v2 — HTTPS API, not SMTP)
//
// Why this isn't SMTP: Railway blocks ALL outbound SMTP traffic
// (ports 25, 465, 587, 2525) on Free, Trial, and Hobby plans — it's
// only available on the Pro plan and above. A nodemailer/SMTP mailer
// will hang indefinitely on those plans (the connection attempt gets
// no response at all, so it never even errors out cleanly) regardless
// of how correctly it's configured. This isn't a code bug — it's a
// platform-level firewall rule. Railway's own docs recommend an
// HTTPS-based transactional email API instead, since HTTPS (port 443)
// is never blocked on any plan.
//
// This uses Resend (https://resend.com) — free tier: 3,000 emails/month,
// 100/day, no credit card. Get an API key at resend.com/api-keys.
//
// IMPORTANT CAVEAT, stated plainly: on Resend's free tier, until you
// verify a sending domain, you can only send FROM onboarding@resend.dev,
// and only TO the email address you used to sign up for Resend. If
// BAND_OFFICIAL_EMAIL is a different address than your Resend account's
// signup email, sending will fail with a 403 until you either:
//   (a) sign up for Resend using the band's official email address, or
//   (b) verify a domain you control (adds ~15 min of DNS record setup,
//       but then you can send to anyone from any address on that domain).
//
// Required env vars:
//   RESEND_API_KEY        from resend.com/api-keys
//   RESEND_FROM            optional — defaults to 'onboarding@resend.dev'
//                           (only usable until a domain is verified)
//   BAND_OFFICIAL_EMAIL    recipient for scheduled reports
// ══════════════════════════════════════════════════════════════════

function isConfigured() {
  return !!process.env.RESEND_API_KEY;
}

async function sendMail({ to, subject, html, attachments = [] }) {
  if (!isConfigured()) {
    throw new Error(
      'Email is not configured. Set RESEND_API_KEY in Railway Variables ' +
      '(get one free at resend.com/api-keys — see lib/mailer.js header comment for details).'
    );
  }
  if (!to) throw new Error('No recipient address provided.');

  const body = {
    from: process.env.RESEND_FROM || 'onboarding@resend.dev',
    to: [to],
    subject,
    html,
  };

  if (attachments.length) {
    body.attachments = attachments.map(a => ({
      filename: a.filename,
      content: Buffer.isBuffer(a.content) ? a.content.toString('base64') : a.content,
    }));
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Resend API request timed out after 20s' : `Resend API request failed: ${e.message}`);
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`Resend API error (HTTP ${res.status}): ${data.message || JSON.stringify(data)}`);
  }

  return data;
}

module.exports = { sendMail, isConfigured };
