// ══════════════════════════════════════════════════════════════════
// DB MIGRATION V11 — Booking Forecast Engine
//   Stage-transition history for the booking pipeline, so conversion
//   probabilities can be estimated from what actually happened to your
//   bookings instead of guessed at.
//
// Nothing here reads as "confirmed" data until it has real volume behind
// it — see lib/forecast.js for the honesty threshold (MIN_SAMPLE_SIZE)
// below which the engine falls back to labelled priors instead of
// pretending a tiny sample is a real rate.
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

const FORECAST_DDL = `
  -- Every stage a booking passes through, with a timestamp and the fee
  -- known at that moment (fees sometimes change mid-negotiation, so we
  -- snapshot it rather than joining back to the live booking row later).
  CREATE TABLE IF NOT EXISTS booking_stage_events (
    id           BIGSERIAL PRIMARY KEY,
    booking_id   UUID NOT NULL,
    from_stage   TEXT,               -- NULL on the booking's first stage event
    to_stage     TEXT NOT NULL,
    fee_eur      NUMERIC(10,2),
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_booking_stage_events_booking ON booking_stage_events(booking_id);
  CREATE INDEX IF NOT EXISTS idx_booking_stage_events_to      ON booking_stage_events(to_stage);
`;

async function migrateV11() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(FORECAST_DDL);
    await client.query('COMMIT');
    console.log('✅ Migration V11 complete — booking_stage_events table ready.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration V11 failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    if (require.main === module) await pool.end();
  }
}

if (require.main === module) migrateV11();
module.exports = { FORECAST_DDL };
