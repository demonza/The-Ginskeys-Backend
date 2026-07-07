// ══════════════════════════════════════════════════════════════════
// REPAIR — member_account_txns direction mismatches
//
// Context: the console's "Add Transaction" modal used to mirror EVERY
// member-linked ledger transaction as a 'withdrawal', even when the
// ledger transaction was income. Result: income routed to a member's
// wallet (e.g. Pedro's €2,000) was SUBTRACTED instead of added.
//
// This script finds every member_account_txns row whose direction
// contradicts its linked ledger transaction and flips it:
//   ledger 'income'  + wallet 'withdrawal' → 'deposit'
//   ledger 'expense' + wallet 'deposit'    → 'withdrawal'
// (split_credit rows from treasury allocations are never touched.)
//
// Usage:
//   node db/repair_member_txn_directions.js           → dry run (report only)
//   node db/repair_member_txn_directions.js --apply   → fix the rows
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

const APPLY = process.argv.includes('--apply');

async function run() {
  const client = await pool.connect();
  try {
    const { rows: mismatches } = await client.query(`
      SELECT m.id, m.member_key, m.member_name, m.amount, m.txn_type,
             m.txn_date, m.description, t.type AS ledger_type
      FROM member_account_txns m
      JOIN transactions t ON t.id = m.ledger_txn_id
      WHERE (t.type = 'income'  AND m.txn_type = 'withdrawal')
         OR (t.type = 'expense' AND m.txn_type = 'deposit')
      ORDER BY m.txn_date
    `);

    if (!mismatches.length) {
      console.log('✅ No direction mismatches found — nothing to repair.');
      return;
    }

    console.log(`Found ${mismatches.length} mismatched row(s):\n`);
    for (const r of mismatches) {
      const fix = r.ledger_type === 'income' ? 'deposit' : 'withdrawal';
      console.log(
        `  ${String(r.txn_date).slice(0, 10)}  ${r.member_name.padEnd(10)} ` +
        `€${parseFloat(r.amount).toFixed(2).padStart(9)}  ` +
        `${r.txn_type} → ${fix}  (ledger: ${r.ledger_type})  "${r.description || ''}"`
      );
    }

    if (!APPLY) {
      console.log('\nDry run only. Re-run with --apply to fix these rows.');
      return;
    }

    await client.query('BEGIN');
    const { rowCount } = await client.query(`
      UPDATE member_account_txns m
      SET txn_type = CASE
        WHEN t.type = 'income'  THEN 'deposit'
        WHEN t.type = 'expense' THEN 'withdrawal'
        ELSE m.txn_type
      END
      FROM transactions t
      WHERE t.id = m.ledger_txn_id
        AND ((t.type = 'income'  AND m.txn_type = 'withdrawal')
          OR (t.type = 'expense' AND m.txn_type = 'deposit'))
    `);
    await client.query('COMMIT');
    console.log(`\n✅ Repaired ${rowCount} row(s). Member wallet balances now reflect the correct direction.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Repair failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
