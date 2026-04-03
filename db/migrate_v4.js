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

    // Drop old version if it exists (no show_id column)
    await client.query(`DROP TABLE IF EXISTS tech_rider_fields`);

    // Per-show rider fields.
    // show_id = NULL  → global template / default values
    // show_id = UUID  → overrides for that specific show
    await client.query(`
      CREATE TABLE IF NOT EXISTS tech_rider_fields (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        show_id     UUID REFERENCES production_shows(id) ON DELETE CASCADE,
        field_key   TEXT NOT NULL,
        field_value TEXT NOT NULL DEFAULT '',
        updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (field_key, show_id)
      );
      CREATE INDEX IF NOT EXISTS idx_rider_show ON tech_rider_fields(show_id);
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V4 complete — tech_rider_fields (with show_id support).');
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
