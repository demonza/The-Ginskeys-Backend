// ══════════════════════════════════════════════════
// AUDIT LOG ROUTES — /api/audit
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');

// ─── GET /api/audit ────────────────────────────────
router.get('/', requireAuth, requirePerm('viewAudit'), async (req, res, next) => {
  try {
    const { page = 1, limit = 100, userId, action, from, to } = req.query;
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(limit);
    const params = [];
    const wheres = [];

    if (userId) { params.push(userId); wheres.push(`user_id = $${params.length}`); }
    if (action) { params.push(action); wheres.push(`action ILIKE $${params.length}`); }
    if (from)   { params.push(from);   wheres.push(`created_at >= $${params.length}`); }
    if (to)     { params.push(to);     wheres.push(`created_at <= $${params.length}`); }

    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    params.push(parseInt(limit), offset);

    const { rows } = await pool.query(`
      SELECT *, COUNT(*) OVER() AS total_count
      FROM audit_log ${where}
      ORDER BY created_at DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);

    res.json({
      data: rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(rows[0]?.total_count || 0) }
    });
  } catch (err) { next(err); }
});

module.exports = router;
