// ══════════════════════════════════════════════════
// DB MIGRATION — run once with: node db/migrate.js
// ══════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email         TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL CHECK (role IN ('admin','co-admin','manager','accountant','viewer')) DEFAULT 'viewer',
        totp_secret   TEXT,
        totp_enabled  BOOLEAN DEFAULT false,
        active        BOOLEAN DEFAULT true,
        created_at    TIMESTAMPTZ DEFAULT now(),
        last_login    TIMESTAMPTZ
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invites (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        token      TEXT UNIQUE NOT NULL,
        email      TEXT NOT NULL,
        role       TEXT NOT NULL,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        used_by    UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT UNIQUE NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT UNIQUE NOT NULL,
        type       TEXT CHECK (type IN ('income','expense','both')),
        color      TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tours (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name       TEXT NOT NULL,
        start_date DATE,
        end_date   DATE,
        budget     NUMERIC(12,2),
        status     TEXT CHECK (status IN ('planned','active','completed','cancelled')) DEFAULT 'planned',
        notes      TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        date        DATE NOT NULL,
        type        TEXT NOT NULL CHECK (type IN ('income','expense')),
        category_id UUID REFERENCES categories(id) ON DELETE SET NULL,
        amount      NUMERIC(12,2) NOT NULL,
        currency    CHAR(3) NOT NULL DEFAULT 'EUR',
        amount_eur  NUMERIC(12,2),
        description TEXT NOT NULL,
        source_dest TEXT,
        tour_id     UUID REFERENCES tours(id) ON DELETE SET NULL,
        tags        TEXT[] DEFAULT '{}',
        notes       TEXT,
        reconciled  BOOLEAN DEFAULT false,
        created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT now(),
        updated_at  TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_txn_date     ON transactions(date DESC);
      CREATE INDEX IF NOT EXISTS idx_txn_tour     ON transactions(tour_id);
      CREATE INDEX IF NOT EXISTS idx_txn_type     ON transactions(type, date DESC);
      CREATE INDEX IF NOT EXISTS idx_txn_tags     ON transactions USING gin(tags);
      CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
        user_email  TEXT,
        action      TEXT NOT NULL,
        entity_type TEXT DEFAULT '',
        entity_id   TEXT DEFAULT '',
        details     TEXT DEFAULT '',
        old_value   JSONB,
        new_value   JSONB,
        ip          INET,
        created_at  TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_log(created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS streaming_snapshots (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        platform    TEXT NOT NULL,
        period      DATE NOT NULL,
        streams     INTEGER DEFAULT 0,
        revenue_eur NUMERIC(10,2) DEFAULT 0,
        created_at  TIMESTAMPTZ DEFAULT now(),
        UNIQUE (platform, period)
      );
    `);

    // Seed default categories
    await client.query(`
      INSERT INTO categories (name, type) VALUES
        ('Espetáculo',   'income'),
        ('Doações',      'income'),
        ('Crédito',      'income'),
        ('Streaming',    'income'),
        ('Licensing',    'income'),
        ('Patrocínio',   'income'),
        ('Equipamento',  'expense'),
        ('Estúdio',      'expense'),
        ('Transporte',   'expense'),
        ('Distribuição', 'expense'),
        ('Impostos',     'expense'),
        ('Marketing',    'expense'),
        ('Artwork',      'expense'),
        ('Outros',       'expense')
      ON CONFLICT (name) DO NOTHING;
    `);

    await client.query('COMMIT');
    console.log('✅ Migration complete.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
