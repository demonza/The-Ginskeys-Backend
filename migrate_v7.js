const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is not set. Cannot create database pool.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // FIX: in production, Railway provides DATABASE_URL with sslmode=require
  // rejectUnauthorized:false disables certificate verification — acceptable for
  // Railway's managed PostgreSQL but should be documented as a conscious tradeoff
  ssl: process.env.DATABASE_URL?.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : (process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false),
  connectionTimeoutMillis: 5000,  // fail fast if DB is unreachable
  idleTimeoutMillis: 30000,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error:', err.message);
});

module.exports = pool;
