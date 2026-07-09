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
const { toEur } = require('./fx');
const { appendEvent } = require('../lib/ledger');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// ── TRUST ENGINE HELPERS ────────────────────────────────────────────
// transactions.js is the main door money moves through, so every write
// path here (create, edit, delete, bulk import) has to mirror into the
// append-only fin_events store — same pattern as treasury.js/splits.js.
// History is never rewritten: an edit or delete cancels the transaction's
// last recorded effect with a 'reversal' event, then (for edits) records
// a fresh event for the new values.

// Most recent fin_event for this transaction row, with its ledger lines.
async function findLatestEvent(client, txnId) {
  const { rows: [ev] } = await client.query(
    `SELECT seq, amount_eur, occurred_on FROM fin_events
     WHERE source_table = 'transactions' AND source_id = $1
     ORDER BY seq DESC LIMIT 1`, [txnId]
  );
  if (!ev) return null;
  const { rows: lines } = await client.query(
    `SELECT account, amount_eur FROM fin_ledger WHERE event_seq = $1 ORDER BY id`, [ev.seq]
  );
  return { seq: ev.seq, amount_eur: ev.amount_eur, lines };
}

// Cancel a transaction's last recorded effect (used on edit + delete).
async function reverseEvent(client, prevEvent, txnId, userId, note) {
  if (!prevEvent) return null;
  return appendEvent(client, {
    event_type: 'reversal',
    amount_eur: prevEvent.amount_eur,
    occurred_on: new Date().toISOString().slice(0, 10),
    description: note,
    source_table: 'transactions',
    source_id: txnId,
    reverses_seq: prevEvent.seq,
    metadata: { lines: prevEvent.lines },
  }, userId);
}

// Record a transaction's current financial effect as a fresh event.
async function recordEvent(client, txn, userId) {
  return appendEvent(client, {
    event_type: txn.type === 'income' ? 'revenue_received' : 'expense_paid',
    amount_eur: txn.amount_eur,
    occurred_on: txn.date,
    description: txn.description,
    source_table: 'transactions',
    source_id: txn.id,
  }, userId);
}

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

        // FIX: use live ECB rates (via fx proxy) instead of hardcoded, wrong-direction FX.
        const amtEur = await toEur(amt, currency);

        let catId = null;
        if (category) {
          const { rows: cats } = await pool.query(
            'SELECT id FROM categories WHERE name ILIKE $1 LIMIT 1', [category]
          );
          catId = cats[0]?.id || null;
        }

        const id = uuid();
        const txnType = type.toLowerCase();

        // Each row gets its own DB transaction so one bad row can't take
        // down the rest of the batch, while still keeping the insert and
        // its TRUST ENGINE mirror atomic with each other.
        const rowClient = await pool.connect();
        try {
          await rowClient.query('BEGIN');
          await rowClient.query(
            `INSERT INTO transactions (id,date,type,category_id,amount,currency,amount_eur,description,tags,notes,created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, date, txnType, catId, amt, currency.toUpperCase(), amtEur,
             description.trim(),
             tags ? tags.split(',').map(t=>t.trim()) : [],
             notes || null, req.user.id]
          );
          await recordEvent(rowClient, {
            id, type: txnType, amount_eur: amtEur, date, description: description.trim(),
          }, req.user.id);
          await rowClient.query('COMMIT');
        } catch (rowErr) {
          await rowClient.query('ROLLBACK');
          throw rowErr;
        } finally {
          rowClient.release();
        }

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
    const { date, type, amount, currency = 'EUR', description, source_dest, tourId, tags = [], notes, category, reconciled } = req.body;
    let { categoryId } = req.body;
    if (!date || !type || !amount || !description)
      return res.status(400).json({ error: 'date, type, amount and description are required' });
    if (!['income','expense'].includes(type))
      return res.status(400).json({ error: 'type must be income or expense' });

    // FIX: allow creating with a category NAME (the console UI only knows names).
    if (!categoryId && category) {
      const { rows: cats } = await pool.query(
        'SELECT id FROM categories WHERE name ILIKE $1 LIMIT 1', [category]
      );
      categoryId = cats[0]?.id || null;
    }

    const amt = parseFloat(amount);
    // FIX: validate amount is finite and positive
    if (!isFinite(amt) || amt <= 0)
      return res.status(400).json({ error: 'amount must be a positive number' });

    // FIX: live ECB rates via fx proxy (was hardcoded & inverted).
    const amountEur = await toEur(amt, currency);

    const id = uuid();
    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO transactions
           (id, date, type, category_id, amount, currency, amount_eur, description, source_dest, tour_id, tags, notes, reconciled, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [id, date, type, categoryId || null, amt, currency, amountEur,
         description.trim(), source_dest || null, tourId || null,
         Array.isArray(tags) ? tags : [tags], notes || null,
         reconciled !== undefined ? !!reconciled : true, req.user.id]
      );
      rows = ins.rows;

      // TRUST ENGINE: mirror this movement into the append-only event store.
      await recordEvent(client, rows[0], req.user.id);

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await writeAudit(req, 'TXN_CREATE', {
      entityType: 'transaction', entityId: id,
      newValue: rows[0],
    });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ─── PUT /api/transactions/:id ─────────────────────
router.put('/:id', requireAuth, requirePerm('editTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const old = existing[0];
    const { date, type, amount, currency, description, source_dest, tourId, tags, notes, reconciled, category } = req.body;
    let { categoryId } = req.body;

    // FIX: validate type if provided
    if (type && !['income','expense'].includes(type)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'type must be income or expense' });
    }

    // FIX: allow updating category by NAME (the console UI only knows names).
    // A blank string ('') explicitly CLEARS the category; omitting the key leaves it.
    let categoryProvided = false;
    if (categoryId !== undefined) {
      categoryProvided = true;
    } else if (category !== undefined) {
      categoryProvided = true;
      if (category === null || category === '') {
        categoryId = null;
      } else {
        const { rows: cats } = await client.query(
          'SELECT id FROM categories WHERE name ILIKE $1 LIMIT 1', [category]
        );
        categoryId = cats[0]?.id || null;
      }
    }

    // FIX: build the SET clause dynamically. Only fields actually present in the
    // request body are updated; clearable fields (notes, tour_id, source_dest,
    // category) can be set to NULL by sending null/''. Previously the COALESCE
    // pattern made it impossible to ever clear a field once set.
    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (date !== undefined)        push('date', date);
    if (type !== undefined)        push('type', type);
    if (categoryProvided)          push('category_id', categoryId);
    if (description !== undefined) push('description', String(description).trim());
    if (source_dest !== undefined) push('source_dest', source_dest || null);
    if (tourId !== undefined)      push('tour_id', tourId || null);
    if (tags !== undefined)        push('tags', Array.isArray(tags) ? tags : [tags]);
    if (notes !== undefined)       push('notes', notes === '' ? null : notes);
    if (reconciled !== undefined)  push('reconciled', !!reconciled);

    // amount / currency / amount_eur move together — recompute if either changed
    if (amount !== undefined || currency !== undefined) {
      const newAmt = amount   !== undefined ? parseFloat(amount) : parseFloat(old.amount);
      const newCcy = currency !== undefined ? currency           : old.currency;
      if (!isFinite(newAmt) || newAmt <= 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'amount must be a positive number' });
      }
      const amountEur = await toEur(newAmt, newCcy);
      push('amount', newAmt);
      push('currency', newCcy);
      push('amount_eur', amountEur);
    }

    if (!sets.length) {
      await client.query('ROLLBACK');
      return res.json(old); // nothing to change
    }

    sets.push('updated_at = now()');
    vals.push(req.params.id);
    const { rows } = await client.query(
      `UPDATE transactions SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    const updated = rows[0];

    // TRUST ENGINE: if the financial shape of the transaction actually
    // changed (type, amount, or date — the fields expandLines()/the event
    // depend on), cancel the old recorded effect and record the new one.
    // History is never rewritten in place — the correction is itself a
    // new, hash-chained event.
    const financialFieldsChanged =
      old.type !== updated.type ||
      Number(old.amount_eur).toFixed(2) !== Number(updated.amount_eur).toFixed(2) ||
      String(old.date) !== String(updated.date);

    if (financialFieldsChanged) {
      const prevEvent = await findLatestEvent(client, updated.id);
      await reverseEvent(client, prevEvent, updated.id, req.user.id,
        `Correction: "${old.description}" edited`);
      await recordEvent(client, updated, req.user.id);
    }

    await client.query('COMMIT');

    await writeAudit(req, 'TXN_UPDATE', {
      entityType: 'transaction', entityId: req.params.id,
      oldValue: old, newValue: updated,
    });
    res.json(updated);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── DELETE /api/transactions/:id ──────────────────
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('DELETE FROM transactions WHERE id = $1 RETURNING *', [req.params.id]);
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // TRUST ENGINE: cancel this transaction's recorded effect. The event
    // store is append-only — deleting the transaction row must never
    // delete or silently orphan its history in fin_events/fin_ledger.
    const prevEvent = await findLatestEvent(client, rows[0].id);
    await reverseEvent(client, prevEvent, rows[0].id, req.user.id,
      `Deleted: "${rows[0].description}"`);

    await client.query('COMMIT');
    await writeAudit(req, 'TXN_DELETE', { entityType: 'transaction', entityId: req.params.id, oldValue: rows[0] });
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
