// ══════════════════════════════════════════════════
// AUTH ROUTES — /api/auth
// ══════════════════════════════════════════════════
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { writeAudit }  = require('../middleware/audit');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12');
const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET || JWT_SECRET + '_refresh';
const ACCESS_TTL  = '8h';
const REFRESH_TTL = '30d';

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}
function signRefresh(userId) {
  return jwt.sign({ sub: userId }, JWT_REFRESH, { expiresIn: REFRESH_TTL });
}

// ─── POST /api/auth/login ──────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    const { rows } = await pool.query(
      'SELECT id, email, name, role, password_hash, active FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user || !user.active) {
      await writeAudit(req, 'LOGIN_FAIL', { details: 'No account: ' + email });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      await writeAudit(req, 'LOGIN_FAIL', { details: 'Bad password: ' + email });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user.id);

    await writeAudit(req, 'LOGIN', { entityType: 'user', entityId: user.id });

    res.json({
      token:        accessToken,
      refreshToken: refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/register (invite token required) ─
router.post('/register', async (req, res, next) => {
  try {
    const { token, email, name, password } = req.body;
    if (!token || !email || !name || !password)
      return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { rows: invRows } = await pool.query(
      `SELECT * FROM invites WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
      [token.toUpperCase()]
    );
    const invite = invRows[0];
    if (!invite)
      return res.status(400).json({ error: 'Invalid or expired invite token' });

    const targetEmail = email.toLowerCase().trim();
    if (invite.email && invite.email.toLowerCase() !== targetEmail)
      return res.status(400).json({ error: 'Token was issued for a different email' });

    const { rows: existing } = await pool.query(
      'SELECT id FROM users WHERE email = $1', [targetEmail]
    );
    if (existing.length)
      return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows: created } = await pool.query(
      `INSERT INTO users (id, email, name, role, password_hash, active)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING id, email, name, role`,
      [uuid(), targetEmail, name.trim(), invite.role, hash]
    );
    const user = created[0];

    await pool.query(`UPDATE invites SET used_at = now(), used_by = $1 WHERE id = $2`,
      [user.id, invite.id]
    );

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user.id);
    await writeAudit(req, 'REGISTER', { entityType: 'user', entityId: user.id, details: 'Via invite ' + token });

    res.status(201).json({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/refresh ────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    let payload;
    try { payload = jwt.verify(refreshToken, JWT_REFRESH); }
    catch { return res.status(401).json({ error: 'Invalid refresh token' }); }

    const { rows } = await pool.query(
      'SELECT id, email, name, role, active FROM users WHERE id = $1', [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.active)
      return res.status(401).json({ error: 'User not found or deactivated' });

    res.json({ token: signAccess(user) });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/logout ─────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await writeAudit(req, 'LOGOUT', { entityType: 'user', entityId: req.user.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /api/auth/password-reset/request ─────────
router.post('/password-reset/request', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND active = true',
      [email.toLowerCase().trim()]
    );
    // Always return 204 to avoid user enumeration
    if (rows.length) {
      const rand = () => Math.random().toString(36).substring(2,6).toUpperCase();
      const token = `RESET-${rand()}-${rand()}`;
      await pool.query(
        `INSERT INTO password_resets (id, user_id, token, expires_at)
         VALUES ($1,$2,$3, now() + interval '1 hour')`,
        [uuid(), rows[0].id, token]
      );
      // In production: send email here. For now, log to console.
      console.log(`[PASSWORD RESET] Token for ${email}: ${token}`);
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /api/auth/password-reset/confirm ─────────
router.post('/password-reset/confirm', async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;
    if (!token || !newPassword)
      return res.status(400).json({ error: 'Token and new password required' });
    if (newPassword.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const { rows } = await pool.query(
      `SELECT pr.id, pr.user_id FROM password_resets pr
       WHERE pr.token = $1 AND pr.used_at IS NULL AND pr.expires_at > now()`,
      [token.toUpperCase()]
    );
    if (!rows.length) return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, rows[0].user_id]);
    await pool.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [rows[0].id]);
    await writeAudit(req, 'PASSWORD_RESET', { entityType: 'user', entityId: rows[0].user_id });

    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── GET /api/auth/me ──────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { id, email, name, role } = req.user;
  res.json({ id, email, name, role });
});

module.exports = router;
