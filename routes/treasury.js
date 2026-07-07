// ══════════════════════════════════════════════════
// TREASURY ROUTES — /api/treasury
// Central pool where all net revenue lands before
// manual allocation to members + band fund.
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { appendEvent } = require('../lib/ledger');

const VALID_SOURCES = ['gig','streaming','merch','sync','other'];

// ── GET /api/treasury/summary ─────────────────────
// Returns aggregate stats: total unallocated, by source, etc.
router.get('/summary', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows: totals } = await pool.query(`
      SELECT
        COUNT(*)::int                                           AS item_count,
        COALESCE(SUM(net_eur), 0)                               AS total_net,
        COALESCE(SUM(allocated_eur), 0)                         AS total_allocated,
        COALESCE(SUM(net_eur - allocated_eur), 0)               AS total_unallocated,
        COUNT(*) FILTER (WHERE status = 'unallocated')::int     AS count_unallocated,
        COUNT(*) FILTER (WHERE status = 'partial')::int         AS count_partial,
        COUNT(*) FILTER (WHERE status = 'allocated')::int       AS count_allocated
      FROM treasury_pool
    `);

    const { rows: bySource } = await pool.query(`
      SELECT
        source_type,
        COUNT(*)::int AS count,
        COALESCE(SUM(net_eur), 0) AS total_net,
        COALESCE(SUM(allocated_eur), 0) AS total_allocated,
        COALESCE(SUM(net_eur - allocated_eur), 0) AS unallocated
      FROM treasury_pool
      GROUP BY source_type
      ORDER BY unallocated DESC
    `);

    res.json({ ...totals[0], by_source: bySource });
  } catch (err) { next(err); }
});

// ── GET /api/treasury ─────────────────────────────
// List all treasury items, newest first
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { status, source_type } = req.query;
    const params = [];
    const wheres = [];
    if (status) { params.push(status); wheres.push(`t.status = $${params.length}`); }
    if (source_type) { params.push(source_type); wheres.push(`t.source_type = $${params.length}`); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT t.*,
        COALESCE(json_agg(
          json_build_object(
            'id', a.id,
            'member_key', a.member_key,
            'member_name', a.member_name,
            'amount', a.amount,
            'created_at', a.created_at
          ) ORDER BY a.created_at
        ) FILTER (WHERE a.id IS NOT NULL), '[]') AS allocations
      FROM treasury_pool t
      LEFT JOIN treasury_allocations a ON a.treasury_id = t.id
      ${where}
      GROUP BY t.id
      ORDER BY t.revenue_date DESC NULLS LAST, t.created_at DESC
    `, params);

    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/treasury ────────────────────────────
// Add revenue to the treasury pool
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { source_type, source_id, description, gross_eur, expenses_eur = 0,
            revenue_date, notes, ledger_txn_id } = req.body;

    if (!description || gross_eur === undefined)
      return res.status(400).json({ error: 'description and gross_eur required' });
    if (!VALID_SOURCES.includes(source_type))
      return res.status(400).json({ error: 'source_type must be one of: ' + VALID_SOURCES.join(', ') });

    const gross = parseFloat(gross_eur);
    const expenses = Math.abs(parseFloat(expenses_eur || 0));
    if (!isFinite(gross) || gross < 0)
      return res.status(400).json({ error: 'gross_eur must be non-negative' });
    if (!isFinite(expenses))
      return res.status(400).json({ error: 'expenses_eur must be a number' });

    const net = parseFloat((gross - expenses).toFixed(2));

    const id = uuid();
    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      const ins = await client.query(`
        INSERT INTO treasury_pool
          (id, source_type, source_id, description, gross_eur, expenses_eur, net_eur,
           allocated_eur, status, revenue_date, ledger_txn_id, notes, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7, 0, 'unallocated', $8,$9,$10,$11)
        RETURNING *
      `, [id, source_type, source_id || null, description.trim(), gross, expenses, net,
          revenue_date || null, ledger_txn_id || null, notes || null, req.user.id]);
      rows = ins.rows;

      // TRUST ENGINE: net revenue entering the band's cash position.
      const revDate = revenue_date || new Date().toISOString().split('T')[0];
      if (net > 0) {
        await appendEvent(client, {
          event_type: 'revenue_received',
          amount_eur: net,
          occurred_on: revDate,
          description: `${source_type}: ${description.trim()}`,
          source_table: 'treasury_pool',
          source_id: id,
        }, req.user.id);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await writeAudit(req, 'TREASURY_ADD', {
      entityType: 'treasury', entityId: id,
      details: `${source_type}: ${description} — net €${net}`
    });

    res.status(201).json({ ...rows[0], allocations: [] });
  } catch (err) { next(err); }
});

// ── POST /api/treasury/:id/allocate ───────────────
// Allocate funds from a treasury item to members/band fund
// Body: { allocations: [{ member_key, member_name, amount }] }
router.post('/:id/allocate', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the treasury row
    const { rows: [item] } = await client.query(
      `SELECT * FROM treasury_pool WHERE id = $1 FOR UPDATE`, [req.params.id]
    );
    if (!item) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Treasury item not found' });
    }

    const allocations = req.body.allocations || [];
    if (!allocations.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'allocations array required' });
    }

    const totalAllocating = allocations.reduce((s, a) => s + Math.abs(parseFloat(a.amount || 0)), 0);
    const remaining = parseFloat(item.net_eur) - parseFloat(item.allocated_eur);

    if (totalAllocating > remaining + 0.01) { // small epsilon for rounding
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot allocate €${totalAllocating.toFixed(2)} — only €${remaining.toFixed(2)} available`
      });
    }

    const results = [];
    for (const alloc of allocations) {
      const amt = Math.abs(parseFloat(alloc.amount));
      if (!isFinite(amt) || amt <= 0) continue;
      if (!alloc.member_key) continue;

      // 1. Create member account transaction
      const { rows: [maTxn] } = await client.query(`
        INSERT INTO member_account_txns
          (member_key, member_name, amount, txn_type, description, txn_date,
           treasury_id, created_by)
        VALUES ($1,$2,$3,'split_credit',$4,$5,$6,$7)
        RETURNING *
      `, [alloc.member_key, alloc.member_name || alloc.member_key, amt,
          `Treasury: ${item.description}`,
          item.revenue_date || new Date().toISOString().split('T')[0],
          item.id, req.user.id]);

      // 2. Create allocation record
      const { rows: [allocRow] } = await client.query(`
        INSERT INTO treasury_allocations
          (id, treasury_id, member_key, member_name, amount, member_txn_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
      `, [uuid(), item.id, alloc.member_key, alloc.member_name || alloc.member_key,
          amt, maTxn.id, req.user.id]);

      // TRUST ENGINE: band cash → member wallet.
      await appendEvent(client, {
        event_type: 'treasury_allocated',
        amount_eur: amt,
        occurred_on: item.revenue_date || new Date().toISOString().split('T')[0],
        description: `Treasury: ${item.description} → ${alloc.member_name || alloc.member_key}`,
        source_table: 'member_account_txns',
        source_id: maTxn.id,
        metadata: { member_key: alloc.member_key, account: 'member:' + alloc.member_key },
      }, req.user.id);

      results.push(allocRow);
    }

    // 3. Update treasury pool totals
    const { rows: [updated] } = await client.query(`
      UPDATE treasury_pool SET
        allocated_eur = (SELECT COALESCE(SUM(amount), 0) FROM treasury_allocations WHERE treasury_id = $1),
        status = CASE
          WHEN (SELECT COALESCE(SUM(amount), 0) FROM treasury_allocations WHERE treasury_id = $1) >= net_eur
            THEN 'allocated'
          WHEN (SELECT COALESCE(SUM(amount), 0) FROM treasury_allocations WHERE treasury_id = $1) > 0
            THEN 'partial'
          ELSE 'unallocated'
        END
      WHERE id = $1 RETURNING *
    `, [req.params.id]);

    await client.query('COMMIT');

    await writeAudit(req, 'TREASURY_ALLOCATE', {
      entityType: 'treasury', entityId: req.params.id,
      details: `Allocated €${totalAllocating.toFixed(2)} to ${results.length} recipients`
    });

    res.json({ treasury: updated, allocations: results });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── DELETE /api/treasury/:id ──────────────────────
// Only if fully unallocated
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    const { rows: [item] } = await pool.query(
      `SELECT * FROM treasury_pool WHERE id = $1`, [req.params.id]
    );
    if (!item) return res.status(404).json({ error: 'Not found' });
    if (parseFloat(item.allocated_eur) > 0)
      return res.status(400).json({ error: 'Cannot delete — has existing allocations. Remove allocations first.' });

    await pool.query('DELETE FROM treasury_pool WHERE id = $1', [req.params.id]);
    await writeAudit(req, 'TREASURY_DELETE', {
      entityType: 'treasury', entityId: req.params.id,
      details: item.description
    });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
