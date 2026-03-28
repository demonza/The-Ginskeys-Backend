// ══════════════════════════════════════════════════
// DB MIGRATION V3 — Live Production tables
// Run with: node db/migrate_v3.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV3() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS production_shows (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        booking_id       UUID REFERENCES booking_contacts(id) ON DELETE SET NULL,
        show_date        DATE NOT NULL,
        venue_name       TEXT,
        venue_address    TEXT,
        load_in_time     TIME,
        soundcheck_time  TIME,
        doors_time       TIME,
        show_time        TIME,
        set_length_min   INTEGER,
        stage_width_m    NUMERIC(5,1),
        stage_depth_m    NUMERIC(5,1),
        pa_system        TEXT,
        console_foh      TEXT,
        console_mon      TEXT,
        notes            TEXT,
        created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at       TIMESTAMPTZ DEFAULT now(),
        updated_at       TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_shows_date ON production_shows(show_date DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS setlists (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        show_id     UUID REFERENCES production_shows(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS setlist_items (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        setlist_id   UUID NOT NULL REFERENCES setlists(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL,
        title        TEXT NOT NULL,
        musical_key  TEXT,
        bpm          INTEGER,
        duration_sec INTEGER,
        tuning       TEXT DEFAULT 'Standard',
        notes        TEXT,
        created_at   TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_setlist_items ON setlist_items(setlist_id,position);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS show_checklist_items (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        show_id          UUID NOT NULL REFERENCES production_shows(id) ON DELETE CASCADE,
        phase            TEXT NOT NULL
                           CHECK (phase IN ('pre_show','load_in','soundcheck','show_day','post_show')),
        position         INTEGER NOT NULL,
        task             TEXT NOT NULL,
        owner            TEXT,
        due_offset_hours INTEGER DEFAULT 0,
        done             BOOLEAN DEFAULT false,
        done_at          TIMESTAMPTZ,
        created_at       TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_checklist_show ON show_checklist_items(show_id,phase);
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V3 complete — production_shows, setlists, setlist_items, show_checklist_items.');
  } catch(err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V3 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV3();
