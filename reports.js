// ══════════════════════════════════════════════════
// REPORTS ROUTES — /api/reports
// Server-side PDF with PDFKit-drawn charts
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

function fmtEurShort(n) {
  const abs = Math.abs(n || 0);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1000) return sign + '€' + (abs / 1000).toFixed(1) + 'K';
  return sign + '€' + abs.toFixed(0);
}

// FIX: Postgres DATE columns come as JS Date objects, not strings
function fmtDate(d) {
  if (!d) return '—';
  if (d instanceof Date && !isNaN(d)) return d.toISOString().slice(0, 10);
  const s = String(d);
  if (s.includes('T')) return s.slice(0, 10);
  return s;
}

// Extract YYYY-MM from a date value
function toYearMonth(d) {
  if (!d) return '0000-00';
  if (d instanceof Date && !isNaN(d)) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }
  return fmtDate(d).slice(0, 7);
}

// Extract year from a date value
function toYear(d) {
  if (!d) return 0;
  if (d instanceof Date && !isNaN(d)) return d.getFullYear();
  return parseInt(fmtDate(d).slice(0, 4)) || 0;
}

function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

// ── Colour palette ───────────────────────────────────
const C = {
  black: '#111111', dark: '#333333', muted: '#666666', light: '#999999',
  accent: '#FF5C1A', green: '#166534', greenBright: '#22C55E', greenBg: '#DCFCE7',
  red: '#DC2626', redBright: '#EF4444', redBg: '#FEE2E2',
  amber: '#92400E', amberBright: '#F59E0B',
  blue: '#1E3A8A', blueBright: '#3B82F6', blueBg: '#DBEAFE',
  purple: '#6B21A8', purpleBright: '#A855F7',
  bg: '#F8F8F8', line: '#DDDDDD', headerBg: '#1a1a1a', headerFg: '#FFFFFF',
};

// ── PDF drawing helpers ──────────────────────────────
function ensureSpace(doc, y, needed) {
  if (y + needed > doc.page.height - 60) { doc.addPage(); return 50; }
  return y;
}

function drawHeader(doc, text, y) {
  y = ensureSpace(doc, y, 30);
  doc.save();
  doc.rect(40, y, doc.page.width - 80, 22).fill(C.headerBg);
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.headerFg);
  doc.text(text.toUpperCase(), 48, y + 6, { width: doc.page.width - 96 });
  doc.restore().fillColor(C.black);
  return y + 28;
}

function drawKpiRow(doc, items, y) {
  y = ensureSpace(doc, y, 48);
  const colW = (doc.page.width - 80) / items.length;
  items.forEach((item, i) => {
    const x = 40 + i * colW;
    doc.rect(x, y, colW - 4, 38).fill(C.bg).stroke(C.line);
    doc.fontSize(6.5).font('Helvetica').fillColor(C.light);
    doc.text(item.label.toUpperCase(), x + 8, y + 5, { width: colW - 16 });
    doc.fontSize(11).font('Helvetica-Bold').fillColor(item.color || C.black);
    doc.text(item.value, x + 8, y + 17, { width: colW - 16 });
  });
  doc.fillColor(C.black);
  return y + 44;
}

function drawTable(doc, headers, rows, y, colWidths) {
  const tableW = doc.page.width - 80;
  const rowH = 15;
  if (!colWidths) colWidths = headers.map(() => tableW / headers.length);
  y = ensureSpace(doc, y, rowH * 3);

  doc.rect(40, y, tableW, rowH).fill('#EEEEEE');
  doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.dark);
  let x = 40;
  headers.forEach((h, i) => {
    const align = i >= headers.length - 2 ? 'right' : 'left';
    doc.text(h, x + 4, y + 4, { width: colWidths[i] - 8, align });
    x += colWidths[i];
  });
  y += rowH;

  doc.font('Helvetica').fontSize(6.5);
  rows.forEach((row, ri) => {
    if (y + rowH > doc.page.height - 60) { doc.addPage(); y = 50; }
    if (ri % 2 === 1) doc.rect(40, y, tableW, rowH).fill('#FAFAFA');
    x = 40;
    row.forEach((cell, ci) => {
      const align = ci >= headers.length - 2 ? 'right' : 'left';
      const cs = String(cell);
      const color = cs.startsWith('-€') ? C.red : cs.startsWith('+€') ? C.green : C.black;
      doc.fillColor(color);
      doc.text(cs, x + 4, y + 4, { width: colWidths[ci] - 8, align });
      x += colWidths[ci];
    });
    y += rowH;
  });
  doc.fillColor(C.black);
  return y + 4;
}

function drawTextBlock(doc, label, content, y) {
  y = ensureSpace(doc, y, 30);
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.dark).text(label, 44, y, { width: doc.page.width - 88 });
  y += 11;
  doc.fontSize(7.5).font('Helvetica').fillColor(C.muted).text(content, 44, y, { width: doc.page.width - 88 });
  return doc.y + 6;
}

// ── CHART: Vertical bar chart ────────────────────────
function drawBarChart(doc, data, y, opts = {}) {
  const { height = 130, title = '', showLegend = true } = opts;
  y = ensureSpace(doc, y, height + 40);
  const chartX = 80;
  const chartW = doc.page.width - 120;
  const chartY = y;
  const chartH = height;
  const barCount = data.labels.length;
  if (barCount === 0) return y + 20;
  const groupW = chartW / barCount;
  const barW = Math.min(groupW * 0.35, 20);
  const datasets = data.datasets;

  // Find max value for scale
  let maxVal = 0;
  datasets.forEach(ds => ds.data.forEach(v => { if (Math.abs(v) > maxVal) maxVal = Math.abs(v); }));
  if (maxVal === 0) maxVal = 100;
  maxVal *= 1.15; // padding

  // Y-axis gridlines
  const gridLines = 5;
  doc.lineWidth(0.3).strokeColor('#E5E5E5');
  for (let i = 0; i <= gridLines; i++) {
    const gy = chartY + chartH - (i / gridLines) * chartH;
    doc.moveTo(chartX, gy).lineTo(chartX + chartW, gy).stroke();
    const val = (maxVal * i / gridLines);
    doc.fontSize(6).font('Helvetica').fillColor(C.light);
    doc.text(fmtEurShort(val), 40, gy - 4, { width: 36, align: 'right' });
  }

  // Zero line if negative values exist
  const hasNeg = datasets.some(ds => ds.data.some(v => v < 0));
  const zeroY = chartY + chartH;

  // Draw bars
  datasets.forEach((ds, di) => {
    const offset = (di - (datasets.length - 1) / 2) * (barW + 2);
    ds.data.forEach((val, i) => {
      const cx = chartX + i * groupW + groupW / 2 + offset;
      const barH = (Math.abs(val) / maxVal) * chartH;
      const by = val >= 0 ? zeroY - barH : zeroY;
      doc.rect(cx - barW / 2, by, barW, barH).fill(ds.color);
    });
  });

  // X-axis labels
  doc.fontSize(5.5).font('Helvetica').fillColor(C.muted);
  data.labels.forEach((label, i) => {
    const cx = chartX + i * groupW + groupW / 2;
    doc.text(label, cx - 20, chartY + chartH + 4, { width: 40, align: 'center' });
  });

  // Legend
  if (showLegend && datasets.length > 1) {
    let lx = chartX;
    const ly = chartY + chartH + 16;
    datasets.forEach(ds => {
      doc.rect(lx, ly, 8, 6).fill(ds.color);
      doc.fontSize(6).font('Helvetica').fillColor(C.dark);
      doc.text(ds.label, lx + 11, ly, { width: 60 });
      lx += 70;
    });
    return ly + 14;
  }

  return chartY + chartH + 18;
}

// ── CHART: Horizontal bar chart (category breakdown) ──
function drawHorizontalBars(doc, items, y, opts = {}) {
  const { maxWidth = 300, height = 14, title = '' } = opts;
  y = ensureSpace(doc, y, items.length * (height + 4) + 10);
  const maxVal = Math.max(...items.map(i => i.value), 1);
  const startX = 140;

  items.forEach((item, i) => {
    const iy = y + i * (height + 4);
    // Label
    doc.fontSize(7).font('Helvetica').fillColor(C.dark);
    doc.text(item.label, 44, iy + 2, { width: 90 });
    // Bar
    const barW = (item.value / maxVal) * maxWidth;
    doc.rect(startX, iy, barW, height - 2).fill(item.color || C.blueBright);
    // Value
    doc.fontSize(6.5).font('Helvetica-Bold').fillColor(C.dark);
    doc.text(item.display || fmtEur(item.value), startX + barW + 6, iy + 2, { width: 100 });
  });

  return y + items.length * (height + 4) + 8;
}

// ── CHART: Balance sparkline ─────────────────────────
function drawSparkline(doc, points, y, opts = {}) {
  const { height = 60, title = '' } = opts;
  y = ensureSpace(doc, y, height + 30);
  const chartX = 80;
  const chartW = doc.page.width - 120;

  if (title) {
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C.dark);
    doc.text(title, 44, y); y += 12;
  }

  if (points.length < 2) return y + 10;

  const minVal = Math.min(...points.map(p => p.y));
  const maxVal = Math.max(...points.map(p => p.y));
  const range = maxVal - minVal || 1;

  // Fill area
  doc.save();
  doc.moveTo(chartX, y + height);
  points.forEach((p, i) => {
    const px = chartX + (i / (points.length - 1)) * chartW;
    const py = y + height - ((p.y - minVal) / range) * height;
    if (i === 0) doc.lineTo(px, py); else doc.lineTo(px, py);
  });
  doc.lineTo(chartX + chartW, y + height);
  doc.closePath().fill('#E8F5E9');
  doc.restore();

  // Line
  doc.save().lineWidth(1.5).strokeColor(C.greenBright);
  points.forEach((p, i) => {
    const px = chartX + (i / (points.length - 1)) * chartW;
    const py = y + height - ((p.y - minVal) / range) * height;
    if (i === 0) doc.moveTo(px, py); else doc.lineTo(px, py);
  });
  doc.stroke().restore();

  // Start/end labels
  doc.fontSize(6).font('Helvetica').fillColor(C.muted);
  doc.text(points[0].label || '', chartX, y + height + 4, { width: 50 });
  doc.text(points[points.length - 1].label || '', chartX + chartW - 50, y + height + 4, { width: 50, align: 'right' });

  // Min/max labels
  doc.fontSize(6).fillColor(C.light);
  doc.text(fmtEurShort(maxVal), 40, y - 2, { width: 36, align: 'right' });
  doc.text(fmtEurShort(minVal), 40, y + height - 6, { width: 36, align: 'right' });

  return y + height + 18;
}

// ── CHART: Signal indicators ─────────────────────────
function drawSignals(doc, signals, y) {
  signals.forEach(s => {
    y = ensureSpace(doc, y, 16);
    const color = s.ok ? C.greenBright : s.warn ? C.amberBright : C.redBright;
    // Dot
    doc.circle(52, y + 5, 3).fill(color);
    // Label
    doc.fontSize(7).font('Helvetica').fillColor(C.dark);
    doc.text(s.label, 62, y + 1, { width: 150 });
    // Value
    doc.font('Helvetica-Bold').fillColor(s.ok ? C.green : s.warn ? C.amber : C.red);
    doc.text(s.value, 220, y + 1, { width: doc.page.width - 270 });
    y += 14;
  });
  return y;
}


// ══════════════════════════════════════════════════════
// GET /api/reports/financial
// ══════════════════════════════════════════════════════
router.get('/financial', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { from, to } = req.query;

    // ── Fetch data ─────────────────────────────────
    const txnParams = [];
    const txnWheres = [];
    if (from) { txnParams.push(from); txnWheres.push(`t.date >= $${txnParams.length}`); }
    if (to)   { txnParams.push(to);   txnWheres.push(`t.date <= $${txnParams.length}`); }
    const txnWhere = txnWheres.length ? 'WHERE ' + txnWheres.join(' AND ') : '';

    const [txnResult, tourResult, streamResult, splitResult, memberResult] = await Promise.all([
      pool.query(`SELECT t.*, c.name AS category FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ${txnWhere} ORDER BY t.date ASC`, txnParams),
      pool.query(`SELECT t.*, COALESCE(SUM(CASE WHEN tx.type='income' THEN tx.amount_eur ELSE 0 END),0) AS revenue, COALESCE(SUM(CASE WHEN tx.type='expense' THEN tx.amount_eur ELSE 0 END),0) AS costs FROM tours t LEFT JOIN transactions tx ON tx.tour_id = t.id GROUP BY t.id ORDER BY t.start_date DESC NULLS LAST`),
      pool.query(`SELECT * FROM streaming_snapshots ORDER BY period DESC`),
      pool.query(`SELECT s.*, array_agg(json_build_object('member',m.member_name,'base',m.base_share,'expenses',m.expenses_eur,'net',m.net_eur) ORDER BY m.member_name) AS members FROM gig_splits s LEFT JOIN gig_split_members m ON m.split_id = s.id GROUP BY s.id ORDER BY s.gig_date DESC`),
      pool.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'member_account_txns'`).then(async (chk) => {
        if (chk.rows.length === 0) return { rows: [] };
        return pool.query(`SELECT member_key, (array_agg(member_name ORDER BY created_at DESC))[1] AS member_name, COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE 0 END),0) AS total_in, COALESCE(SUM(CASE WHEN txn_type = 'withdrawal' THEN amount ELSE 0 END),0) AS total_out, COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE -amount END),0) AS balance FROM member_account_txns GROUP BY member_key ORDER BY member_key`);
      }),
    ]);

    const txns = txnResult.rows;
    const tours = tourResult.rows;
    const streams = streamResult.rows;
    const splits = splitResult.rows;
    const members = memberResult.rows;

    // ── Aggregates ─────────────────────────────────
    const income = txns.filter(t => t.type === 'income');
    const expenses = txns.filter(t => t.type === 'expense');
    const totalIncome = income.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const totalExpense = expenses.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const netPosition = totalIncome - totalExpense;
    const grossMargin = totalIncome > 0 ? netPosition / totalIncome : 0;

    const incByCat = {};
    income.forEach(t => { const c = t.category || 'Outros'; incByCat[c] = (incByCat[c] || 0) + parseFloat(t.amount_eur || t.amount); });
    const expByCat = {};
    expenses.forEach(t => { const c = t.category || 'Outros'; expByCat[c] = (expByCat[c] || 0) + parseFloat(t.amount_eur || t.amount); });

    // By month (FIXED: use proper YYYY-MM extraction)
    const byMonth = {};
    txns.forEach(t => {
      const m = toYearMonth(t.date);
      if (!byMonth[m]) byMonth[m] = { inc: 0, exp: 0 };
      const amt = parseFloat(t.amount_eur || t.amount);
      if (t.type === 'income') byMonth[m].inc += amt; else byMonth[m].exp += amt;
    });

    // By year
    const revByYear = {};
    const expByYear = {};
    txns.forEach(t => {
      const y = toYear(t.date);
      if (!revByYear[y]) { revByYear[y] = 0; expByYear[y] = 0; }
      const amt = parseFloat(t.amount_eur || t.amount);
      if (t.type === 'income') revByYear[y] += amt; else expByYear[y] += amt;
    });
    const years = Object.keys(revByYear).sort().map(Number);

    // Gig economics
    const gigEntries = income.filter(t => t.category === 'Espetáculo');
    const gigCount = gigEntries.length;
    const gigRevenue = gigEntries.reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const avgGigFee = gigCount ? gigRevenue / gigCount : 0;
    const directGigCosts = expenses.filter(t => ['Transporte', 'Outros'].includes(t.category)).reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const costPerGig = gigCount ? directGigCosts / gigCount : 0;
    const gigMargin = avgGigFee ? (avgGigFee - costPerGig) / avgGigFee : null;

    // Burn & runway
    const now = new Date();
    const t12 = new Date(now); t12.setFullYear(t12.getFullYear() - 1);
    const trailing12OpExp = expenses.filter(t => new Date(t.date) >= t12 && t.category !== 'Equipamento').reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);
    const opBurn = trailing12OpExp / 12;
    const runwayMonths = opBurn > 0 ? netPosition / opBurn : Infinity;

    // YoY
    const activeYears = years.filter(y => revByYear[y] > 0);
    let yoyGrowth = null;
    if (activeYears.length >= 2) {
      const last = activeYears[activeYears.length - 1];
      const prev = activeYears[activeYears.length - 2];
      if (revByYear[prev] > 0) yoyGrowth = (revByYear[last] - revByYear[prev]) / revByYear[prev];
    }

    // Investment
    const investCats = ['Estúdio', 'Artwork', 'Distribuição', 'Equipamento'];
    const investmentTotal = expenses.filter(t => investCats.includes(t.category)).reduce((s, t) => s + parseFloat(t.amount_eur || t.amount), 0);

    // DCF
    const discountRate = 0.12;
    const growthRate = yoyGrowth !== null ? Math.min(Math.max(yoyGrowth, -0.5), 1.0) : 0.05;
    const baseRevenue = activeYears.length ? revByYear[activeYears[activeYears.length - 1]] : totalIncome / Math.max(years.length, 1);
    let dcfTotal = 0;
    const dcfYears = [];
    for (let i = 1; i <= 5; i++) {
      const proj = baseRevenue * Math.pow(1 + growthRate, i);
      const pv = proj / Math.pow(1 + discountRate, i);
      dcfTotal += pv;
      dcfYears.push({ year: now.getFullYear() + i, projected: proj, pv });
    }
    const termGrowth = 0.02;
    const termValue = (dcfYears[4].projected * (1 + termGrowth)) / (discountRate - termGrowth);
    const termPV = termValue / Math.pow(1 + discountRate, 5);
    dcfTotal += termPV;

    // Break-even
    const fixedCosts = trailing12OpExp;
    const avgContribution = avgGigFee - costPerGig;
    const breakEvenGigs = avgContribution > 0 ? Math.ceil(fixedCosts / avgContribution) : null;

    // Streaming
    const totalStreams = streams.reduce((s, p) => s + (p.streams || 0), 0);
    const totalStreamRev = streams.reduce((s, p) => s + parseFloat(p.revenue_eur || 0), 0);

    // Running balance for sparkline
    let running = 0;
    const balancePoints = txns.map(t => {
      const amt = parseFloat(t.amount_eur || t.amount);
      running += t.type === 'income' ? amt : -amt;
      return { label: toYearMonth(t.date), y: running };
    });

    // Period label
    const periodLabel = from || to
      ? `${from || 'Start'} to ${to || 'Present'}`
      : txns.length ? `${fmtDate(txns[0].date)} to ${fmtDate(txns[txns.length - 1].date)}` : 'No transactions';

    // ── Build PDF ──────────────────────────────────
    const doc = new PDFDocument({
      size: 'A4', margins: { top: 50, bottom: 50, left: 40, right: 40 },
      bufferPages: true,
      info: { Title: 'The Ginskeys — Financial Report', Author: 'The Ginskeys Financial Terminal' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="ginskeys-financial-report-${new Date().toISOString().slice(0, 10)}.pdf"`);
    doc.pipe(res);

    const pageW = doc.page.width;
    let y = 50;

    // ═══════════════════════════════════════════════
    // PAGE 1: COVER + KPIs + CHARTS
    // ═══════════════════════════════════════════════
    doc.rect(0, 0, pageW, 110).fill(C.headerBg);
    doc.fontSize(26).font('Helvetica-Bold').fillColor(C.accent).text('THE GINSKEYS', 40, 28, { width: pageW - 80 });
    doc.fontSize(10).font('Helvetica').fillColor('#AAAAAA').text('FINANCIAL REPORT', 40, 56);
    doc.fontSize(8).fillColor('#888888');
    doc.text(`Period: ${periodLabel}`, 40, 72);
    doc.text(`Generated: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}  ·  The Ginskeys Financial Terminal v1.0`, 40, 84);
    doc.fillColor(C.black);
    y = 124;

    // KPIs
    y = drawHeader(doc, 'Financial Summary', y);
    y = drawKpiRow(doc, [
      { label: 'Total Revenue', value: fmtEur(totalIncome), color: C.green },
      { label: 'Total Expenses', value: fmtEur(totalExpense), color: C.red },
      { label: 'Net Position', value: fmtEur(netPosition), color: netPosition >= 0 ? C.green : C.red },
      { label: 'Gross Margin', value: fmtPct(grossMargin), color: grossMargin > 0.5 ? C.green : C.amber },
    ], y);
    y += 2;
    y = drawKpiRow(doc, [
      { label: 'Gig Count', value: String(gigCount) },
      { label: 'Avg Gig Fee', value: fmtEur(avgGigFee) },
      { label: 'Gig Margin', value: gigMargin !== null ? fmtPct(gigMargin) : '—', color: gigMargin > 0.6 ? C.green : C.amber },
      { label: 'Cash Runway', value: runwayMonths === Infinity ? '∞' : runwayMonths.toFixed(1) + ' mo', color: runwayMonths > 12 ? C.green : C.amber },
    ], y);
    y += 8;

    // ── Revenue by Category — Horizontal Bar Chart ──
    y = drawHeader(doc, 'Revenue by Source', y);
    const incItems = Object.entries(incByCat).sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => ({ label: cat, value: amt, color: C.greenBright, display: `${fmtEur(amt)} (${fmtPct(amt / totalIncome)})` }));
    y = drawHorizontalBars(doc, incItems, y);
    y += 4;

    // ── Expense by Category — Horizontal Bar Chart ──
    y = drawHeader(doc, 'Spend Breakdown', y);
    const expColors = [C.redBright, '#F87171', '#FB923C', C.amberBright, '#FBBF24', '#A3E635', '#34D399'];
    const expItems = Object.entries(expByCat).sort((a, b) => b[1] - a[1])
      .map(([cat, amt], i) => ({ label: cat, value: amt, color: expColors[i % expColors.length], display: `${fmtEur(amt)} (${fmtPct(amt / totalExpense)})` }));
    y = drawHorizontalBars(doc, expItems, y);

    // ═══════════════════════════════════════════════
    // PAGE 2: CASH FLOW CHART + BALANCE TREND
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

    // Monthly cash flow bar chart
    y = drawHeader(doc, 'Monthly Cash Flow', y);
    const months = Object.keys(byMonth).sort();
    const monthLabels = months.map(m => {
      const parts = m.split('-');
      const shortMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(parts[1]) - 1];
      return shortMonth + "'" + parts[0].slice(2);
    });

    y = drawBarChart(doc, {
      labels: monthLabels,
      datasets: [
        { label: 'Income', data: months.map(m => byMonth[m].inc), color: C.greenBright },
        { label: 'Expenses', data: months.map(m => -byMonth[m].exp), color: C.redBright },
      ],
    }, y, { height: 140, title: 'Monthly Cash Flow' });
    y += 6;

    // Balance sparkline
    y = drawSparkline(doc, balancePoints, y, { height: 70, title: 'Running Balance Trend' });
    y += 6;

    // Monthly table
    y = drawHeader(doc, 'Monthly Detail', y);
    const monthRows = months.map(m => {
      const d = byMonth[m]; const net = d.inc - d.exp;
      return [m, fmtEur(d.inc), fmtEur(d.exp), (net >= 0 ? '+' : '') + fmtEur(net)];
    });
    y = drawTable(doc, ['Month', 'Income', 'Expenses', 'Net'], monthRows, y, [130, 125, 125, 135]);

    // ═══════════════════════════════════════════════
    // PAGE 3: FINANCIAL INTELLIGENCE
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

    // Revenue by year bar chart
    if (years.length > 1) {
      y = drawHeader(doc, 'Revenue by Year', y);
      y = drawBarChart(doc, {
        labels: years.map(String),
        datasets: [
          { label: 'Revenue', data: years.map(yr => revByYear[yr] || 0), color: C.greenBright },
          { label: 'Expenses', data: years.map(yr => -(expByYear[yr] || 0)), color: C.redBright },
        ],
      }, y, { height: 110 });
      y += 6;
    }

    // DCF
    y = drawHeader(doc, 'DCF Valuation — 5 Year Horizon', y);
    y = drawKpiRow(doc, [
      { label: 'Enterprise Value (DCF)', value: fmtEur(dcfTotal), color: C.purple },
      { label: 'Base Revenue', value: fmtEur(baseRevenue) },
      { label: 'Growth Rate', value: fmtPct(growthRate), color: growthRate > 0 ? C.green : C.red },
      { label: 'Discount Rate', value: '12%' },
    ], y);
    y += 2;
    const dcfRows = dcfYears.map(d => [String(d.year), fmtEur(d.projected), fmtEur(d.pv)]);
    dcfRows.push(['Terminal Value', fmtEur(termValue), fmtEur(termPV)]);
    dcfRows.push(['TOTAL', '', fmtEur(dcfTotal)]);
    y = drawTable(doc, ['Year', 'Projected Revenue', 'Present Value'], dcfRows, y, [120, 195, 200]);
    y += 8;

    // Scenarios
    y = drawHeader(doc, 'Scenario Analysis — 12 Month Forward', y);
    const scenarios = [
      { name: 'Conservative', gigs: Math.max(2, gigCount), fee: avgGigFee * 0.9, extra: 0 },
      { name: 'Base Case', gigs: Math.max(4, Math.round(gigCount * 1.2)), fee: avgGigFee, extra: totalStreamRev * 12 },
      { name: 'Optimistic', gigs: Math.max(6, Math.round(gigCount * 1.5)), fee: avgGigFee * 1.15, extra: totalStreamRev * 24 + 500 },
    ];
    const scenRows = scenarios.map(s => {
      const rev = s.gigs * s.fee + s.extra; const net = rev - trailing12OpExp;
      return [s.name, s.gigs + ' gigs', fmtEur(s.fee), fmtEur(rev), (net >= 0 ? '+' : '') + fmtEur(net)];
    });
    y = drawTable(doc, ['Scenario', 'Gigs', 'Avg Fee', 'Revenue', 'Net'], scenRows, y, [90, 55, 90, 120, 160]);
    y += 8;

    // Break-even
    y = drawHeader(doc, 'Break-Even Analysis', y);
    y = drawTextBlock(doc, 'Fixed Annual Costs (trailing 12mo, excl. equipment)', fmtEur(fixedCosts), y);
    y = drawTextBlock(doc, 'Contribution Per Gig', `${fmtEur(avgGigFee)} − ${fmtEur(costPerGig)} = ${fmtEur(avgContribution)}`, y);
    y = drawTextBlock(doc, 'Break-Even Point', breakEvenGigs ? `${breakEvenGigs} gigs/year` : 'Insufficient data', y);
    y += 6;

    // Strategic signals
    y = drawHeader(doc, 'Strategic Signals', y);
    y = drawSignals(doc, [
      { label: 'Gig margin', value: gigMargin !== null ? fmtPct(gigMargin) : '—', ok: gigMargin > 0.6, warn: gigMargin > 0.4 },
      { label: 'Revenue diversification', value: totalStreamRev > 0 ? 'Streaming active' : 'Live only', ok: totalStreamRev > 0, warn: false },
      { label: 'Cash runway', value: runwayMonths === Infinity ? '∞' : runwayMonths.toFixed(1) + ' mo', ok: runwayMonths > 12, warn: runwayMonths > 6 },
      { label: 'Revenue trend (YoY)', value: yoyGrowth !== null ? fmtPct(yoyGrowth) : '—', ok: yoyGrowth > 0, warn: yoyGrowth === null },
      { label: 'Investment ratio', value: totalExpense > 0 ? fmtPct(investmentTotal / totalExpense) : '—', ok: (investmentTotal / totalExpense) > 0.3, warn: (investmentTotal / totalExpense) > 0.15 },
      { label: 'Gig frequency', value: gigCount + ' total gigs', ok: gigCount >= 4, warn: gigCount >= 2 },
    ], y);

    // ═══════════════════════════════════════════════
    // PAGE 4: OPERATIONS
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;

    if (tours.length) {
      y = drawHeader(doc, 'Tour / Event Profitability', y);
      y = drawTable(doc, ['Tour', 'Status', 'Revenue', 'Costs', 'Net'],
        tours.map(t => { const r = parseFloat(t.revenue||0), c = parseFloat(t.costs||0); return [t.name, t.status||'—', fmtEur(r), fmtEur(c), (r-c>=0?'+':'')+fmtEur(r-c)]; }),
        y, [160, 60, 95, 95, 105]);
      y += 8;
    }

    if (splits.length) {
      y = drawHeader(doc, 'Gig Split History', y);
      y = drawTable(doc, ['Gig', 'Date', 'Gross', 'Band Fund', 'Per Member', '#'],
        splits.map(s => [s.gig_name, fmtDate(s.gig_date), fmtEur(parseFloat(s.gross_eur)), fmtEur(parseFloat(s.band_fund_eur||0)), fmtEur(parseFloat(s.per_member_eur)), String(s.member_count||'—')]),
        y, [130, 65, 80, 75, 80, 55]);
      y += 8;
    }

    if (members.length) {
      y = drawHeader(doc, 'Member Account Balances', y);
      y = drawTable(doc, ['Member', 'Total In', 'Total Out', 'Balance'],
        members.map(m => [m.member_name||m.member_key, fmtEur(parseFloat(m.total_in)), fmtEur(parseFloat(m.total_out)), fmtEur(parseFloat(m.balance))]),
        y, [160, 115, 115, 125]);
      y += 8;
    }

    if (streams.length) {
      y = drawHeader(doc, 'Streaming Performance', y);
      const byPlatform = {};
      streams.forEach(s => { if (!byPlatform[s.platform]) byPlatform[s.platform] = { streams: 0, rev: 0 }; byPlatform[s.platform].streams += s.streams||0; byPlatform[s.platform].rev += parseFloat(s.revenue_eur||0); });
      const sRows = Object.entries(byPlatform).filter(([,d]) => d.streams > 0).sort((a,b) => b[1].streams - a[1].streams)
        .map(([p,d]) => [p.charAt(0).toUpperCase()+p.slice(1), d.streams.toLocaleString(), fmtEur(d.rev)]);
      sRows.push(['TOTAL', totalStreams.toLocaleString(), fmtEur(totalStreamRev)]);
      y = drawTable(doc, ['Platform', 'Streams', 'Revenue'], sRows, y, [200, 150, 165]);
      y += 8;
    }

    // Recommendations
    y = drawHeader(doc, 'Recommendations', y);
    const recs = [];
    if (gigMargin !== null && gigMargin < 0.6) recs.push('Gig margin below 60% — review transport costs or increase fees.');
    if (runwayMonths < 9 && runwayMonths !== Infinity) recs.push(`Cash runway ${runwayMonths.toFixed(1)} months — build reserves.`);
    if (totalStreamRev === 0) recs.push('No streaming revenue — pitch every new release to Spotify editorial.');
    if (gigCount < 4) recs.push('Under 4 gigs — target summer festivals in Alentejo/Algarve.');
    if (yoyGrowth !== null && yoyGrowth < 0) recs.push('Revenue declining YoY — diversify with sync, corporate, or streaming.');
    if (!recs.length) recs.push('Financial health is solid. Continue trajectory and reinvest into releases.');
    recs.forEach(r => { y = drawTextBlock(doc, '→', r, y); });

    // ═══════════════════════════════════════════════
    // APPENDIX: LEDGER
    // ═══════════════════════════════════════════════
    doc.addPage();
    y = 50;
    y = drawHeader(doc, `Appendix — Transaction Ledger (${txns.length} entries)`, y);
    let bal = 0;
    const ledgerRows = txns.map(t => {
      const amt = parseFloat(t.amount_eur || t.amount);
      bal += t.type === 'income' ? amt : -amt;
      return [fmtDate(t.date), (t.description||'').slice(0, 38), t.category||'—', t.type === 'income' ? '+'+fmtEur(amt) : '-'+fmtEur(amt), fmtEur(bal)];
    });
    y = drawTable(doc, ['Date', 'Description', 'Category', 'Amount', 'Balance'], ledgerRows, y, [60, 185, 80, 90, 100]);

    // ── Footers ────────────────────────────────────
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(6.5).font('Helvetica').fillColor(C.light);
      doc.text(`The Ginskeys Financial Terminal  ·  Page ${i + 1} of ${pages.count}  ·  Confidential`, 40, doc.page.height - 28, { width: doc.page.width - 80, align: 'center' });
    }

    doc.end();
    await writeAudit(req, 'REPORT_GENERATED', { details: `Financial PDF — ${periodLabel} — ${txns.length} txns` });

  } catch (err) { next(err); }
});

module.exports = router;
