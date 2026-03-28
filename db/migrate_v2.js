// ══════════════════════════════════════════════════
// DB MIGRATION V2 — new growth engine tables
// Run with: node db/migrate_v2.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV2() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── BOOKING CRM ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS booking_contacts (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name            TEXT NOT NULL,
        type            TEXT DEFAULT 'venue' CHECK (type IN ('venue','festival','private','corporate','wedding','other')),
        location        TEXT,
        contact_name    TEXT,
        contact_email   TEXT,
        stage           TEXT NOT NULL DEFAULT 'cold'
                          CHECK (stage IN ('cold','contacted','negotiating','confirmed','completed','rejected')),
        fee_eur         NUMERIC(10,2),
        date            DATE,
        contacted_at    TIMESTAMPTZ,
        follow_up_date  DATE,
        notes           TEXT,
        created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT now(),
        updated_at      TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_booking_stage    ON booking_contacts(stage);
      CREATE INDEX IF NOT EXISTS idx_booking_followup ON booking_contacts(follow_up_date);
    `);

    // ── RELEASES ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS releases (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title            TEXT NOT NULL,
        type             TEXT DEFAULT 'single' CHECK (type IN ('single','ep','album','live','remix')),
        stage            TEXT DEFAULT 'idea'
                           CHECK (stage IN ('idea','recorded','mixed','mastered','artwork','submitted','scheduled','released')),
        release_date     DATE,
        spotify_url      TEXT,
        artwork_done     BOOLEAN DEFAULT false,
        video_done       BOOLEAN DEFAULT false,
        press_pitched    BOOLEAN DEFAULT false,
        spotify_pitched  BOOLEAN DEFAULT false,
        notes            TEXT,
        created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at       TIMESTAMPTZ DEFAULT now(),
        updated_at       TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS release_tracks (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        release_id   UUID NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        position     INTEGER NOT NULL,
        duration_sec INTEGER,
        isrc         TEXT,
        created_at   TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_reltracks_release ON release_tracks(release_id);
    `);

    // ── PRESS & SYNC ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS press_contacts (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        outlet               TEXT NOT NULL,
        type                 TEXT DEFAULT 'press'
                               CHECK (type IN ('press','radio','blog','sync','playlist','podcast','tv','other')),
        contact_name         TEXT,
        contact_email        TEXT,
        country              CHAR(2) DEFAULT 'PT',
        stage                TEXT DEFAULT 'target'
                               CHECK (stage IN ('target','pitched','following_up','responded','published','rejected')),
        pitched_release      TEXT,
        published_url        TEXT,
        estimated_value_eur  NUMERIC(10,2),
        follow_up_date       DATE,
        notes                TEXT,
        created_by           UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at           TIMESTAMPTZ DEFAULT now(),
        updated_at           TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_press_stage ON press_contacts(stage);
    `);

    // ── GIG SPLITS ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS gig_splits (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        gig_name          TEXT NOT NULL,
        gig_date          DATE,
        gross_eur         NUMERIC(10,2) NOT NULL,
        total_expenses_eur NUMERIC(10,2) DEFAULT 0,
        band_fund_eur     NUMERIC(10,2) DEFAULT 0,
        distributable_eur NUMERIC(10,2) NOT NULL,
        member_count      INTEGER NOT NULL,
        per_member_eur    NUMERIC(10,2) NOT NULL,
        notes             TEXT,
        created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at        TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS gig_split_members (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        split_id     UUID NOT NULL REFERENCES gig_splits(id) ON DELETE CASCADE,
        member_name  TEXT NOT NULL,
        base_share   NUMERIC(10,2) NOT NULL,
        expenses_eur NUMERIC(10,2) DEFAULT 0,
        net_eur      NUMERIC(10,2) NOT NULL,
        created_at   TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_splitmembers ON gig_split_members(split_id);
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V2 complete — booking, releases, press, splits tables created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V2 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV2();

// ── This section added for live production module ──
// Run migrate_v2.js again — all CREATE TABLE IF NOT EXISTS are idempotent
async function migrateV2Production(client) {
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
      phase            TEXT NOT NULL CHECK (phase IN ('pre_show','load_in','soundcheck','show_day','post_show')),
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
}
