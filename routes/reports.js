// ══════════════════════════════════════════════════
// REPORTS ROUTES — /api/reports
// Server-side PDF financial report generation
// Mirrors the full Financials tab content
// ══════════════════════════════════════════════════
const router  = require('express').Router();
const PDFDocument = require('pdfkit');
const pool    = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ── Helpers ──────────────────────────────────────────
function fmtEur(n) {
  if (n === null || n === undefined || isNaN(n)) return '€ 0.00';
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
  if (n === null || n === undefined || isNaN(n)) return '—';
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
  purple:   '#6B21A8',
  bg:       '#F8F8F8',
  line:     '#DDDDDD',
  headerBg: '#1a1a1a',
  headerFg: '#FFFFFF',
};

// ── PDF builder helpers ──────────────────────────────
function drawHeader(doc, text, y) {
  checkPageBreak(doc, y, 30);
  y = doc._y || y;
  doc.save();
  doc.rect(40, y, doc.page.width - 80, 22).fill(C.headerBg);
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.headerFg);
  doc.text(text.toUpperCase(), 48, y + 6, { width: doc.page.width - 96 });
  doc.restore();
  doc.fillColor(C.black);
  return y + 28;
}

function drawSubheader(doc, text, y) {
  checkPageBreak(doc, y, 20);
  y = doc._y || y;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(C.accent);
  doc.text(text.toUpperCase(), 44, y + 2, { width: doc.page.width - 88 });
  doc.fillColor(C.black);
  return y + 16;
}

function drawKpiRow(doc, items, y) {
  checkPageBreak(doc, y, 48);
  y = doc._y || y;
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
  if (!colWidths) colWidths = headers.map(() => tableW / headers.length);

  checkPageBreak(doc, y, rowH * 2);
  y = doc._y || y;

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
  doc.font('Helvetica').fontSize(7);
  rows.forEach((row, ri) => {
    if (y + rowH > doc.page.height - 60) {
      doc.addPage();
      y = 50;
    }
    if (ri % 2 === 1) doc.rect(40, y, tableW, rowH).fill('#FAFAFA');
    x = 40;
    row.forEach((cell, ci) => {
      const align = ci >= headers.length - 2 ? 'right' : 'left';
      const cellStr = String(cell);
      const color = cellStr.startsWith('-€') ? C.red : cellStr.startsWith('+€') ? C.green : C.black;
      doc.fillColor(color);
      doc.text(cellStr, x + 4, y + 4, { width: colWidths[ci] - 8, align });
      x += colWidths[ci];
    });
    y += rowH;
  });
  doc.fillColor(C.black);
  return y + 4;
}

function drawTextBlock(doc, label, content, y) {
  checkPageBreak(doc, y, 40);
  y = doc._y || y;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(C.dark);
  doc.text(label, 44, y, { width: doc.page.width - 88 });
  y += 12;
  doc.fontSize(8).font('Helvetica').fillColor(C.muted);
  doc.text(content, 44, y, { width: doc.page.width - 88 });
  y = doc.y + 8;
  return y;
}

function drawSignalRow(doc, signals, y) {
  signals.forEach(s => {
    checkPageBreak(doc, y, 18);
    y = doc._y || y;
    const color = s.ok ? C.green : s.warn ? C.amber : C.red;
    const icon = s.ok ? '●' : s.warn ? '▲' : '✗';
    doc.fontSize(7).font('Helvetica-Bold').fillColor(color);
    doc.text(icon, 48, y + 2);
    doc.font('Helvetica').fillColor(C.dark);
    doc.text(s.label, 60, y + 2, { width: 160 });
    doc.font('Helvetica-Bold').fillColor(C.black);
    doc.text(s.value, 230, y + 2, { width: doc.page.width - 280, align: 'left' });
    y += 14;
  });
  return y;
}

function checkPageBreak(doc, y, needed) {
  if (y + needed > doc.page.height - 60) {
    doc.addPage();
    doc._y = 50;
  } else {
    doc._y = y;
  }
}


// ── GET /api/reports/financial ────────────────────────
router.get('/financial', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { from, to } = req.query;

    // ── Fetch all data ─────────────────────────────
    const txnParams = [];
    const txnWheres = [];
    if (from) { txnParams.push(from); txnWheres.push(`t.date >= $${txnParams.length}`); }
    if (to)   { txnParams.push(to);   txnWheres.push(`t.date <= $${txnParams.length}`); }
    const txnWhere = txnWheres.length ? 'WHERE ' + txnWheres.join(' AND ') : '';

    const [txnResult, tourResult, streamResult, splitResult, memberResult] = await Promise.all([
      pool.query(`
        SELECT t.*, c.name AS category FROM transactions t
        LEFT JOIN categories c ON c.id = t.category_id
        ${txnWhere} ORDER BY t.date ASC
      `, txnParams),
      pool.query(`
        SELECT t.*,
          COALESCE(SUM(CASE WHEN tx.type='income' THEN tx.amount_eur ELSE 0 END),0) AS revenue,
          COALESCE(SUM(CASE WHEN tx.type='expense' THEN tx.amount_eur ELSE 0 END),0) AS costs
        FROM tours t LEFT JOIN transactions tx ON tx.tour_id = t.id
        GROUP BY t.id ORDER BY t.start_date DESC NULLS LAST
      `),
      pool.query(`SELECT * FROM streaming_snapshots ORDER BY period DESC`),
      pool.query(`
        SELECT s.*, array_agg(
          json_build_object('member',m.member_name,'base',m.base_share,'expenses',m.expenses_eur,'net',m.net_eur)
          ORDER BY m.member_name
        ) AS members FROM gig_splits s
        LEFT JOIN gig_split_members m ON m.split_id = s.id
        GROUP BY s.id ORDER BY s.gig_date DESC
      `),
      pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'member_account_txns'`).then(async (check) => {
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

    // ── Compute financial intelligence (mirrors frontend) ──
    const income   = txns.filter(t => t.type === 'income');
    const expenses = txns.filter(t => t.type === 'expense');
    const totalIncome  = income.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const totalExpense = expenses.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const netPosition  = totalIncome - totalExpense;

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
      if (t.type === 'income') byMonth[m].inc += amt; else byMonth[m].exp += amt;
    });

    // By year
    const revByYear = {};
    const expByYear = {};
    txns.forEach(t => {
      const y = new Date(t.date).getFullYear();
      if (!revByYear[y]) { revByYear[y] = 0; expByYear[y] = 0; }
      const amt = parseFloat(t.amount_eur || t.amount);
      if (t.type === 'income') revByYear[y] += amt; else expByYear[y] += amt;
    });
    const years = Object.keys(revByYear).sort().map(Number);

    // Gig economics
    const gigEntries = income.filter(t => t.category === 'Espetáculo');
    const gigCount   = gigEntries.length;
    const gigRevenue = gigEntries.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const avgGigFee  = gigCount ? gigRevenue / gigCount : 0;
    const DIRECT_GIG_CATS = ['Transporte', 'Outros'];
    const directGigCosts = expenses.filter(t => DIRECT_GIG_CATS.includes(t.category)).reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const costPerGig = gigCount ? directGigCosts / gigCount : 0;
    const gigMargin  = avgGigFee ? (avgGigFee - costPerGig) / avgGigFee : null;
    const grossMargin = totalIncome > 0 ? netPosition / totalIncome : 0;

    // Burn rate & runway
    const now = new Date();
    const t12 = new Date(now); t12.setFullYear(t12.getFullYear() - 1);
    const trailing12Exp = expenses.filter(t => new Date(t.date) >= t12).reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const trailing12OpExp = expenses.filter(t => new Date(t.date) >= t12 && t.category !== 'Equipamento').reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const opBurn = trailing12OpExp / 12;
    const balance = netPosition; // simplified — matches inception P&L
    const runwayMonths = opBurn > 0 ? balance / opBurn : Infinity;

    // YoY growth
    const activeYears = years.filter(y => revByYear[y] > 0);
    let yoyGrowth = null;
    if (activeYears.length >= 2) {
      const last = activeYears[activeYears.length - 1];
      const prev = activeYears[activeYears.length - 2];
      if (revByYear[prev] > 0) yoyGrowth = (revByYear[last] - revByYear[prev]) / revByYear[prev];
    }

    // Investment breakdown
    const investCats = ['Estúdio', 'Artwork', 'Distribuição', 'Equipamento'];
    const investmentTotal = expenses.filter(t => investCats.includes(t.category)).reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);

    // Streaming
    const totalStreams = streams.reduce((s, p) => s + (p.streams || 0), 0);
    const totalStreamRev = streams.reduce((s, p) => s + parseFloat(p.revenue_eur || 0), 0);

    // DCF valuation (mirrors frontend — 5yr, 12% discount)
    const discountRate = 0.12;
    const growthRate = yoyGrowth !== null ? Math.min(Math.max(yoyGrowth, -0.5), 1.0) : 0.05;
    const baseRevenue = activeYears.length ? revByYear[activeYears[activeYears.length - 1]] : totalIncome / Math.max(years.length, 1);
    let dcfTotal = 0;
    const dcfYears = [];
    for (let i = 1; i <= 5; i++) {
      const projected = baseRevenue * Math.pow(1 + growthRate, i);
      const pv = projected / Math.pow(1 + discountRate, i);
      dcfTotal += pv;
      dcfYears.push({ year: now.getFullYear() + i, projected: projected, pv: pv });
    }
    // Terminal value
    const terminalGrowth = 0.02;
    const terminalValue = (dcfYears[4].projected * (1 + terminalGrowth)) / (discountRate - terminalGrowth);
    const terminalPV = terminalValue / Math.pow(1 + discountRate, 5);
    dcfTotal += terminalPV;

    // Break-even
    const fixedCosts = trailing12OpExp;
    const avgContribution = avgGigFee - costPerGig;
    const breakEvenGigs = avgContribution > 0 ? Math.ceil(fixedCosts / avgContribution) : null;

    // Period label
    const periodLabel = from || to
      ? `${from || 'Start'} to ${to || 'Present'}`
      : txns.length ? `${fmtDate(txns[0].date)} to ${fmtDate(txns[txns.length - 1].date)}` : 'No transactions';

    // ── Build PDF ──────────────────────────────────
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
      bufferPages: true,
      info: {
        Title: 'The Ginskeys — Financial Report',
        Author: 'The Ginskeys Financial Terminal',
        Subject: `Financial Report — ${periodLabel}`,
      },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="ginskeys-financial-report-${new Date().toISOString().slice(0, 10)}.pdf"`);
    doc.pipe(res);

    const pageW = doc.page.width;
    let y = 50;

    // ═══════════════════════════════════════════════
    // PAGE 1: COVER + EXECUTIVE SUMMARY
    // ═══════════════════════════════════════════════
    doc.rect(0, 0, pageW, 120).fill(C.headerBg);
    doc.fontSize(28).font('Helvetica-Bold').fillColor(C.accent);
    doc.text('THE GINSKEYS', 40, 30, { width: pageW - 80 });
    doc.fontSize(10).font('Helvetica').fillColor('#AAAAAA');
    doc.text('FINANCIAL REPORT', 40, 62);
    doc.fontSize(9).fillColor('#888888');
    doc.text(`Period: ${periodLabel}`, 40, 78);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, 40, 92);
    doc.text(`Prepared by: The Ginskeys Financial Terminal v1.0`, 40, 104);
    doc.fillColor(C.black);
    y = 136;

    // ── Financial Summary KPIs ─────────────────────
    y = drawHeader(doc, 'Financial Summary', y);
    y = drawKpiRow(doc, [
      { label: 'Total Revenue', value: fmtEur(totalIncome), color: C.green },
      { label: 'Total Expenses', value: fmtEur(totalExpense), color: C.red },
      { label: 'Net Position', value: fmtEur(netPosition), color: netPosition >= 0 ? C.green : C.red },
      { label: 'Transactions', value: String(txns.length), color: C.black },
    ], y);
    y += 2;
    y = drawKpiRow(doc, [
      { label: 'Gross Margin', value: fmtPct(grossMargin), color: grossMargin > 0.5 ? C.green : C.amber },
      { label: 'Gig Count', value: String(gigCount), color: C.black },
      { label: 'Avg Gig Fee', value: fmtEur(avgGigFee), color: C.black },
      { label: 'Cost Per Gig', value: fmtEur(costPerGig), color: C.black },
    ], y);
    y += 2;
    y = drawKpiRow(doc, [
      { label: 'Gig Margin', value: gigMargin !== null ? fmtPct(gigMargin) : '—', color: gigMargin > 0.6 ? C.green : C.amber },
      { label: 'Op. Burn/Month', value: fmtEur(opBurn), color: C.red },
      { label: 'Cash Runway', value: runwayMonths === Infinity ? '∞' : runwayMonths.toFixed(1) + ' mo', color: runwayMonths > 12 ? C.green : C.amber },
      { label: 'Revenue Growth YoY', value: yoyGrowth !== null ? fmtPct(yoyGrowth) : '—', color: yoyGrowth > 0 ? C.green : C.red },
    ], y);
    y += 10;

    // ── Revenue Breakdown ──────────────────────────
    y = drawHeader(doc, 'Revenue by Category', y);
    const incRows = Object.entries(incByCat).sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => [cat, fmtPct(amt / totalIncome), fmtEur(amt)]);
    if (incRows.length) { incRows.push(['TOTAL', '100%', fmtEur(totalIncome)]); }
    y = drawTable(doc, ['Category', 'Share', 'Amount (EUR)'], incRows.length ? incRows : [['No revenue', '', '']], y, [200, 120, 195]);
    y += 6;

    // ── Expense Breakdown ──────────────────────────
    y = drawHeader(doc, 'Expenses by Category (Spend Breakdown)', y);
    const expRows = Object.entries(expByCat).sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => [cat, fmtPct(amt / totalExpense), fmtEur(amt)]);
    if (expRows.length) { expRows.push(['TOTAL', '100%', fmtEur(totalExpense)]); }
    y = drawTable(doc, ['Category', 'Share', 'Amount (EUR)'], expRows.length ? expRows : [['No expenses', '', '']], y, [200, 120, 195]);
    y += 6;

    // ── Revenue by Year ────────────────────────────
    if (years.length > 1) {
      y = drawHeader(doc, 'Revenue Composition by Year', y);
      const yearRows = years.map(yr => {
        const rev = revByYear[yr] || 0;
        const exp = expByYear[yr] || 0;
        const net = rev - exp;
        return [String(yr), fmtEur(rev), fmtEur(exp), (net >= 0 ? '+' : '') + fmtEur(net)];
      });
      y = drawTable(doc, ['Year', 'Revenue', 'Expenses', 'Net'], yearRows, y, [100, 140, 140, 135]);
      y += 6;
    }

    // ═══════════════════════════════════════════════
    // PAGE 2: CASH FLOW + FINANCIAL INTELLIGENCE
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
    y += 10;

    // ── DCF Valuation ──────────────────────────────
    y = drawHeader(doc, 'DCF Valuation — 5 Year Horizon', y);
    y = drawTextBlock(doc, 'Enterprise Value (DCF)', fmtEur(dcfTotal), y);
    y = drawTextBlock(doc, 'Assumptions',
      `Discount rate: 12% · Growth rate: ${fmtPct(growthRate)} (based on YoY revenue trend) · Terminal growth: 2% · Base revenue: ${fmtEur(baseRevenue)}/year`, y);

    const dcfRows = dcfYears.map(d => [String(d.year), fmtEur(d.projected), fmtEur(d.pv)]);
    dcfRows.push(['Terminal Value', fmtEur(terminalValue), fmtEur(terminalPV)]);
    dcfRows.push(['TOTAL', '', fmtEur(dcfTotal)]);
    y = drawTable(doc, ['Year', 'Projected Revenue', 'Present Value'], dcfRows, y, [120, 195, 200]);
    y += 10;

    // ── Scenario Analysis ──────────────────────────
    y = drawHeader(doc, 'Scenario Analysis — 12 Month Forward', y);
    const scenarios = [
      { name: 'Conservative', gigs: Math.max(2, gigCount), fee: avgGigFee * 0.9, extraRev: 0 },
      { name: 'Base Case', gigs: Math.max(4, Math.round(gigCount * 1.2)), fee: avgGigFee, extraRev: totalStreamRev * 12 },
      { name: 'Optimistic', gigs: Math.max(6, Math.round(gigCount * 1.5)), fee: avgGigFee * 1.15, extraRev: totalStreamRev * 24 + 500 },
    ];
    const scenRows = scenarios.map(s => {
      const rev = s.gigs * s.fee + s.extraRev;
      const exp = trailing12OpExp;
      const net = rev - exp;
      return [s.name, String(s.gigs) + ' gigs', fmtEur(s.fee) + '/gig', fmtEur(rev), fmtEur(net)];
    });
    y = drawTable(doc, ['Scenario', 'Gigs', 'Avg Fee', 'Projected Revenue', 'Net'], scenRows, y, [90, 60, 90, 120, 155]);
    y += 10;

    // ── Break-Even Analysis ────────────────────────
    y = drawHeader(doc, 'Break-Even Analysis', y);
    y = drawTextBlock(doc, 'Fixed Annual Costs (trailing 12mo, excl. equipment)',
      fmtEur(fixedCosts), y);
    y = drawTextBlock(doc, 'Average Contribution Per Gig',
      `Revenue ${fmtEur(avgGigFee)} − Direct costs ${fmtEur(costPerGig)} = ${fmtEur(avgContribution)}`, y);
    y = drawTextBlock(doc, 'Break-Even Point',
      breakEvenGigs !== null
        ? `${breakEvenGigs} gigs/year to cover operating costs`
        : 'Insufficient data — no gig history', y);
    y += 6;

    // ── Strategic Signals ──────────────────────────
    y = drawHeader(doc, 'Strategic Signals', y);
    const signals = [
      { label: 'Gig margin', value: gigMargin !== null ? fmtPct(gigMargin) : '—', ok: gigMargin > 0.6, warn: gigMargin > 0.4 },
      { label: 'Revenue diversification', value: totalStreamRev > 0 ? 'Streaming active' : 'Live only', ok: totalStreamRev > 0, warn: false },
      { label: 'Cash runway', value: runwayMonths === Infinity ? '∞' : runwayMonths.toFixed(1) + ' months', ok: runwayMonths > 12, warn: runwayMonths > 6 },
      { label: 'Revenue trend (YoY)', value: yoyGrowth !== null ? fmtPct(yoyGrowth) : 'Insufficient data', ok: yoyGrowth > 0, warn: yoyGrowth === null },
      { label: 'Investment ratio', value: totalExpense > 0 ? fmtPct(investmentTotal / totalExpense) : '—', ok: investmentTotal / totalExpense > 0.3, warn: investmentTotal / totalExpense > 0.15 },
      { label: 'Gig frequency', value: gigCount + ' total gigs', ok: gigCount >= 4, warn: gigCount >= 2 },
    ];
    y = drawSignalRow(doc, signals, y);
    y += 6;

    // ═══════════════════════════════════════════════
    // PAGE 3: TOUR P&L + SPLITS + MEMBERS + STREAMING
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

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
      y += 10;
    }

    // ── Gig Splits ─────────────────────────────────
    if (splits.length) {
      y = drawHeader(doc, 'Gig Split History', y);
      const splitRows = splits.map(s => [
        s.gig_name, fmtDate(s.gig_date), fmtEur(parseFloat(s.gross_eur)),
        fmtEur(parseFloat(s.band_fund_eur || 0)), fmtEur(parseFloat(s.per_member_eur)),
        String(s.member_count || '—'),
      ]);
      y = drawTable(doc, ['Gig', 'Date', 'Gross', 'Band Fund', 'Per Member', 'Members'],
        splitRows, y, [130, 65, 80, 75, 80, 55]);
      y += 10;
    }

    // ── Member Account Balances ────────────────────
    if (members.length) {
      y = drawHeader(doc, 'Member Account Balances', y);
      const memberRows = members.map(m => [
        m.member_name || m.member_key,
        fmtEur(parseFloat(m.total_in)), fmtEur(parseFloat(m.total_out)), fmtEur(parseFloat(m.balance)),
      ]);
      y = drawTable(doc, ['Member', 'Total In', 'Total Out', 'Balance'],
        memberRows, y, [160, 115, 115, 125]);
      y += 10;
    }

    // ── Streaming Summary ──────────────────────────
    if (streams.length) {
      y = drawHeader(doc, 'Streaming Performance', y);
      const byPlatform = {};
      streams.forEach(s => {
        if (!byPlatform[s.platform]) byPlatform[s.platform] = { streams: 0, rev: 0 };
        byPlatform[s.platform].streams += s.streams || 0;
        byPlatform[s.platform].rev += parseFloat(s.revenue_eur || 0);
      });
      const streamRows = Object.entries(byPlatform)
        .sort((a, b) => b[1].streams - a[1].streams)
        .map(([p, d]) => [p.charAt(0).toUpperCase() + p.slice(1), d.streams.toLocaleString(), fmtEur(d.rev)]);
      streamRows.push(['TOTAL', totalStreams.toLocaleString(), fmtEur(totalStreamRev)]);
      y = drawTable(doc, ['Platform', 'Total Streams', 'Revenue (EUR)'],
        streamRows, y, [200, 150, 165]);
      y += 10;
    }

    // ── Live Alerts / Recommendations ──────────────
    y = drawHeader(doc, 'Recommendations', y);
    const recs = [];
    if (gigMargin !== null && gigMargin < 0.6) recs.push('Gig margin below 60% — review transport costs or increase booking fees.');
    if (runwayMonths < 9 && runwayMonths !== Infinity) recs.push(`Cash runway is ${runwayMonths.toFixed(1)} months — build reserves or reduce non-essential spending.`);
    if (totalStreamRev === 0) recs.push('No streaming revenue — register on Spotify for Artists and pitch every new release.');
    if (gigCount < 4) recs.push('Fewer than 4 gigs on record — target summer festivals in Alentejo/Algarve for volume.');
    if (yoyGrowth !== null && yoyGrowth < 0) recs.push('Revenue declining year-over-year — diversify with streaming, sync licensing, or corporate bookings.');
    if (breakEvenGigs && breakEvenGigs > 6) recs.push(`Need ${breakEvenGigs} gigs/year to break even — reduce fixed costs or increase per-gig fees.`);
    if (!recs.length) recs.push('Financial health is solid. Continue current trajectory and reinvest into releases and marketing.');
    recs.forEach(r => { y = drawTextBlock(doc, '→', r, y); });

    // ═══════════════════════════════════════════════
    // APPENDIX: FULL TRANSACTION LEDGER
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

    y = drawHeader(doc, `Appendix — Transaction Ledger (${txns.length} entries)`, y);
    let running = 0;
    const ledgerRows = txns.map(t => {
      const amt = parseFloat(t.amount_eur || t.amount);
      const signed = t.type === 'income' ? amt : -amt;
      running += signed;
      return [
        fmtDate(t.date), (t.description || '').slice(0, 38), t.category || '—',
        t.type === 'income' ? '+' + fmtEur(amt) : '-' + fmtEur(amt),
        fmtEur(running),
      ];
    });
    y = drawTable(doc, ['Date', 'Description', 'Category', 'Amount', 'Balance'],
      ledgerRows, y, [60, 185, 80, 90, 100]);

    // ── Footer on every page ───────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(7).font('Helvetica').fillColor(C.light);
      doc.text(
        `The Ginskeys Financial Terminal — Page ${i + 1} of ${pages.count} — Confidential`,
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

// ── GET /api/reports/weekly ─────────────────────────
// Preview/download the weekly synthesis PDF on demand, without emailing it.
router.get('/weekly', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { generateWeeklySynthesisPDF } = require('../lib/weeklyReport');
    const pdfBuffer = await generateWeeklySynthesisPDF();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="ginskeys-weekly-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) { next(err); }
});

// ── POST /api/reports/weekly/send ───────────────────
// Generate the weekly synthesis PDF and email it to BAND_OFFICIAL_EMAIL
// (or an explicit `to` in the request body, for testing) right now.
router.post('/weekly/send', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { generateWeeklySynthesisPDF, gatherWeekData, buildEmailHtml } = require('../lib/weeklyReport');
    const { sendMail, isConfigured } = require('../lib/mailer');

    if (!isConfigured()) {
      return res.status(400).json({
        error: 'Email is not configured. Set RESEND_API_KEY in Railway Variables (free at resend.com/api-keys).',
      });
    }

    const to = req.body?.to || process.env.BAND_OFFICIAL_EMAIL;
    if (!to) {
      return res.status(400).json({ error: 'No recipient — set BAND_OFFICIAL_EMAIL in Railway Variables, or pass "to" in the request body.' });
    }

    const weekData = await gatherWeekData();
    const pdfBuffer = await generateWeeklySynthesisPDF(weekData);
    const dateLabel = new Date().toISOString().slice(0, 10);

    await sendMail({
      to,
      subject: `The Ginskeys — Síntese Semanal (${dateLabel})`,
      html: buildEmailHtml(weekData),
      attachments: [{
        filename: `ginskeys-weekly-${dateLabel}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    });

    await writeAudit(req, 'WEEKLY_REPORT_SENT', { details: `Sent to ${to}` });
    res.json({ ok: true, sent_to: to });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.helpers = { fmtEur, fmtDate, fmtPct, C, drawHeader, drawSubheader, drawKpiRow, drawTable, drawTextBlock, drawSignalRow, checkPageBreak };
