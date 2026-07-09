// ══════════════════════════════════════════════════
// DB MIGRATION V6 — Invoices + Members persistence
// Run with: node db/migrate_v6.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrateV6() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── INVOICES ──────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        number        TEXT NOT NULL,
        client_name   TEXT NOT NULL,
        client_email  TEXT,
        client_nif    TEXT,
        client_address TEXT,
        client_contact TEXT,
        venue         TEXT,
        show_date     DATE,
        description   TEXT,
        base_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
        expenses      NUMERIC(12,2) NOT NULL DEFAULT 0,
        iva_rate      NUMERIC(5,2)  NOT NULL DEFAULT 0,
        total         NUMERIC(12,2) NOT NULL DEFAULT 0,
        issued_date   DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date      DATE,
        status        TEXT NOT NULL DEFAULT 'sent'
                        CHECK (status IN ('draft','sent','paid','overdue','cancelled')),
        paid_date     DATE,
        paid_method   TEXT,
        notes         TEXT,
        band_nif      TEXT,
        band_iban     TEXT,
        band_email    TEXT,
        booking_id    UUID REFERENCES booking_contacts(id) ON DELETE SET NULL,
        ledger_txn_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
        created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at    TIMESTAMPTZ DEFAULT now(),
        updated_at    TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_invoices_status  ON invoices(status);
      CREATE INDEX IF NOT EXISTS idx_invoices_due     ON invoices(due_date);
      CREATE INDEX IF NOT EXISTS idx_invoices_issued  ON invoices(issued_date DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_number ON invoices(number);
    `);

    // ── REHEARSALS ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS rehearsals (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rehearsal_date DATE NOT NULL,
        location    TEXT,
        notes       TEXT,
        attendance  JSONB NOT NULL DEFAULT '{}',
        created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_rehearsals_date ON rehearsals(rehearsal_date DESC);
    `);

    // ── DECISIONS ─────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS band_decisions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title       TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        votes_for   INTEGER DEFAULT 0,
        votes_against INTEGER DEFAULT 0,
        decided_at  DATE NOT NULL DEFAULT CURRENT_DATE,
        notes       TEXT,
        created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_date ON band_decisions(decided_at DESC);
    `);

    // ── BAND AGREEMENT (single-row, upsert by key) ────
    await client.query(`
      CREATE TABLE IF NOT EXISTS band_settings (
        key         TEXT PRIMARY KEY,
        value       JSONB NOT NULL,
        updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        updated_at  TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query('COMMIT');
    console.log('✅ Migration V6 complete — invoices, rehearsals, band_decisions, band_settings.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V6 failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrateV6();
