// ══════════════════════════════════════════════════
// TRANSACTIONS ROUTES — /api/transactions
// ══════════════════════════════════════════════════
const router  = require('express').Router();
const { v4: uuid } = require('uuid');
const multer  = require('multer');
const csv     = require('csv-parse/sync');
const pool    = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// FIX: whitelist sort columns to prevent SQL injection through sortBy
const ALLOWED_SORT = {
  date:    't.date',
  amount:  't.amount',
  created: 't.created_at',
};

// FIX: safe integer parsing with bounds
function safeInt(val, fallback, min = 1, max = 10000) {
  const n = parseInt(val);
  if (isNaN(n) || n < min) return fallback;
  return Math.min(n, max);
}

// ─── GET /api/transactions ─────────────────────────
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const {
      page = 1, limit = 100,
      type, category, tourId,
      from, to, tags, q,
      reconciled, sortBy = 'date', sortDir = 'desc'
    } = req.query;

    const safePage  = safeInt(page, 1);
    const safeLimit = safeInt(limit, 100, 1, 500);  // FIX: cap at 500 to prevent DoS
    const offset = (safePage - 1) * safeLimit;
    const params = [];
    const wheres = [];

    if (type)       { params.push(type);      wheres.push(`t.type = $${params.length}`); }
    if (category)   { params.push(category);  wheres.push(`c.name ILIKE $${params.length}`); }
    if (tourId)     { params.push(tourId);    wheres.push(`t.tour_id = $${params.length}`); }
    if (from)       { params.push(from);      wheres.push(`t.date >= $${params.length}`); }
    if (to)         { params.push(to);        wheres.push(`t.date <= $${params.length}`); }
    if (reconciled !== undefined) { params.push(reconciled === 'true'); wheres.push(`t.reconciled = $${params.length}`); }
    if (q)          { params.push('%' + q + '%'); wheres.push(`(t.description ILIKE $${params.length} OR t.notes ILIKE $${params.length} OR t.source_dest ILIKE $${params.length})`); }
    if (tags)       { params.push(tags.split(',')); wheres.push(`t.tags && $${params.length}`); }

    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    // FIX: use strict whitelist — original code did `allowedSort[sortBy] || 't.date'`
    // which is safe but the pattern is fragile; explicit validation is better
    const orderCol = ALLOWED_SORT[sortBy] || 't.date';
    const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

    params.push(safeLimit, offset);
    const query = `
      SELECT
        t.id, t.date, t.type, t.amount, t.currency, t.amount_eur,
        t.description, t.source_dest, t.tags, t.notes, t.reconciled,
        t.created_at, t.tour_id,
        c.name AS category,
        u.name AS created_by_name,
        COUNT(*) OVER() AS total_count
      FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      LEFT JOIN users u ON u.id = t.created_by
      ${where}
      ORDER BY ${orderCol} ${orderDir}
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const { rows } = await pool.query(query, params);
    const total = rows[0]?.total_count || 0;

    res.json({
      data: rows,
      pagination: { page: safePage, limit: safeLimit, total: parseInt(total) },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/transactions/export ─────────────────
router.get('/export', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const params = [];
    const wheres = [];
    if (from) { params.push(from); wheres.push(`t.date >= $${params.length}`); }
    if (to)   { params.push(to);   wheres.push(`t.date <= $${params.length}`); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT t.*, c.name AS category FROM transactions t
      LEFT JOIN categories c ON c.id = t.category_id
      ${where} ORDER BY t.date DESC
    `, params);

    const header = ['id','date','type','description','category','amount','currency','amount_eur','source_dest','tags','notes','reconciled','tour_id'];
    const lines  = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.id, r.date, r.type,
        // FIX: CSV injection prevention — prefix cells starting with =, +, -, @ with a single quote
        csvSafe(r.description),
        r.category || '',
        r.amount, r.currency, r.amount_eur,
        csvSafe(r.source_dest),
        csvSafe((r.tags || []).join(', ')),
        csvSafe(r.notes),
        r.reconciled, r.tour_id || ''
      ].join(','));
    });

    await writeAudit(req, 'EXPORT_CSV', { details: `${rows.length} transactions exported` });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ginskeys-ledger-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (err) { next(err); }
});

// FIX: CSV injection prevention helper
function csvSafe(val) {
  if (!val) return '""';
  let s = String(val).replace(/"/g, '""');
  // Neutralise formula injection characters
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s}"`;
}

// ─── POST /api/transactions/bulk-import ────────────
router.post('/bulk-import', requireAuth, requirePerm('addTxn'), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });

    const records = csv.parse(req.file.buffer.toString('utf8'), {
      columns: true, skip_empty_lines: true, trim: true
    });

    // FIX: cap import size to prevent memory/time abuse
    if (records.length > 1000) {
      return res.status(400).json({ error: 'Maximum 1000 rows per import' });
    }

    const imported = [];
    const errors   = [];

    for (const [i, row] of records.entries()) {
      try {
        const { date, type, description, amount, currency = 'EUR', category, tags, notes } = row;
        if (!date || !type || !description || !amount)
          throw new Error('Missing required field(s)');
        if (!['income','expense'].includes(type.toLowerCase()))
          throw new Error('Invalid type: ' + type);

        const amt = parseFloat(amount);
        // FIX: validate amount is a finite positive number
        if (!isFinite(amt) || amt <= 0)
          throw new Error('Amount must be a positive number');

        const FX = { EUR: 1, USD: 0.92, GBP: 1.17 };
        const amtEur = parseFloat((amt * (FX[currency.toUpperCase()] || 1)).toFixed(2));

        let catId = null;
        if (category) {
          const { rows: cats } = await pool.query(
            'SELECT id FROM categories WHERE name ILIKE $1 LIMIT 1', [category]
          );
          catId = cats[0]?.id || null;
        }

        const id = uuid();
        await pool.query(
          `INSERT INTO transactions (id,date,type,category_id,amount,currency,amount_eur,description,tags,notes,created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, date, type.toLowerCase(), catId, amt, currency.toUpperCase(), amtEur,
           description.trim(),
           tags ? tags.split(',').map(t=>t.trim()) : [],
           notes || null, req.user.id]
        );
        imported.push(id);
      } catch (e) {
        errors.push({ row: i + 2, error: e.message });
      }
    }

    await writeAudit(req, 'BULK_IMPORT', { details: `${imported.length} imported, ${errors.length} errors` });
    res.json({ imported: imported.length, errors });
  } catch (err) { next(err); }
});

// ─── GET /api/transactions/:id ─────────────────────
router.get('/:id', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.*, c.name AS category, u.name AS created_by_name
       FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Transaction not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /api/transactions ─────────────────────────
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { date, type, categoryId, amount, currency = 'EUR', description, source_dest, tourId, tags = [], notes } = req.body;
    if (!date || !type || !amount || !description)
      return res.status(400).json({ error: 'date, type, amount and description are required' });
    if (!['income','expense'].includes(type))
      return res.status(400).json({ error: 'type must be income or expense' });

    const amt = parseFloat(amount);
    // FIX: validate amount is finite and positive
    if (!isFinite(amt) || amt <= 0)
      return res.status(400).json({ error: 'amount must be a positive number' });

    const FX = { EUR: 1, USD: 0.92, GBP: 1.17 };
    const amountEur = parseFloat((amt * (FX[currency] || 1)).toFixed(2));

    const id = uuid();
    const { rows } = await pool.query(
      `INSERT INTO transactions
         (id, date, type, category_id, amount, currency, amount_eur, description, source_dest, tour_id, tags, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [id, date, type, categoryId || null, amt, currency, amountEur,
       description.trim(), source_dest || null, tourId || null,
       Array.isArray(tags) ? tags : [tags], notes || null, req.user.id]
    );

    await writeAudit(req, 'TXN_CREATE', {
      entityType: 'transaction', entityId: id,
      newValue: rows[0],
    });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ─── PUT /api/transactions/:id ─────────────────────
router.put('/:id', requireAuth, requirePerm('editTxn'), async (req, res, next) => {
  try {
    const { rows: existing } = await pool.query('SELECT * FROM transactions WHERE id = $1', [req.params.id]);
    if (!existing[0]) return res.status(404).json({ error: 'Transaction not found' });

    const old = existing[0];
    const { date, type, categoryId, amount, currency, description, source_dest, tourId, tags, notes, reconciled } = req.body;

    // FIX: validate type if provided
    if (type && !['income','expense'].includes(type))
      return res.status(400).json({ error: 'type must be income or expense' });

    const FX = { EUR: 1, USD: 0.92, GBP: 1.17 };
    const newAmt    = amount     !== undefined ? parseFloat(amount)    : parseFloat(old.amount);
    const newCcy    = currency   !== undefined ? currency              : old.currency;

    // FIX: validate amount if provided
    if (amount !== undefined && (!isFinite(newAmt) || newAmt <= 0))
      return res.status(400).json({ error: 'amount must be a positive number' });

    const amountEur = parseFloat((newAmt * (FX[newCcy] || 1)).toFixed(2));

    const { rows } = await pool.query(
      `UPDATE transactions SET
         date         = COALESCE($1, date),
         type         = COALESCE($2, type),
         category_id  = COALESCE($3, category_id),
         amount       = $4,
         currency     = $5,
         amount_eur   = $6,
         description  = COALESCE($7, description),
         source_dest  = COALESCE($8, source_dest),
         tour_id      = COALESCE($9, tour_id),
         tags         = COALESCE($10, tags),
         notes        = COALESCE($11, notes),
         reconciled   = COALESCE($12, reconciled),
         updated_at   = now()
       WHERE id = $13 RETURNING *`,
      [date || null, type || null, categoryId || null,
       newAmt, newCcy, amountEur,
       description ? description.trim() : null,
       source_dest || null, tourId || null,
       tags ? (Array.isArray(tags) ? tags : [tags]) : null,
       notes !== undefined ? notes : null,
       reconciled !== undefined ? reconciled : null,
       req.params.id]
    );

    await writeAudit(req, 'TXN_UPDATE', {
      entityType: 'transaction', entityId: req.params.id,
      oldValue: old, newValue: rows[0],
    });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /api/transactions/:id ──────────────────
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM transactions WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Transaction not found' });
    await writeAudit(req, 'TXN_DELETE', { entityType: 'transaction', entityId: req.params.id, oldValue: rows[0] });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
