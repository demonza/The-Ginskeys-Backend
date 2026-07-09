// ══════════════════════════════════════════════════════════════════
// BACKFILL — seed the event store from existing history
//
// Replays the classic tables (treasury_pool net revenue, member_account_txns)
// into the append-only event store so derived balances match today's reality
// from the first day the Trust Engine is live.
//
// Idempotent: skips any source row already present in fin_events (matched on
// source_table + source_id). Safe to re-run.
//
// Usage:
//   node db/backfill_events.js          → dry run (report what it WOULD write)
//   node db/backfill_events.js --apply  → write the events
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');
const { appendEvent } = require('../lib/ledger');

const APPLY = process.argv.includes('--apply');

async function alreadyHas(client, table, id) {
  const { rows } = await client.query(
    'SELECT 1 FROM fin_events WHERE source_table = $1 AND source_id = $2 LIMIT 1',
    [table, String(id)]
  );
  return rows.length > 0;
}

async function run() {
  const client = await pool.connect();
  let planned = 0, written = 0;
  try {
    await client.query('BEGIN');

    // 1. Treasury net revenue → revenue_received
    const { rows: pools } = await client.query(
      `SELECT id, source_type, description, net_eur, revenue_date, created_by
       FROM treasury_pool WHERE net_eur > 0 ORDER BY revenue_date NULLS LAST, id`
    );
    for (const p of pools) {
      if (await alreadyHas(client, 'treasury_pool', p.id)) continue;
      planned++;
      console.log(`  + revenue_received  €${Number(p.net_eur).toFixed(2).padStart(9)}  ${p.description}`);
      if (APPLY) {
        await appendEvent(client, {
          event_type: 'revenue_received',
          amount_eur: Number(p.net_eur),
          occurred_on: p.revenue_date || new Date().toISOString().split('T')[0],
          description: `${p.source_type}: ${p.description}`,
          source_table: 'treasury_pool',
          source_id: p.id,
        }, p.created_by);
        written++;
      }
    }

    // 2. Member account movements
    const { rows: mtxns } = await client.query(
      `SELECT id, member_key, member_name, amount, txn_type, description, txn_date, created_by
       FROM member_account_txns ORDER BY txn_date NULLS LAST, id`
    );
    for (const m of mtxns) {
      if (await alreadyHas(client, 'member_account_txns', m.id)) continue;
      const evType = m.txn_type === 'withdrawal' ? 'member_withdrawal'
                   : m.txn_type === 'split_credit' ? 'treasury_allocated'
                   : 'member_deposit';
      planned++;
      const sign = evType === 'member_withdrawal' ? '-' : '+';
      console.log(`  + ${evType.padEnd(18)} ${sign}€${Number(m.amount).toFixed(2).padStart(9)}  ${m.member_name}`);
      if (APPLY) {
        await appendEvent(client, {
          event_type: evType,
          amount_eur: Number(m.amount),
          occurred_on: m.txn_date || new Date().toISOString().split('T')[0],
          description: m.description || m.member_name,
          source_table: 'member_account_txns',
          source_id: m.id,
          metadata: { member_key: m.member_key, account: 'member:' + m.member_key },
        }, m.created_by);
        written++;
      }
    }

    if (APPLY) {
      await client.query('COMMIT');
      console.log(`\n✅ Backfill complete — wrote ${written} event(s).`);
    } else {
      await client.query('ROLLBACK');
      console.log(`\nDry run — ${planned} event(s) would be written. Re-run with --apply.`);
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Backfill failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
