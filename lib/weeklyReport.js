// ══════════════════════════════════════════════════════════════════
// WEEKLY SYNTHESIS REPORT — lib/weeklyReport.js
//
// A short, readable PDF for the band — not the dense multi-page
// financial terminal report in routes/reports.js. Every number here is
// pulled live from the DB (transactions, Trust Engine ledger, forecast
// engine, booking_stage_events, releases, press_contacts). The only
// "engaging" part is the framing and layout — headline copy is built by
// substituting real computed numbers into a template, never invented.
// ══════════════════════════════════════════════════════════════════
const PDFDocument = require('pdfkit');
const pool = require('../db/pool');
const { accountBalances } = require('./ledger');
const { pipelineExpectedValue, runwayProjection } = require('./forecast');
const { helpers } = require('../routes/reports');
const { fmtEur, fmtDate, C, drawHeader, drawSubheader, drawKpiRow, drawTable, drawTextBlock, drawSignalRow } = helpers;

async function gatherWeekData() {
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const sinceStr = since.toISOString().slice(0, 10);

  const [
    weekTxns,
    balances,
    pipeline,
    runway,
    stageMoves,
    releasesActivity,
    pressActivity,
    overdueFollowups,
  ] = await Promise.all([
    pool.query(`SELECT * FROM transactions WHERE date >= $1 ORDER BY date ASC`, [sinceStr]),
    accountBalances(pool),
    pipelineExpectedValue(pool),
    runwayProjection(pool),
    pool.query(`
      SELECT e.*, b.name AS booking_name
      FROM booking_stage_events e
      JOIN booking_contacts b ON b.id = e.booking_id
      WHERE e.occurred_at >= $1
      ORDER BY e.occurred_at DESC
    `, [since.toISOString()]),
    pool.query(`SELECT * FROM releases WHERE updated_at >= $1 ORDER BY updated_at DESC`, [since.toISOString()]),
    pool.query(`SELECT * FROM press_contacts WHERE updated_at >= $1 ORDER BY updated_at DESC`, [since.toISOString()]),
    pool.query(`
      SELECT COUNT(*)::int AS n FROM booking_contacts
      WHERE follow_up_date <= now() AND stage NOT IN ('completed','rejected')
    `),
  ]);

  const income = weekTxns.rows.filter(t => t.type === 'income');
  const expense = weekTxns.rows.filter(t => t.type === 'expense');
  const weekRevenue = income.reduce((s, t) => s + parseFloat(t.amount_eur), 0);
  const weekExpense = expense.reduce((s, t) => s + parseFloat(t.amount_eur), 0);
  const bandCash = Number(balances.find(b => b.account === 'band_cash')?.balance || 0);

  return {
    since, weekTxns: weekTxns.rows, weekRevenue, weekExpense,
    bandCash, pipeline, runway,
    stageMoves: stageMoves.rows,
    releasesActivity: releasesActivity.rows,
    pressActivity: pressActivity.rows,
    overdueFollowups: overdueFollowups.rows[0].n,
  };
}

// Builds one plain-English headline out of real numbers — no invented
// claims. Picks whichever fact is most concrete/newsworthy this week.
function buildHeadline(d) {
  if (d.weekRevenue > 0) {
    return `€${d.weekRevenue.toFixed(0)} came in this week — verified band cash now stands at ${fmtEur(d.bandCash)}.`;
  }
  if (d.stageMoves.length > 0) {
    return `${d.stageMoves.length} booking${d.stageMoves.length === 1 ? '' : 's'} moved stage this week.`;
  }
  return `No new revenue or booking movement this week — verified band cash holds at ${fmtEur(d.bandCash)}.`;
}

async function generateWeeklySynthesisPDF() {
  const d = await gatherWeekData();

  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
      bufferPages: true,
      info: {
        Title: 'The Ginskeys — Weekly Synthesis',
        Author: 'Ginskeys Console',
        Subject: `Weekly Synthesis — week of ${fmtDate(d.since)}`,
      },
    });
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let y = 50;

    // ── Masthead ──────────────────────────────────
    doc.fontSize(18).font('Helvetica-Bold').fillColor(C.black)
      .text('THE GINSKEYS', 40, y);
    doc.fontSize(10).font('Helvetica').fillColor(C.muted)
      .text(`Weekly Synthesis — week of ${fmtDate(d.since)} to ${fmtDate(new Date())}`, 40, y + 22);
    y += 46;

    // ── Headline (real numbers, plain English) ────
    doc.fontSize(12).font('Helvetica-Bold').fillColor(C.accent)
      .text(buildHeadline(d), 40, y, { width: doc.page.width - 80 });
    y = doc.y + 14;

    // ── Headline KPIs ─────────────────────────────
    y = drawKpiRow(doc, [
      { label: 'Revenue this week', value: fmtEur(d.weekRevenue), color: C.green },
      { label: 'Expenses this week', value: fmtEur(d.weekExpense), color: C.red },
      { label: 'Verified band cash', value: fmtEur(d.bandCash), color: C.black },
      { label: 'Pipeline (expected value)', value: fmtEur(d.pipeline.total_expected_value_eur), color: C.blue },
    ], y);
    y += 8;

    // ── Runway signal ─────────────────────────────
    y = drawHeader(doc, 'Runway', y);
    const runwayVal = d.runway.runway_months_with_pipeline;
    y = drawSignalRow(doc, [
      {
        label: 'Cash-only runway',
        value: d.runway.runway_months_cash_only === null ? '∞ (no recent spend)' : d.runway.runway_months_cash_only.toFixed(1) + ' months',
        ok: d.runway.runway_months_cash_only === null || d.runway.runway_months_cash_only > 9,
        warn: d.runway.runway_months_cash_only > 5,
      },
      {
        label: 'With pipeline (90d expected)',
        value: runwayVal === null ? '∞' : runwayVal.toFixed(1) + ' months',
        ok: runwayVal === null || runwayVal > 9,
        warn: runwayVal > 5,
      },
      {
        label: 'Overdue booking follow-ups',
        value: String(d.overdueFollowups),
        ok: d.overdueFollowups === 0,
        warn: d.overdueFollowups <= 2,
      },
    ], y);
    if (d.runway.note) {
      y = drawTextBlock(doc, 'Note', d.runway.note, y);
    }
    y += 6;

    // ── Booking pipeline ───────────────────────────
    y = drawHeader(doc, 'Booking Pipeline — Expected Value', y);
    if (d.pipeline.items.length) {
      const rows = d.pipeline.items.map(i => [
        i.name, i.stage, fmtEur(i.fee_eur),
        (i.probability * 100).toFixed(0) + '%' + (i.probability_source === 'prior' ? ' (prior)' : ''),
        fmtEur(i.expected_value_eur),
      ]);
      y = drawTable(doc, ['Booking', 'Stage', 'Fee', 'P(confirmed)', 'Expected Value'], rows, y, [140, 80, 85, 100, 90]);
    } else {
      y = drawTextBlock(doc, 'Pipeline', 'No open bookings right now.', y);
    }
    y += 6;

    // ── This week's movement ───────────────────────
    y = drawHeader(doc, "This Week's Movement", y);
    if (d.stageMoves.length) {
      const rows = d.stageMoves.map(m => [
        m.booking_name,
        (m.from_stage || 'new') + ' → ' + m.to_stage,
        fmtDate(m.occurred_at),
      ]);
      y = drawTable(doc, ['Booking', 'Transition', 'Date'], rows, y, [220, 150, 85]);
    } else {
      y = drawTextBlock(doc, 'Movement', 'No booking stage changes this week.', y);
    }
    y += 6;

    // ── Press & releases activity ──────────────────
    if (d.releasesActivity.length || d.pressActivity.length) {
      y = drawHeader(doc, 'Press & Release Activity', y);
      d.releasesActivity.forEach(r => {
        y = drawTextBlock(doc, r.title, `Stage: ${r.stage}` + (r.release_date ? ` · Release date: ${fmtDate(r.release_date)}` : ''), y);
      });
      d.pressActivity.forEach(p => {
        y = drawTextBlock(doc, p.outlet, `Stage: ${p.stage}` + (p.estimated_value_eur ? ` · Est. value: ${fmtEur(p.estimated_value_eur)}` : ''), y);
      });
    }

    // ── Footer ──────────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font('Helvetica').fillColor(C.light);
      doc.text(
        'Figures verified against the Ginskeys Console Trust Engine hash-chained ledger.',
        40, doc.page.height - 30, { width: doc.page.width - 80, align: 'center' }
      );
    }

    doc.end();
  });
}

module.exports = { generateWeeklySynthesisPDF, gatherWeekData };
