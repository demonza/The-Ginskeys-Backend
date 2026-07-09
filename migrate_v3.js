// ══════════════════════════════════════════════════
// DB MIGRATION V7 — Link booking_contacts → tours
// Run with: node db/migrate_v7.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV7() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Add tour_id FK to booking_contacts (idempotent)
    await client.query(`
      ALTER TABLE booking_contacts
        ADD COLUMN IF NOT EXISTS tour_id UUID REFERENCES tours(id) ON DELETE SET NULL;
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_booking_tour_id
        ON booking_contacts(tour_id)
        WHERE tour_id IS NOT NULL;
    `);

    // Add updated_at to tours (idempotent)
    await client.query(`
      ALTER TABLE tours
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V7 complete — booking_contacts.tour_id + tours.updated_at added.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V7 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV7();
