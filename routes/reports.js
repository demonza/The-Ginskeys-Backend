// ══════════════════════════════════════════════════
// REPORTS ROUTES — /api/reports
// Server-side PDF financial report generation
// ══════════════════════════════════════════════════
const router  = require('express').Router();
const PDFDocument = require('pdfkit');
const pool    = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ── Helpers ──────────────────────────────────────────
function fmtEur(n) {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return sign + '€ ' + abs.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  if (!d) return '—';
  const s = String(d);
  return s.includes('T') ? s.slice(0, 10) : s;
}

function fmtPct(n) {
  return (n * 100).toFixed(1) + '%';
}

// ── Colour palette ───────────────────────────────────
const C = {
  black:    '#111111',
  dark:     '#333333',
  muted:    '#666666',
  light:    '#999999',
  accent:   '#FF5C1A',
  green:    '#166534',
  red:      '#DC2626',
  amber:    '#92400E',
  blue:     '#1E3A8A',
  bg:       '#F8F8F8',
  line:     '#DDDDDD',
  headerBg: '#1a1a1a',
  headerFg: '#FFFFFF',
};

// ── PDF builder helpers ──────────────────────────────
function drawHeader(doc, text, y) {
  doc.save();
  doc.rect(40, y, doc.page.width - 80, 22).fill(C.headerBg);
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.headerFg);
  doc.text(text.toUpperCase(), 48, y + 6, { width: doc.page.width - 96 });
  doc.restore();
  doc.fillColor(C.black);
  return y + 28;
}

function drawKpiRow(doc, items, y) {
  const colW = (doc.page.width - 80) / items.length;
  items.forEach((item, i) => {
    const x = 40 + i * colW;
    doc.rect(x, y, colW - 4, 38).fill(C.bg).stroke(C.line);
    doc.fontSize(7).font('Helvetica').fillColor(C.light);
    doc.text(item.label.toUpperCase(), x + 8, y + 6, { width: colW - 16 });
    doc.fontSize(12).font('Helvetica-Bold').fillColor(item.color || C.black);
    doc.text(item.value, x + 8, y + 18, { width: colW - 16 });
  });
  doc.fillColor(C.black);
  return y + 44;
}

function drawTable(doc, headers, rows, y, colWidths) {
  const tableW = doc.page.width - 80;
  const rowH = 16;

  // Auto-calculate column widths if not provided
  if (!colWidths) {
    colWidths = headers.map(() => tableW / headers.length);
  }

  // Header row
  doc.rect(40, y, tableW, rowH).fill('#EEEEEE');
  doc.fontSize(7).font('Helvetica-Bold').fillColor(C.dark);
  let x = 40;
  headers.forEach((h, i) => {
    const align = i >= headers.length - 2 ? 'right' : 'left';
    doc.text(h, x + 4, y + 4, { width: colWidths[i] - 8, align });
    x += colWidths[i];
  });
  y += rowH;

  // Data rows
  doc.font('Helvetica').fontSize(7).fillColor(C.black);
  rows.forEach((row, ri) => {
    // Check page break
    if (y + rowH > doc.page.height - 60) {
      doc.addPage();
      y = 50;
    }

    if (ri % 2 === 1) doc.rect(40, y, tableW, rowH).fill('#FAFAFA');

    x = 40;
    row.forEach((cell, ci) => {
      const align = ci >= headers.length - 2 ? 'right' : 'left';
      const color = typeof cell === 'string' && cell.startsWith('-€') ? C.red
                  : typeof cell === 'string' && cell.startsWith('+€') ? C.green
                  : C.black;
      doc.fillColor(color);
      doc.text(String(cell), x + 4, y + 4, { width: colWidths[ci] - 8, align });
      x += colWidths[ci];
    });
    y += rowH;
  });

  doc.fillColor(C.black);
  return y + 4;
}

function drawSeparator(doc, y) {
  doc.moveTo(40, y).lineTo(doc.page.width - 40, y).lineWidth(0.5).strokeColor(C.line).stroke();
  return y + 8;
}


// ── GET /api/reports/financial ────────────────────────
// Query params: ?from=YYYY-MM-DD&to=YYYY-MM-DD (optional, defaults to all time)
router.get('/financial', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { from, to } = req.query;

    // ── Fetch all data ─────────────────────────────
    const txnParams = [];
    const txnWheres = [];
    if (from) { txnParams.push(from); txnWheres.push(`t.date >= $${txnParams.length}`); }
    if (to)   { txnParams.push(to);   txnWheres.push(`t.date <= $${txnParams.length}`); }
    const txnWhere = txnWheres.length ? 'WHERE ' + txnWheres.join(' AND ') : '';

    const [txnResult, catResult, tourResult, streamResult, splitResult, memberResult] = await Promise.all([
      pool.query(`
        SELECT t.*, c.name AS category FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${txnWhere} ORDER BY t.date ASC
      `, txnParams),
      pool.query(`SELECT name, type FROM categories ORDER BY type, name`),
      pool.query(`
        SELECT t.*,
          COALESCE(SUM(CASE WHEN tx.type='income' THEN tx.amount_eur ELSE 0 END),0) AS revenue,
          COALESCE(SUM(CASE WHEN tx.type='expense' THEN tx.amount_eur ELSE 0 END),0) AS costs
        FROM tours t
        LEFT JOIN transactions tx ON tx.tour_id = t.id
        GROUP BY t.id ORDER BY t.start_date DESC NULLS LAST
      `),
      pool.query(`SELECT * FROM streaming_snapshots ORDER BY period DESC`),
      pool.query(`
        SELECT s.*, array_agg(
          json_build_object('member',m.member_name,'base',m.base_share,'expenses',m.expenses_eur,'net',m.net_eur)
          ORDER BY m.member_name
        ) AS members
        FROM gig_splits s
        LEFT JOIN gig_split_members m ON m.split_id = s.id
        GROUP BY s.id ORDER BY s.gig_date DESC
      `),
      // Member accounts — may not exist yet
      pool.query(`
        SELECT 1 FROM information_schema.tables WHERE table_name = 'member_account_txns'
      `).then(async (check) => {
        if (check.rows.length === 0) return { rows: [] };
        return pool.query(`
          SELECT member_key,
            (array_agg(member_name ORDER BY created_at DESC))[1] AS member_name,
            COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE 0 END),0) AS total_in,
            COALESCE(SUM(CASE WHEN txn_type = 'withdrawal' THEN amount ELSE 0 END),0) AS total_out,
            COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE -amount END),0) AS balance
          FROM member_account_txns GROUP BY member_key ORDER BY member_key
        `);
      }),
    ]);

    const txns     = txnResult.rows;
    const tours    = tourResult.rows;
    const streams  = streamResult.rows;
    const splits   = splitResult.rows;
    const members  = memberResult.rows;

    // ── Compute aggregates ─────────────────────────
    const income   = txns.filter(t => t.type === 'income');
    const expenses = txns.filter(t => t.type === 'expense');
    const totalIncome  = income.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const totalExpense = expenses.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const netResult    = totalIncome - totalExpense;

    // By category
    const incByCat = {};
    income.forEach(t => { const c = t.category || 'Outros'; incByCat[c] = (incByCat[c] || 0) + parseFloat(t.amount_eur || t.amount); });
    const expByCat = {};
    expenses.forEach(t => { const c = t.category || 'Outros'; expByCat[c] = (expByCat[c] || 0) + parseFloat(t.amount_eur || t.amount); });

    // By month
    const byMonth = {};
    txns.forEach(t => {
      const m = fmtDate(t.date).slice(0, 7);
      if (!byMonth[m]) byMonth[m] = { inc: 0, exp: 0 };
      const amt = parseFloat(t.amount_eur || t.amount);
      if (t.type === 'income') byMonth[m].inc += amt;
      else byMonth[m].exp += amt;
    });

    // Streaming totals
    const totalStreams = streams.reduce((s, p) => s + (p.streams || 0), 0);
    const totalStreamRev = streams.reduce((s, p) => s + parseFloat(p.revenue_eur || 0), 0);

    // Period label
    const periodLabel = from || to
      ? `${from || 'Start'} to ${to || 'Present'}`
      : txns.length
        ? `${fmtDate(txns[0].date)} to ${fmtDate(txns[txns.length - 1].date)}`
        : 'No transactions';

    // ── Build PDF ──────────────────────────────────
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
      info: {
        Title: `The Ginskeys — Financial Report`,
        Author: 'The Ginskeys Financial Terminal',
        Subject: `Financial Report — ${periodLabel}`,
      },
    });

    // Stream to response
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="ginskeys-financial-report-${new Date().toISOString().slice(0, 10)}.pdf"`);
    doc.pipe(res);

    const pageW = doc.page.width;
    let y = 50;

    // ═══════════════════════════════════════════════
    // PAGE 1: COVER + EXECUTIVE SUMMARY
    // ═══════════════════════════════════════════════

    // Title block
    doc.rect(0, 0, pageW, 120).fill(C.headerBg);
    doc.fontSize(28).font('Helvetica-Bold').fillColor(C.accent);
    doc.text('THE GINSKEYS', 40, 30, { width: pageW - 80 });
    doc.fontSize(10).font('Helvetica').fillColor('#AAAAAA');
    doc.text('FINANCIAL REPORT', 40, 62);
    doc.fontSize(9).fillColor('#888888');
    doc.text(`Period: ${periodLabel}`, 40, 78);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, 40, 92);
    doc.text(`Prepared by: The Ginskeys Financial Terminal`, 40, 104);

    doc.fillColor(C.black);
    y = 136;

    // ── KPI Summary ────────────────────────────────
    y = drawHeader(doc, 'Financial Summary', y);

    y = drawKpiRow(doc, [
      { label: 'Total Revenue', value: fmtEur(totalIncome), color: C.green },
      { label: 'Total Expenses', value: fmtEur(totalExpense), color: C.red },
      { label: 'Net Result', value: fmtEur(netResult), color: netResult >= 0 ? C.green : C.red },
      { label: 'Transactions', value: String(txns.length), color: C.black },
    ], y);
    y += 4;

    const margin = totalIncome > 0 ? (netResult / totalIncome) : 0;
    const avgGig = income.filter(t => t.category === 'Espetáculo');
    const avgGigFee = avgGig.length > 0 ? avgGig.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0) / avgGig.length : 0;

    y = drawKpiRow(doc, [
      { label: 'Gross Margin', value: fmtPct(margin), color: margin > 0.5 ? C.green : C.amber },
      { label: 'Gig Count', value: String(avgGig.length), color: C.black },
      { label: 'Avg Gig Fee', value: fmtEur(avgGigFee), color: C.black },
      { label: 'Streaming Revenue', value: fmtEur(totalStreamRev), color: C.black },
    ], y);
    y += 12;

    // ── Income by Category ─────────────────────────
    y = drawHeader(doc, 'Revenue Breakdown by Category', y);
    const incRows = Object.entries(incByCat)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => [cat, fmtPct(amt / totalIncome), fmtEur(amt)]);
    incRows.push(['TOTAL', '100%', fmtEur(totalIncome)]);
    y = drawTable(doc, ['Category', 'Share', 'Amount (EUR)'], incRows, y, [200, 120, 195]);
    y += 8;

    // ── Expenses by Category ───────────────────────
    y = drawHeader(doc, 'Expense Breakdown by Category', y);
    const expRows = Object.entries(expByCat)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => [cat, fmtPct(amt / totalExpense), fmtEur(amt)]);
    expRows.push(['TOTAL', '100%', fmtEur(totalExpense)]);
    y = drawTable(doc, ['Category', 'Share', 'Amount (EUR)'], expRows, y, [200, 120, 195]);

    // ═══════════════════════════════════════════════
    // PAGE 2: MONTHLY CASH FLOW
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

    y = drawHeader(doc, 'Monthly Cash Flow', y);
    const months = Object.keys(byMonth).sort();
    const monthRows = months.map(m => {
      const d = byMonth[m];
      const net = d.inc - d.exp;
      return [m, fmtEur(d.inc), fmtEur(d.exp), (net >= 0 ? '+' : '') + fmtEur(net)];
    });
    y = drawTable(doc, ['Month', 'Income', 'Expenses', 'Net'], monthRows, y, [140, 120, 120, 135]);
    y += 12;

    // ── Tour P&L ───────────────────────────────────
    if (tours.length) {
      y = drawHeader(doc, 'Tour / Event Profitability', y);
      const tourRows = tours.map(t => {
        const rev = parseFloat(t.revenue || 0);
        const cost = parseFloat(t.costs || 0);
        const net = rev - cost;
        return [t.name, t.status || '—', fmtEur(rev), fmtEur(cost), (net >= 0 ? '+' : '') + fmtEur(net)];
      });
      y = drawTable(doc, ['Tour / Event', 'Status', 'Revenue', 'Costs', 'Net'], tourRows, y, [160, 60, 95, 95, 105]);
      y += 12;
    }

    // ── Gig Splits ─────────────────────────────────
    if (splits.length) {
      if (y > doc.page.height - 200) { doc.addPage(); y = 50; }
      y = drawHeader(doc, 'Gig Split History', y);
      const splitRows = splits.map(s => [
        s.gig_name,
        fmtDate(s.gig_date),
        fmtEur(parseFloat(s.gross_eur)),
        fmtEur(parseFloat(s.band_fund_eur || 0)),
        fmtEur(parseFloat(s.per_member_eur)),
        String(s.member_count || '—'),
      ]);
      y = drawTable(doc, ['Gig', 'Date', 'Gross', 'Band Fund', 'Per Member', 'Members'],
        splitRows, y, [130, 65, 80, 75, 80, 55]);
      y += 12;
    }

    // ── Member Account Balances ────────────────────
    if (members.length) {
      if (y > doc.page.height - 150) { doc.addPage(); y = 50; }
      y = drawHeader(doc, 'Member Account Balances', y);
      const memberRows = members.map(m => [
        m.member_name || m.member_key,
        fmtEur(parseFloat(m.total_in)),
        fmtEur(parseFloat(m.total_out)),
        fmtEur(parseFloat(m.balance)),
      ]);
      y = drawTable(doc, ['Member', 'Total In', 'Total Out', 'Balance'],
        memberRows, y, [160, 115, 115, 125]);
      y += 12;
    }

    // ── Streaming Summary ──────────────────────────
    if (streams.length) {
      if (y > doc.page.height - 150) { doc.addPage(); y = 50; }
      y = drawHeader(doc, 'Streaming Summary', y);

      // Aggregate by platform
      const byPlatform = {};
      streams.forEach(s => {
        if (!byPlatform[s.platform]) byPlatform[s.platform] = { streams: 0, rev: 0 };
        byPlatform[s.platform].streams += s.streams || 0;
        byPlatform[s.platform].rev += parseFloat(s.revenue_eur || 0);
      });
      const streamRows = Object.entries(byPlatform)
        .sort((a, b) => b[1].streams - a[1].streams)
        .map(([p, d]) => [p.charAt(0).toUpperCase() + p.slice(1), String(d.streams.toLocaleString()), fmtEur(d.rev)]);
      streamRows.push(['TOTAL', totalStreams.toLocaleString(), fmtEur(totalStreamRev)]);
      y = drawTable(doc, ['Platform', 'Total Streams', 'Revenue (EUR)'],
        streamRows, y, [200, 150, 165]);
    }

    // ═══════════════════════════════════════════════
    // LAST PAGE: TRANSACTION LEDGER
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

    y = drawHeader(doc, `Transaction Ledger (${txns.length} entries)`, y);

    // Running balance
    let running = 0;
    const ledgerRows = txns.map(t => {
      const amt = parseFloat(t.amount_eur || t.amount);
      const signed = t.type === 'income' ? amt : -amt;
      running += signed;
      return [
        fmtDate(t.date),
        (t.description || '').slice(0, 40),
        t.category || '—',
        t.type === 'income' ? '+' + fmtEur(amt) : '-' + fmtEur(amt),
        fmtEur(running),
      ];
    });

    y = drawTable(doc, ['Date', 'Description', 'Category', 'Amount', 'Balance'],
      ledgerRows, y, [65, 180, 85, 90, 95]);

    // ── Footer on every page ───────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font('Helvetica').fillColor(C.light);
      doc.text(
        `The Ginskeys Financial Terminal — Page ${i + 1} of ${pages.count} — Generated ${new Date().toISOString().slice(0, 10)}`,
        40, doc.page.height - 30,
        { width: doc.page.width - 80, align: 'center' }
      );
    }

    doc.end();

    await writeAudit(req, 'REPORT_GENERATED', {
      details: `Financial PDF — ${periodLabel} — ${txns.length} transactions`,
    });

  } catch (err) { next(err); }
});

module.exports = router;
