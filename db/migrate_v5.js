// ══════════════════════════════════════════════════
// DB MIGRATION V5 — Member Account Ledger
// Run with: node db/migrate_v5.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV5() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Per-member transaction ledger.
    // txn_type:
    //   split_credit  → money earned from a gig split (auto-posted when saveSplit fires)
    //   withdrawal    → member takes money out (manual)
    //   deposit       → money added to account (manual: merch, royalties, etc)
    await client.query(`
      CREATE TABLE IF NOT EXISTS member_account_txns (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        member_key  TEXT NOT NULL,
        member_name TEXT NOT NULL,
        amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        txn_type    TEXT NOT NULL CHECK (txn_type IN ('split_credit','withdrawal','deposit')),
        description TEXT,
        txn_date    DATE NOT NULL DEFAULT CURRENT_DATE,
        split_id    UUID REFERENCES gig_splits(id) ON DELETE SET NULL,
        created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_member_txns_key
        ON member_account_txns(member_key, txn_date DESC);
      CREATE INDEX IF NOT EXISTS idx_member_txns_date
        ON member_account_txns(txn_date DESC);
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V5 complete — member_account_txns.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V5 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV5();
