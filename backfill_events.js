// ══════════════════════════════════════════════════
// DB MIGRATION V9 — The Green Room (band chat)
// Run with: node db/migrate_v9.js
//
// These tables are ALSO auto-created on server boot (see index.js) so a fresh
// Railway deploy works without running this manually. Running it explicitly is
// harmless — every statement is IF NOT EXISTS.
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

const DDL = `
  CREATE TABLE IF NOT EXISTS chat_messages (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    user_name  TEXT NOT NULL,
    user_role  TEXT,
    body       TEXT NOT NULL DEFAULT '',
    -- Optional rich embed pulled from elsewhere in the console.
    -- embed_type: booking | show | release | invoice | tour | document
    embed_type TEXT,
    embed_id   TEXT,
    embed_data JSONB,
    reactions  JSONB NOT NULL DEFAULT '{}'::jsonb,
    pinned     BOOLEAN NOT NULL DEFAULT false,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_chat_pinned  ON chat_messages(pinned) WHERE pinned = true;

  -- Per-user read cursor + lightweight presence (last_seen updated on every poll).
  CREATE TABLE IF NOT EXISTS chat_reads (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function migrateV9() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(DDL);
    await client.query('COMMIT');
    console.log('✅ Migration V9 complete — chat_messages, chat_reads (Green Room).');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V9 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) migrateV9();
module.exports = { CHAT_DDL: DDL };
