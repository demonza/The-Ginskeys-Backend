const pool = require('../db/pool');

async function writeAudit(req, action, opts = {}) {
  // Tolerate a bare string as the third argument — several call sites (invoices,
  // members) pass e.g. the invoice number or a rehearsal date directly. Without
  // this, destructuring a string yielded all-undefined fields and silently
  // discarded the detail text, producing audit rows with no context.
  if (typeof opts === 'string') opts = { details: opts };
  const { entityType = '', entityId = '', details = '', oldValue = null, newValue = null } = opts;
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, user_email, action, entity_type, entity_id, details, old_value, new_value, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        req.user?.id   || null,
        req.user?.email || 'system',
        action,
        entityType,
        String(entityId),
        details,
        oldValue  ? JSON.stringify(oldValue)  : null,
        newValue  ? JSON.stringify(newValue)  : null,
        req.ip    || null,
      ]
    );
  } catch (err) {
    console.error('Audit write failed:', err.message);
  }
}

module.exports = { writeAudit };
