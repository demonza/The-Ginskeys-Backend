// ══════════════════════════════════════════════════
// MEMBERS ROUTES — /api/members
// Rehearsals, band decisions, band agreement, budget targets
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ── Auto-ensure tables (non-fatal) ───────────────
let _tablesReady = false;
async function ensureTables() {
  if (_tablesReady) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rehearsals (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rehearsal_date DATE NOT NULL,
        location       TEXT,
        notes          TEXT,
        attendance     JSONB NOT NULL DEFAULT '{}',
        created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at     TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_rehearsals_date ON rehearsals(rehearsal_date DESC);

      CREATE TABLE IF NOT EXISTS band_decisions (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title         TEXT NOT NULL,
        outcome       TEXT NOT NULL,
        votes_for     INTEGER DEFAULT 0,
        votes_against INTEGER DEFAULT 0,
        decided_at    DATE NOT NULL DEFAULT CURRENT_DATE,
        notes         TEXT,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_date ON band_decisions(decided_at DESC);

      CREATE TABLE IF NOT EXISTS band_settings (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at TIMESTAMPTZ DEFAULT now()
      );
    `);
    _tablesReady = true;
  } catch (err) {
    console.error('members tables ensure failed:', err.message);
  }
}

// ════════════════════════════════════════════════
// REHEARSALS
// ════════════════════════════════════════════════

// GET /api/members/rehearsals
router.get('/rehearsals', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM rehearsals ORDER BY rehearsal_date DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/members/rehearsals
router.post('/rehearsals', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rehearsal_date, location, notes, attendance = {} } = req.body;
    if (!rehearsal_date) return res.status(400).json({ error: 'rehearsal_date is required' });

    const { rows } = await pool.query(`
      INSERT INTO rehearsals (rehearsal_date, location, notes, attendance, created_by)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [rehearsal_date, location || null, notes || null, JSON.stringify(attendance), req.user.id]);

    await writeAudit(req, 'REHEARSAL_ADD', rehearsal_date);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/members/rehearsals/:id
router.patch('/rehearsals/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rehearsal_date, location, notes, attendance } = req.body;
    const { rows } = await pool.query(`
      UPDATE rehearsals SET
        rehearsal_date = COALESCE($1, rehearsal_date),
        location       = COALESCE($2, location),
        notes          = COALESCE($3, notes),
        attendance     = COALESCE($4, attendance)
      WHERE id = $5 RETURNING *
    `, [
      rehearsal_date || null,
      location !== undefined ? location : null,
      notes    !== undefined ? notes    : null,
      attendance ? JSON.stringify(attendance) : null,
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: 'Rehearsal not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/members/rehearsals/:id
router.delete('/rehearsals/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `DELETE FROM rehearsals WHERE id = $1 RETURNING rehearsal_date`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Rehearsal not found' });
    await writeAudit(req, 'REHEARSAL_DELETE', rows[0].rehearsal_date);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════
// DECISIONS
// ════════════════════════════════════════════════

// GET /api/members/decisions
router.get('/decisions', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT * FROM band_decisions ORDER BY decided_at DESC, created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/members/decisions
router.post('/decisions', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    await ensureTables();
    const { title, outcome, votes_for = 0, votes_against = 0, decided_at, notes } = req.body;
    if (!title)   return res.status(400).json({ error: 'title is required' });
    if (!outcome) return res.status(400).json({ error: 'outcome is required' });

    const { rows } = await pool.query(`
      INSERT INTO band_decisions (title, outcome, votes_for, votes_against, decided_at, notes, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [
      title, outcome,
      parseInt(votes_for), parseInt(votes_against),
      decided_at || new Date().toISOString().slice(0, 10),
      notes || null,
      req.user.id,
    ]);
    await writeAudit(req, 'DECISION_ADD', title);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/members/decisions/:id
router.delete('/decisions/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `DELETE FROM band_decisions WHERE id = $1 RETURNING title`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Decision not found' });
    await writeAudit(req, 'DECISION_DELETE', rows[0].title);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════
// BAND SETTINGS (agreement + budget targets)
// Single key→value store. Keys: 'agreement', 'budget_targets'
// ════════════════════════════════════════════════

// GET /api/members/settings/:key
router.get('/settings/:key', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    await ensureTables();
    const { rows } = await pool.query(
      `SELECT value, updated_at FROM band_settings WHERE key = $1`,
      [req.params.key]
    );
    if (!rows.length) return res.json({ value: null });
    res.json({ value: rows[0].value, updated_at: rows[0].updated_at });
  } catch (err) { next(err); }
});

// PUT /api/members/settings/:key  (upsert)
router.put('/settings/:key', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    await ensureTables();
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value is required' });

    const allowedKeys = ['agreement', 'budget_targets'];
    if (!allowedKeys.includes(req.params.key)) {
      return res.status(400).json({ error: `Invalid key. Allowed: ${allowedKeys.join(', ')}` });
    }

    const { rows } = await pool.query(`
      INSERT INTO band_settings (key, value, updated_by, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (key) DO UPDATE SET
        value      = EXCLUDED.value,
        updated_by = EXCLUDED.updated_by,
        updated_at = now()
      RETURNING *
    `, [req.params.key, JSON.stringify(value), req.user.id]);

    await writeAudit(req, 'BAND_SETTING_UPDATE', req.params.key);
    res.json({ value: rows[0].value, updated_at: rows[0].updated_at });
  } catch (err) { next(err); }
});

module.exports = router;
