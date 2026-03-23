// ══════════════════════════════════════════════════
// INVITES ROUTES — /api/invites
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ─── GET /api/invites ──────────────────────────────
router.get('/', requireAuth, requirePerm('createInvite'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT i.*, u.name AS created_by_name
       FROM invites i
       LEFT JOIN users u ON u.id = i.created_by
       ORDER BY i.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── POST /api/invites ─────────────────────────────
router.post('/', requireAuth, requirePerm('createInvite'), async (req, res, next) => {
  try {
    const { email, role, hoursValid = 72 } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'email and role required' });
    const validRoles = ['co-admin','manager','accountant','viewer'];
    if (!validRoles.includes(role))
      return res.status(400).json({ error: 'role must be one of: ' + validRoles.join(', ') });

    const rand = () => Math.random().toString(36).substring(2,6).toUpperCase();
    const token = `GINSK-${rand()}-${rand()}-${rand()}`;
    const expiresAt = new Date(Date.now() + parseInt(hoursValid) * 3600 * 1000);

    const { rows } = await pool.query(
      `INSERT INTO invites (id, token, email, role, created_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [uuid(), token, email.toLowerCase().trim(), role, req.user.id, expiresAt]
    );

    await writeAudit(req, 'INVITE_CREATED', {
      entityType: 'invite', entityId: rows[0].id,
      details: `Token for ${email} / role: ${role}`,
    });

    res.status(201).json({ id: rows[0].id, token, email: rows[0].email, role, expiresAt });
  } catch (err) { next(err); }
});

// ─── DELETE /api/invites/:id ───────────────────────
router.delete('/:id', requireAuth, requirePerm('createInvite'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'DELETE FROM invites WHERE id = $1 AND used_at IS NULL RETURNING id', [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Invite not found or already used' });
    await writeAudit(req, 'INVITE_REVOKED', { entityType: 'invite', entityId: req.params.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
