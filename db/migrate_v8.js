// ══════════════════════════════════════════════════
// DB MIGRATION V8 — Treasury Pool System
// Converts Splits → Treasury model where all net revenue
// pools before manual member allocation.
// Run with: node db/migrate_v8.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV8() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Treasury Pool: holds unallocated revenue from all sources ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS treasury_pool (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type   TEXT NOT NULL CHECK (source_type IN ('gig','streaming','merch','sync','other')),
        source_id     UUID,
        description   TEXT NOT NULL,
        gross_eur     NUMERIC(12,2) NOT NULL DEFAULT 0,
        expenses_eur  NUMERIC(12,2) NOT NULL DEFAULT 0,
        net_eur       NUMERIC(12,2) NOT NULL DEFAULT 0,
        allocated_eur NUMERIC(12,2) NOT NULL DEFAULT 0,
        status        TEXT NOT NULL DEFAULT 'unallocated'
                        CHECK (status IN ('unallocated','partial','allocated')),
        revenue_date  DATE,
        ledger_txn_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
        notes         TEXT,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_treasury_status ON treasury_pool(status);
      CREATE INDEX IF NOT EXISTS idx_treasury_date   ON treasury_pool(revenue_date DESC);
      CREATE INDEX IF NOT EXISTS idx_treasury_source ON treasury_pool(source_type, source_id);
    `);

    // ── Treasury Allocations: individual allocation records ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS treasury_allocations (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        treasury_id     UUID NOT NULL REFERENCES treasury_pool(id) ON DELETE CASCADE,
        member_key      TEXT NOT NULL,
        member_name     TEXT NOT NULL,
        amount          NUMERIC(10,2) NOT NULL CHECK (amount > 0),
        member_txn_id   UUID REFERENCES member_account_txns(id) ON DELETE SET NULL,
        created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at      TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alloc_treasury ON treasury_allocations(treasury_id);
      CREATE INDEX IF NOT EXISTS idx_alloc_member   ON treasury_allocations(member_key);
    `);

    // ── Add treasury_id to member_account_txns for backlink ──
    await client.query(`
      ALTER TABLE member_account_txns
        ADD COLUMN IF NOT EXISTS treasury_id UUID REFERENCES treasury_pool(id) ON DELETE SET NULL;
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V8 complete — Treasury pool + allocations tables created.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V8 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV8();
