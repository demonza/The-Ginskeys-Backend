// ══════════════════════════════════════════════════
// DB MIGRATION V4 — Tech Rider persistence
// Run with: node db/migrate_v4.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV4() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Single-row key/value store for the tech rider.
    // Each editable field in the rider gets a unique key (e.g. "lineup_fabio_role").
    // The band has one shared rider doc, so no user FK — just band-level data.
    await client.query(`
      CREATE TABLE IF NOT EXISTS tech_rider_fields (
        field_key   TEXT PRIMARY KEY,
        field_value TEXT NOT NULL DEFAULT '',
        updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V4 complete — tech_rider_fields.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V4 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV4();
