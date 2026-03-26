const pool = require('../db/pool');

async function writeAudit(req, action, { entityType='', entityId='', details='', oldValue=null, newValue=null } = {}) {
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
