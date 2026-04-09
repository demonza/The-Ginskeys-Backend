const jwt  = require('jsonwebtoken');
const pool = require('../db/pool');

// ─── VERIFY JWT ────────────────────────────────────────
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // Confirm user still active
    const { rows } = await pool.query(
      'SELECT id, email, name, role, active FROM users WHERE id = $1',
      [payload.sub]
    );
    const user = rows[0];
    if (!user || !user.active) return res.status(401).json({ error: 'User not found or deactivated' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─── ROLE PERMISSION MATRIX ────────────────────────────
// Both admin and co-admin have full transaction permissions.
// Only admin can manageUsers (change roles, deactivate accounts).
const PERMS = {
  'admin':      ['viewLedger','addTxn','editTxn','deleteTxn','createInvite','manageUsers','viewAudit','viewAccess','importData'],
  'co-admin':   ['viewLedger','addTxn','editTxn','deleteTxn','createInvite','viewAudit','viewAccess','importData'],
  'manager':    ['viewLedger','addTxn','editTxn'],
  'accountant': ['viewLedger','addTxn','viewAudit'],
  'viewer':     ['viewLedger'],
  'social_media_manager': ['viewReleases','viewPress'],
};

function requirePerm(perm) {
  return (req, res, next) => {
    const userPerms = PERMS[req.user?.role] || [];
    // Support single perm or array of perms (OR logic)
    const permsToCheck = Array.isArray(perm) ? perm : [perm];
    const hasAny = permsToCheck.some(p => userPerms.includes(p));
    if (!hasAny) {
      return res.status(403).json({ error: `Permission denied: requires ${permsToCheck.join(' or ')}` });
    }
    next();
  };
}

module.exports = { requireAuth, requirePerm };
