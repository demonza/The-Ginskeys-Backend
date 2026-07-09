const crypto = require('crypto');
const pool = require('../db/pool');

// Deterministic hash of an audit entry sealed to the previous entry's hash.
function hashAudit(prevHash, row) {
  const canonical = JSON.stringify({
    user_email: row.user_email,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    details: row.details,
    old_value: row.old_value,
    new_value: row.new_value,
    created_at: row.created_at,
  });
  return crypto.createHash('sha256').update((prevHash || 'GENESIS') + canonical).digest('hex');
}

async function writeAudit(req, action, opts = {}) {
  // Tolerate a bare string as the third argument — several call sites (invoices,
  // members) pass e.g. the invoice number or a rehearsal date directly.
  if (typeof opts === 'string') opts = { details: opts };
  const { entityType = '', entityId = '', details = '', oldValue = null, newValue = null } = opts;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialise audit appends so the hash chain can't fork.
    await client.query('SELECT pg_advisory_xact_lock($1)', [7423191]); // "audit chain"

    const { rows: [tail] } = await client.query(
      'SELECT entry_hash FROM audit_log WHERE seq IS NOT NULL ORDER BY seq DESC LIMIT 1'
    );
    const prevHash = tail?.entry_hash || null;
    const { rows: [seqRow] } = await client.query("SELECT nextval('audit_seq')::bigint AS seq");
    const seq = seqRow.seq;
    const createdAt = new Date().toISOString();

    const rowForHash = {
      user_email: req.user?.email || 'system',
      action,
      entity_type: entityType,
      entity_id: String(entityId),
      details,
      old_value: oldValue ? JSON.stringify(oldValue) : null,
      new_value: newValue ? JSON.stringify(newValue) : null,
      created_at: createdAt,
    };
    const entryHash = hashAudit(prevHash, rowForHash);

    await client.query(
      `INSERT INTO audit_log
         (user_id, user_email, action, entity_type, entity_id, details, old_value, new_value, ip,
          seq, prev_hash, entry_hash, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        req.user?.id || null,
        rowForHash.user_email,
        action,
        entityType,
        String(entityId),
        details,
        rowForHash.old_value,
        rowForHash.new_value,
        req.ip || null,
        seq, prevHash, entryHash, createdAt,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Audit write failed:', err.message);
  } finally {
    client.release();
  }
}

// Walk the sequenced portion of the audit log and confirm each hash.
async function verifyAuditChain() {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log WHERE seq IS NOT NULL ORDER BY seq ASC'
  );
  let prev = null;
  for (const r of rows) {
    const recomputed = hashAudit(prev, {
      user_email: r.user_email,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      details: r.details,
      old_value: r.old_value ? JSON.stringify(r.old_value) : null,
      new_value: r.new_value ? JSON.stringify(r.new_value) : null,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    });
    if (r.prev_hash !== prev || r.entry_hash !== recomputed) {
      return { ok: false, count: rows.length, brokenAt: Number(r.seq) };
    }
    prev = r.entry_hash;
  }
  return { ok: true, count: rows.length, brokenAt: null };
}

module.exports = { writeAudit, verifyAuditChain, hashAudit };
