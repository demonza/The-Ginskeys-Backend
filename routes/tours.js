// ══════════════════════════════════════════════════
// TOURS ROUTES — /api/tours
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ─── GET /api/tours ────────────────────────────────
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        t.*,
        b.id          AS booking_id,
        b.stage       AS booking_stage,
        b.location    AS booking_location,
        b.contact_name AS booking_contact,
        b.contact_email AS booking_email,
        b.fee_eur     AS booking_fee,
        COALESCE(SUM(CASE WHEN tx.type='income'  THEN tx.amount_eur ELSE 0 END),0) AS revenue,
        COALESCE(SUM(CASE WHEN tx.type='expense' THEN tx.amount_eur ELSE 0 END),0) AS costs,
        COALESCE(SUM(CASE WHEN tx.type='income'  THEN tx.amount_eur
                          WHEN tx.type='expense' THEN -tx.amount_eur ELSE 0 END),0) AS net_profit,
        COUNT(tx.id)  AS transaction_count
      FROM tours t
      LEFT JOIN booking_contacts b ON b.tour_id = t.id
      LEFT JOIN transactions tx ON tx.tour_id = t.id
      GROUP BY t.id, b.id
      ORDER BY t.start_date DESC NULLS LAST
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── GET /api/tours/:id ────────────────────────────
router.get('/:id', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows: tours } = await pool.query('SELECT * FROM tours WHERE id = $1', [req.params.id]);
    if (!tours[0]) return res.status(404).json({ error: 'Tour not found' });

    const { rows: txns } = await pool.query(
      `SELECT t.*, c.name AS category FROM transactions t
       LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.tour_id = $1 ORDER BY t.date DESC`,
      [req.params.id]
    );

    const revenue = txns.filter(t=>t.type==='income').reduce((s,t)=>s+parseFloat(t.amount_eur),0);
    const costs   = txns.filter(t=>t.type==='expense').reduce((s,t)=>s+parseFloat(t.amount_eur),0);

    res.json({ ...tours[0], revenue, costs, netProfit: revenue - costs, transactions: txns });
  } catch (err) { next(err); }
});

// ─── POST /api/tours ───────────────────────────────
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { name, startDate, endDate, budget, status = 'planned', notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const { rows } = await pool.query(
      `INSERT INTO tours (id, name, start_date, end_date, budget, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [uuid(), name.trim(), startDate||null, endDate||null,
       budget ? parseFloat(budget) : null, status, notes||null]
    );
    await writeAudit(req, 'TOUR_CREATE', { entityType: 'tour', entityId: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ─── PUT /api/tours/:id ────────────────────────────
router.put('/:id', requireAuth, requirePerm('editTxn'), async (req, res, next) => {
  try {
    const { name, startDate, endDate, budget, status, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE tours SET
         name       = COALESCE($1, name),
         start_date = COALESCE($2, start_date),
         end_date   = COALESCE($3, end_date),
         budget     = COALESCE($4, budget),
         status     = COALESCE($5, status),
         notes      = COALESCE($6, notes),
         updated_at = now()
       WHERE id = $7 RETURNING *`,
      [name||null, startDate||null, endDate||null,
       budget ? parseFloat(budget) : null, status||null, notes||null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tour not found' });
    await writeAudit(req, 'TOUR_UPDATE', { entityType: 'tour', entityId: req.params.id });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /api/tours/:id ─────────────────────────
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM tours WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Tour not found' });
    await writeAudit(req, 'TOUR_DELETE', { entityType: 'tour', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
