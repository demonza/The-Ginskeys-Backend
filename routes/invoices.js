// ══════════════════════════════════════════════════
// INVOICES ROUTES — /api/invoices
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

const VALID_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'];
const VALID_METHODS  = ['transfer', 'cash', 'mbway', 'check', ''];

// ── Auto-ensure table exists (non-fatal, covers fresh deploys) ──
let _tableReady = false;
async function ensureTable() {
  if (_tableReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        number        TEXT NOT NULL,
        client_name   TEXT NOT NULL,
        client_email  TEXT,
        client_nif    TEXT,
        client_address TEXT,
        client_contact TEXT,
        venue         TEXT,
        show_date     DATE,
        description   TEXT,
        base_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
        expenses      NUMERIC(12,2) NOT NULL DEFAULT 0,
        iva_rate      NUMERIC(5,2)  NOT NULL DEFAULT 0,
        total         NUMERIC(12,2) NOT NULL DEFAULT 0,
        issued_date   DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date      DATE,
        status        TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('draft','sent','paid','overdue','cancelled')),
        paid_date     DATE,
        paid_method   TEXT,
        notes         TEXT,
        band_nif      TEXT,
        band_iban     TEXT,
        band_email    TEXT,
        booking_id    UUID REFERENCES booking_contacts(id) ON DELETE SET NULL,
        ledger_txn_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT now(),
        updated_at    TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_due     ON invoices(due_date);
      CREATE INDEX IF NOT EXISTS idx_invoices_issued  ON invoices(issued_date DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(number);
    `);
    _tableReady = true;
  } catch (err) {
    console.error('invoices table ensure failed:', err.message);
  }
}

// ── GET /api/invoices ─────────────────────────────
// Returns all invoices, with overdue auto-computed.
// Query params: status, from (issued_date), to (issued_date)
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    await ensureTable();
    const { status, from, to } = req.query;
    const params = [], wheres = [];

    if (status && status !== 'all') {
      if (status === 'overdue') {
        // overdue = sent/draft, due_date in the past
        wheres.push(`status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE`);
      } else {
        params.push(status);
        wheres.push(`status = $${params.length}`);
      }
    }
    if (from) { params.push(from); wheres.push(`issued_date >= $${params.length}`); }
    if (to)   { params.push(to);   wheres.push(`issued_date <= $${params.length}`); }

    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM invoices ${where} ORDER BY issued_date DESC, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/invoices/stats ───────────────────────
router.get('/stats', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(`
      SELECT
        COUNT(*)                                                        AS total,
        COALESCE(SUM(total) FILTER (WHERE status NOT IN ('paid','cancelled')), 0)   AS outstanding,
        COALESCE(SUM(total) FILTER (
          WHERE status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE
        ), 0)                                                           AS overdue,
        COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0)         AS collected,
        COUNT(*) FILTER (
          WHERE status NOT IN ('paid','cancelled') AND due_date < CURRENT_DATE
        )                                                               AS overdue_count
      FROM invoices
    `);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/invoices ────────────────────────────
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await ensureTable();
    const {
      number, client_name, client_email, client_nif, client_address, client_contact,
      venue, show_date, description,
      base_fee = 0, expenses = 0, iva_rate = 0, total,
      issued_date, due_date, status = 'sent',
      notes, band_nif, band_iban, band_email,
      booking_id,
      post_to_ledger = false,
    } = req.body;

    if (!number)      return res.status(400).json({ error: 'number is required' });
    if (!client_name) return res.status(400).json({ error: 'client_name is required' });
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }

    const computedTotal = total != null
      ? parseFloat(total)
      : parseFloat(base_fee) + parseFloat(expenses) + (parseFloat(base_fee) + parseFloat(expenses)) * parseFloat(iva_rate) / 100;

    await client.query('BEGIN');

    // Check for duplicate invoice number
    const dup = await client.query(`SELECT id FROM invoices WHERE number = $1`, [number]);
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Invoice number ${number} already exists` });
    }

    const { rows } = await client.query(`
      INSERT INTO invoices (
        number, client_name, client_email, client_nif, client_address, client_contact,
        venue, show_date, description,
        base_fee, expenses, iva_rate, total,
        issued_date, due_date, status,
        notes, band_nif, band_iban, band_email,
        booking_id, created_by
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,
        $10,$11,$12,$13,
        $14,$15,$16,
        $17,$18,$19,$20,
        $21,$22
      ) RETURNING *
    `, [
      number, client_name, client_email || null, client_nif || null,
      client_address || null, client_contact || null,
      venue || null, show_date || null, description || null,
      parseFloat(base_fee), parseFloat(expenses), parseFloat(iva_rate), computedTotal,
      issued_date || new Date().toISOString().slice(0, 10),
      due_date || null,
      status,
      notes || null, band_nif || null, band_iban || null, band_email || null,
      booking_id || null,
      req.user.id,
    ]);

    const invoice = rows[0];

    // Optionally post to ledger as income
    if (post_to_ledger && computedTotal > 0) {
      const ledgerDesc = `Invoice ${number} — ${client_name}${venue ? ' @ ' + venue : ''}`;
      const { rows: txnRows } = await client.query(`
        INSERT INTO transactions (date, type, amount, currency, amount_eur, description, created_by)
        VALUES ($1, 'income', $2, 'EUR', $2, $3, $4)
        RETURNING id
      `, [
        invoice.issued_date,
        computedTotal,
        ledgerDesc,
        req.user.id,
      ]);
      await client.query(
        `UPDATE invoices SET ledger_txn_id = $1, updated_at = now() WHERE id = $2`,
        [txnRows[0].id, invoice.id]
      );
      invoice.ledger_txn_id = txnRows[0].id;
    }

    await client.query('COMMIT');
    await writeAudit(req, 'INVOICE_CREATE', `${number} — ${client_name} — €${computedTotal}`);
    res.status(201).json(invoice);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── PATCH /api/invoices/:id/status ───────────────
// Update status (and optionally paid_date / paid_method)
router.patch('/:id/status', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    await ensureTable();
    const { status, paid_date, paid_method, notes } = req.body;

    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    if (paid_method && !VALID_METHODS.includes(paid_method)) {
      return res.status(400).json({ error: 'invalid paid_method' });
    }

    const { rows } = await pool.query(`
      UPDATE invoices SET
        status      = $1,
        paid_date   = $2,
        paid_method = $3,
        notes       = COALESCE($4, notes),
        updated_at  = now()
      WHERE id = $5
      RETURNING *
    `, [
      status,
      status === 'paid' ? (paid_date || new Date().toISOString().slice(0, 10)) : null,
      paid_method || null,
      notes || null,
      req.params.id,
    ]);

    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    await writeAudit(req, 'INVOICE_STATUS', `${rows[0].number} → ${status}`);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PUT /api/invoices/:id ─────────────────────────
router.put('/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    await ensureTable();
    const {
      client_name, client_email, client_nif, client_address, client_contact,
      venue, show_date, description,
      base_fee, expenses, iva_rate, total,
      issued_date, due_date, notes,
      band_nif, band_iban, band_email,
    } = req.body;

    const { rows } = await pool.query(`
      UPDATE invoices SET
        client_name    = COALESCE($1,  client_name),
        client_email   = COALESCE($2,  client_email),
        client_nif     = COALESCE($3,  client_nif),
        client_address = COALESCE($4,  client_address),
        client_contact = COALESCE($5,  client_contact),
        venue          = COALESCE($6,  venue),
        show_date      = COALESCE($7,  show_date),
        description    = COALESCE($8,  description),
        base_fee       = COALESCE($9,  base_fee),
        expenses       = COALESCE($10, expenses),
        iva_rate       = COALESCE($11, iva_rate),
        total          = COALESCE($12, total),
        issued_date    = COALESCE($13, issued_date),
        due_date       = COALESCE($14, due_date),
        notes          = COALESCE($15, notes),
        band_nif       = COALESCE($16, band_nif),
        band_iban      = COALESCE($17, band_iban),
        band_email     = COALESCE($18, band_email),
        updated_at     = now()
      WHERE id = $19
      RETURNING *
    `, [
      client_name, client_email, client_nif, client_address, client_contact,
      venue, show_date || null, description,
      base_fee != null ? parseFloat(base_fee) : null,
      expenses != null ? parseFloat(expenses) : null,
      iva_rate != null ? parseFloat(iva_rate) : null,
      total    != null ? parseFloat(total)    : null,
      issued_date || null, due_date || null, notes,
      band_nif, band_iban, band_email,
      req.params.id,
    ]);

    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    await writeAudit(req, 'INVOICE_UPDATE', rows[0].number);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/invoices/:id ──────────────────────
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      `DELETE FROM invoices WHERE id = $1 RETURNING number, client_name`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invoice not found' });
    await writeAudit(req, 'INVOICE_DELETE', `${rows[0].number} — ${rows[0].client_name}`);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
