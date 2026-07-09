// ══════════════════════════════════════════════════════════════════
// WEEKLY REPORT SCHEDULER — lib/weeklyScheduler.js
//
// Opt-in only. Requires WEEKLY_REPORT_ENABLED=true plus SMTP + recipient
// env vars — if any are missing, this logs why and does nothing, rather
// than crashing the server or silently failing later.
//
// Default schedule: Monday 09:00 Europe/Lisbon. Override with
// WEEKLY_REPORT_CRON (standard 5-field cron syntax) if you want a
// different day/time.
// ══════════════════════════════════════════════════════════════════
const cron = require('node-cron');

function start() {
  if (process.env.WEEKLY_REPORT_ENABLED !== 'true') {
    console.log('  ℹ Weekly synthesis report scheduler disabled (set WEEKLY_REPORT_ENABLED=true to enable)');
    return;
  }

  const { isConfigured } = require('./mailer');
  if (!isConfigured()) {
    console.warn('  ⚠ Weekly report scheduler NOT started — SMTP_HOST/SMTP_USER/SMTP_PASS not set');
    return;
  }
  if (!process.env.BAND_OFFICIAL_EMAIL) {
    console.warn('  ⚠ Weekly report scheduler NOT started — BAND_OFFICIAL_EMAIL not set');
    return;
  }

  const schedule = process.env.WEEKLY_REPORT_CRON || '0 9 * * 1'; // Monday 09:00
  if (!cron.validate(schedule)) {
    console.warn(`  ⚠ Weekly report scheduler NOT started — WEEKLY_REPORT_CRON "${schedule}" is not a valid cron expression`);
    return;
  }

  cron.schedule(schedule, async () => {
    console.log('[weekly-report] Generating and sending scheduled weekly synthesis...');
    try {
      const { generateWeeklySynthesisPDF } = require('./weeklyReport');
      const { sendMail } = require('./mailer');
      const pdfBuffer = await generateWeeklySynthesisPDF();
      const dateLabel = new Date().toISOString().slice(0, 10);
      await sendMail({
        to: process.env.BAND_OFFICIAL_EMAIL,
        subject: `The Ginskeys — Weekly Synthesis (${dateLabel})`,
        html: `<p>This week's synthesis report is attached.</p>
               <p style="color:#888;font-size:12px">Generated automatically by the Ginskeys Console. Figures are verified against the Trust Engine hash-chained ledger.</p>`,
        attachments: [{
          filename: `ginskeys-weekly-${dateLabel}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        }],
      });
      console.log(`[weekly-report] Sent to ${process.env.BAND_OFFICIAL_EMAIL}`);
    } catch (err) {
      console.error('[weekly-report] FAILED to generate/send:', err.message);
    }
  }, { timezone: process.env.WEEKLY_REPORT_TZ || 'Europe/Lisbon' });

  console.log(`  ✔ Weekly report scheduler active — "${schedule}" (${process.env.WEEKLY_REPORT_TZ || 'Europe/Lisbon'}) → ${process.env.BAND_OFFICIAL_EMAIL}`);
}

module.exports = { start };
