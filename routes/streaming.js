// ══════════════════════════════════════════════════
// STREAMING ROUTES — /api/streaming
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

const VALID_PLATFORMS = ['spotify','apple_music','youtube','amazon','deezer','tidal','pandora','other'];

// ─── GET /api/streaming ────────────────────────────
// Returns all snapshots, optionally filtered by ?period=YYYY-MM-DD
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { period } = req.query;
    const params = [];
    const wheres = [];
    if (period) { params.push(period); wheres.push(`period = $${params.length}`); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM streaming_snapshots ${where} ORDER BY period DESC, platform ASC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── POST /api/streaming ───────────────────────────
// Upserts a snapshot for a given platform + period
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { platform, period, streams = 0, revenue_eur = 0 } = req.body;
    if (!platform || !period)
      return res.status(400).json({ error: 'platform and period are required' });
    if (!VALID_PLATFORMS.includes(platform))
      return res.status(400).json({ error: 'invalid platform. Valid: ' + VALID_PLATFORMS.join(', ') });

    const { rows } = await pool.query(
      `INSERT INTO streaming_snapshots (platform, period, streams, revenue_eur)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (platform, period)
       DO UPDATE SET streams = EXCLUDED.streams, revenue_eur = EXCLUDED.revenue_eur
       RETURNING *`,
      [platform, period, parseInt(streams), parseFloat(revenue_eur)]
    );
    await writeAudit(req, 'STREAMING_UPDATE', {
      entityType: 'streaming_snapshot',
      details: `${platform} / ${period}: ${streams} streams, €${revenue_eur}`,
    });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
