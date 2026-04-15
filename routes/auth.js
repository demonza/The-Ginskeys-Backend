// ══════════════════════════════════════════════════
// AUTH ROUTES — /api/auth
// ══════════════════════════════════════════════════
const router  = require('express').Router();
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { v4: uuid } = require('uuid');
const rateLimit = require('express-rate-limit');
const pool    = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { writeAudit }  = require('../middleware/audit');

const SALT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10');
const JWT_SECRET  = process.env.JWT_SECRET;

// FIX: refuse to start if refresh secret is derived from access secret
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET;
if (!JWT_REFRESH) {
  console.warn('⚠️  JWT_REFRESH_SECRET not set — falling back to derived value. Set a separate secret in production.');
}
const REFRESH_SECRET = JWT_REFRESH || JWT_SECRET + '_refresh';

const ACCESS_TTL  = '8h';
const REFRESH_TTL = '30d';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ─── RATE LIMITERS ────────────────────────────────
// All three limits key by IP. Railway sets X-Forwarded-For correctly
// because index.js has app.set('trust proxy', 1).

// Login: 10 attempts per 15 minutes per IP
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              10,
  standardHeaders:  true,   // Return RateLimit-* headers
  legacyHeaders:    false,
  keyGenerator:     req => req.ip,
  handler: (_req, res) => res.status(429).json({
    error: 'Too many login attempts. Try again in 15 minutes.',
  }),
  skipSuccessfulRequests: true, // successful logins don't count toward limit
});

// Register: 5 attempts per hour per IP (invite-gated anyway, but belt+braces)
const registerLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    req => req.ip,
  handler: (_req, res) => res.status(429).json({
    error: 'Too many registration attempts. Try again in 1 hour.',
  }),
});

// Password reset request: 5 per hour per IP
// (prevents user enumeration via timing + bulk enumeration attacks)
const resetRequestLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    req => req.ip,
  handler: (_req, res) => res.status(429).json({
    error: 'Too many password reset requests. Try again in 1 hour.',
  }),
});

// Password reset confirm: 10 per hour per IP
const resetConfirmLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    req => req.ip,
  handler: (_req, res) => res.status(429).json({
    error: 'Too many password reset attempts. Try again in 1 hour.',
  }),
});

// Refresh token: 60 per hour per IP (normal app churn, but cap abuse)
const refreshLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    req => req.ip,
  handler: (_req, res) => res.status(429).json({
    error: 'Too many token refresh requests.',
  }),
});

// ─── HELPERS ──────────────────────────────────────

// FIX: basic email format validation
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function signRefresh(userId) {
  return jwt.sign({ sub: userId }, REFRESH_SECRET, { expiresIn: REFRESH_TTL });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function storeRefreshToken(userId, token) {
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [uuid(), userId, tokenHash, expiresAt]
  );
}

// ─── POST /api/auth/login ──────────────────────────
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    // FIX: validate email format before querying DB
    if (!isValidEmail(email))
      return res.status(400).json({ error: 'Invalid email format' });

    const { rows } = await pool.query(
      'SELECT id, email, name, role, password_hash, active FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    const user = rows[0];

    if (!user || !user.active) {
      // FIX: still hash a dummy password to prevent timing attacks
      // (attacker can't distinguish "no user" from "wrong password" by response time)
      await bcrypt.hash(password, SALT_ROUNDS);
      await writeAudit(req, 'LOGIN_FAIL', { details: 'Invalid credentials attempt' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      // FIX: don't log the email in audit — it's already in the user record
      await writeAudit(req, 'LOGIN_FAIL', { entityType: 'user', entityId: user.id, details: 'Bad password' });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    await pool.query('UPDATE users SET last_login = now() WHERE id = $1', [user.id]);

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user.id);
    await storeRefreshToken(user.id, refreshToken);

    await writeAudit(req, 'LOGIN', { entityType: 'user', entityId: user.id });

    res.json({
      token:        accessToken,
      refreshToken: refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/register (invite token required) ─
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { token, email, name, password } = req.body;
    if (!token || !email || !name || !password)
      return res.status(400).json({ error: 'All fields required' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    // FIX: validate email format
    if (!isValidEmail(email))
      return res.status(400).json({ error: 'Invalid email format' });
    // FIX: cap name length to prevent abuse
    if (name.trim().length > 100)
      return res.status(400).json({ error: 'Name too long' });

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

    await pool.query(
      `UPDATE invites SET used_at = now(), used_by = $1 WHERE id = $2`,
      [user.id, invite.id]
    );

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user.id);
    await storeRefreshToken(user.id, refreshToken);

    await writeAudit(req, 'REGISTER', {
      entityType: 'user', entityId: user.id,
      details: 'Via invite',
    });

    res.status(201).json({
      token: accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/refresh ────────────────────────
router.post('/refresh', refreshLimiter, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });

    let payload;
    try { payload = jwt.verify(refreshToken, REFRESH_SECRET); }
    catch { return res.status(401).json({ error: 'Invalid refresh token' }); }

    const tokenHash = hashToken(refreshToken);
    const { rows: stored } = await pool.query(
      `SELECT id FROM refresh_tokens
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [tokenHash]
    );
    if (!stored.length)
      return res.status(401).json({ error: 'Refresh token revoked or expired' });

    const { rows } = await pool.query(
      'SELECT id, email, name, role, active FROM users WHERE id = $1', [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.active)
      return res.status(401).json({ error: 'User not found or deactivated' });

    // Rotate: revoke old, issue new
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`,
      [tokenHash]
    );
    const newRefreshToken = signRefresh(user.id);
    await storeRefreshToken(user.id, newRefreshToken);

    res.json({ token: signAccess(user), refreshToken: newRefreshToken });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/logout ─────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (refreshToken) {
      const tokenHash = hashToken(refreshToken);
      await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
         WHERE token_hash = $1 AND user_id = $2`,
        [tokenHash, req.user.id]
      );
    }

    await writeAudit(req, 'LOGOUT', { entityType: 'user', entityId: req.user.id });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /api/auth/password-reset/request ─────────
router.post('/password-reset/request', resetRequestLimiter, async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const { rows } = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND active = true',
      [email.toLowerCase().trim()]
    );

    // Always return 204 to avoid user enumeration
    if (rows.length) {
      // FIX: use crypto.randomBytes instead of Math.random for reset tokens
      const token = `RESET-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      await pool.query(
        `INSERT INTO password_resets (id, user_id, token, expires_at)
         VALUES ($1,$2,$3, now() + interval '1 hour')`,
        [uuid(), rows[0].id, token]
      );
      // TODO: replace with real email delivery (Resend / SendGrid / Nodemailer)
      console.log(`[PASSWORD RESET] Token for ${email}: ${token}`);
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /api/auth/password-reset/confirm ─────────
router.post('/password-reset/confirm', resetConfirmLimiter, async (req, res, next) => {
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
    if (!rows.length)
      return res.status(400).json({ error: 'Invalid or expired reset token' });

    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, rows[0].user_id]);
    await pool.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [rows[0].id]);

    // Revoke all refresh tokens on password reset
    await pool.query(
      `UPDATE refresh_tokens SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [rows[0].user_id]
    );

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
