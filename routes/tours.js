// ══════════════════════════════════════════════════
// TOURS ROUTES — /api/tours
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ─── GET /api/tours ────────────────────────────────
// Returns:
//  1. All rows from the tours table (with booking join for linked ones)
//  2. All confirmed/completed booking_contacts that have NO tour_id yet
//     — these appear as virtual "pending" tour rows so the frontend can
//       display them immediately without waiting for a stage-change event
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      -- Real tour rows (may be linked to a booking)
      SELECT
        t.id,
        t.name,
        t.start_date,
        t.end_date,
        t.budget,
        t.status,
        t.notes,
        t.created_at,
        b.id            AS booking_id,
        b.stage         AS booking_stage,
        b.location      AS booking_location,
        b.contact_name  AS booking_contact,
        b.contact_email AS booking_email,
        b.fee_eur       AS booking_fee,
        COALESCE(SUM(CASE WHEN tx.type='income'  THEN tx.amount_eur ELSE 0 END),0) AS revenue,
        COALESCE(SUM(CASE WHEN tx.type='expense' THEN tx.amount_eur ELSE 0 END),0) AS costs,
        COUNT(tx.id)    AS transaction_count,
        false           AS from_booking_only
      FROM tours t
      LEFT JOIN booking_contacts b  ON b.tour_id = t.id
      LEFT JOIN transactions     tx ON tx.tour_id = t.id
      GROUP BY t.id, b.id

      UNION ALL

      -- Confirmed/completed bookings NOT yet linked to any tour row
      SELECT
        b.id            AS id,
        b.name          AS name,
        b.date          AS start_date,
        b.date          AS end_date,
        b.fee_eur       AS budget,
        'planned'       AS status,
        b.location      AS notes,
        b.created_at    AS created_at,
        b.id            AS booking_id,
        b.stage         AS booking_stage,
        b.location      AS booking_location,
        b.contact_name  AS booking_contact,
        b.contact_email AS booking_email,
        b.fee_eur       AS booking_fee,
        0               AS revenue,
        0               AS costs,
        0               AS transaction_count,
        true            AS from_booking_only
      FROM booking_contacts b
      WHERE b.stage IN ('confirmed', 'completed')
        AND b.tour_id IS NULL

      ORDER BY start_date DESC NULLS LAST
    `);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── POST /api/tours/backfill ──────────────────────
// One-time: create real tour rows for all confirmed bookings
// that don't have one yet, and link them.
router.post('/backfill', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: unlinked } = await client.query(`
      SELECT * FROM booking_contacts
      WHERE stage IN ('confirmed','completed')
        AND tour_id IS NULL
    `);

    let created = 0;
    for (const b of unlinked) {
      const { rows: newTour } = await client.query(
        `INSERT INTO tours (name, start_date, end_date, budget, status, notes)
         VALUES ($1, $2, $2, $3, $4, $5) RETURNING id`,
        [
          b.name,
          b.date || null,
          b.fee_eur ? parseFloat(b.fee_eur) : null,
          b.stage === 'completed' ? 'completed' : 'planned',
          b.location ? `Location: ${b.location}` : null,
        ]
      );
      await client.query(
        'UPDATE booking_contacts SET tour_id = $1 WHERE id = $2',
        [newTour[0].id, b.id]
      );
      created++;
    }

    await client.query('COMMIT');
    res.json({ backfilled: created, message: `Created ${created} tour rows from confirmed bookings` });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
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
