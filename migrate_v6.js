// ══════════════════════════════════════════════════════════════════
// DB MIGRATION V10 — Trust Engine
//   1. Hash-chained audit log   (tamper-evident history)
//   2. Event store              (append-only financial events)
//   3. Ledger entries           (derived double-entry money movements)
//
// This layer is ADDITIVE. The existing transactions / treasury_pool /
// member_account_txns tables are untouched and keep working. The event
// store is a parallel, verifiable record: every money movement is written
// as an immutable event, and balances are DERIVED by replaying events
// rather than mutated in place. A verification routine proves that
//   (a) the audit chain is unbroken, and
//   (b) the derived balances equal the sum of recorded events.
//
// Run with: node db/migrate_v10.js
// Also auto-applied on server boot (all statements are IF NOT EXISTS).
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

const TRUST_DDL = `
  -- ── 1. HASH-CHAINED AUDIT LOG ────────────────────────────────────
  -- Each row seals the previous row's hash. Recomputing the chain proves
  -- no historical row was altered, deleted, or inserted out of order.
  -- We keep the existing audit_log intact and add the chaining columns;
  -- new writes populate them, old rows have seq = NULL and are ignored
  -- by the verifier (chain starts at the first sequenced row).
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS seq        BIGINT;
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash  TEXT;
  ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash TEXT;

  CREATE SEQUENCE IF NOT EXISTS audit_seq START 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq ON audit_log(seq) WHERE seq IS NOT NULL;

  -- ── 2. EVENT STORE ───────────────────────────────────────────────
  -- Append-only. Rows are NEVER updated or deleted. A correction is a new
  -- event (e.g. 'reversal') that points at the event it corrects. This is
  -- the honest version of an "immutable ledger" — no blockchain required.
  CREATE TABLE IF NOT EXISTS fin_events (
    seq          BIGSERIAL PRIMARY KEY,
    id           UUID NOT NULL DEFAULT gen_random_uuid(),
    event_type   TEXT NOT NULL,          -- revenue_received | expense_paid |
                                         -- treasury_allocated | member_deposit |
                                         -- member_withdrawal | reversal | adjustment
    amount_eur   NUMERIC(14,2) NOT NULL, -- signed at the ACCOUNT level (see fin_ledger)
    currency     TEXT NOT NULL DEFAULT 'EUR',
    occurred_on  DATE NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    -- provenance: links back to the classic tables so nothing is orphaned
    source_table TEXT,                   -- 'transactions' | 'treasury_pool' | 'member_account_txns'
    source_id    TEXT,
    reverses_seq BIGINT REFERENCES fin_events(seq), -- set only on reversal events
    metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
    prev_hash    TEXT,
    entry_hash   TEXT NOT NULL,
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_fin_events_type    ON fin_events(event_type);
  CREATE INDEX IF NOT EXISTS idx_fin_events_source  ON fin_events(source_table, source_id);
  CREATE INDEX IF NOT EXISTS idx_fin_events_date    ON fin_events(occurred_on);

  -- ── 3. LEDGER ENTRIES (double-entry) ─────────────────────────────
  -- Every event expands into one or more balanced ledger lines. Each line
  -- credits/debits a named account. Account balance = SUM(amount_eur) over
  -- its lines. Because entries are append-only and derived from events,
  -- balances are reproducible and auditable to the cent.
  --
  -- Accounts (string keys, no separate table needed at this scale):
  --   band_cash                — the band's real cash position (Treasury)
  --   member:<key>             — a member wallet (member:pedro, member:tiago…)
  --   band_fund                — the shared band fund
  --   external                 — the outside world (gig payer, shop, taxman)
  CREATE TABLE IF NOT EXISTS fin_ledger (
    id          BIGSERIAL PRIMARY KEY,
    event_seq   BIGINT NOT NULL REFERENCES fin_events(seq),
    account     TEXT NOT NULL,
    amount_eur  NUMERIC(14,2) NOT NULL,  -- +credit into account, -debit out of account
    occurred_on DATE NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_fin_ledger_account ON fin_ledger(account);
  CREATE INDEX IF NOT EXISTS idx_fin_ledger_event   ON fin_ledger(event_seq);
`;

async function migrateV10() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(TRUST_DDL);
    await client.query('COMMIT');
    console.log('✅ Migration V10 complete — hash-chained audit + event store + double-entry ledger.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V10 failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    if (require.main === module) await pool.end();
  }
}

if (require.main === module) migrateV10();
module.exports = { TRUST_DDL };
