// ══════════════════════════════════════════════════════════════════
// REPAIR — member_account_txns direction fixer
//
// Two modes, because there are two kinds of bad rows:
//
//  MODE 1 (auto): rows LINKED to a ledger transaction whose direction
//  contradicts it (ledger income + wallet withdrawal, or vice-versa).
//  These are safe to flip automatically — the ledger proves intent.
//
//  MODE 2 (explicit): rows with NO ledger link (ledger column shows "–"
//  in the UI). For these, NO script can safely guess intent, so you
//  target them explicitly by id or by exact match. This is how you fix
//  the €2000 "Pagamento pelos serviços artísticos" row: it was entered
//  as a withdrawal but is income, so flip it to a deposit (+€2000).
//
// EVERY mode prints the exact rows it will touch BEFORE touching them,
// and does nothing without --apply.
//
// Usage:
//   node db/repair_member_txn_directions.js                     → auto dry-run (linked rows)
//   node db/repair_member_txn_directions.js --apply             → auto apply (linked rows)
//   node db/repair_member_txn_directions.js --list PEDRO        → list a member's rows (find the id)
//   node db/repair_member_txn_directions.js --list ALL          → list ALL rows
//   node db/repair_member_txn_directions.js --flip <id> to deposit          → dry-run one row
//   node db/repair_member_txn_directions.js --flip <id> to deposit --apply  → flip one row
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// ── MODE: --list ──────────────────────────────────────────────────
async function hasLedgerCol(client) {
  const { rows } = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'member_account_txns' AND column_name = 'ledger_txn_id'
  `);
  return rows.length > 0;
}

async function listRows(who) {
  const client = await pool.connect();
  try {
    // The ledger_txn_id column only exists in newer schemas. Detect it so this
    // works on databases created by older migrations (where it's absent).
    const linkedCol = await hasLedgerCol(client);
    const params = [];
    let where = '';
    if (who && who.toUpperCase() !== 'ALL') {
      where = `WHERE m.member_key ILIKE $1 OR m.member_name ILIKE $1`;
      params.push(who);
    }
    const { rows } = await client.query(`
      SELECT m.id, m.member_name, m.amount, m.txn_type, m.txn_date, m.description
             ${linkedCol ? ', m.ledger_txn_id' : ''}
      FROM member_account_txns m
      ${where}
      ORDER BY m.txn_date DESC, m.member_name
    `, params);

    if (!rows.length) { console.log('No rows found.'); return; }
    console.log(`\n${rows.length} row(s):\n`);
    for (const r of rows) {
      const dir = r.txn_type === 'withdrawal' ? '- OUT' :
                  r.txn_type === 'deposit'    ? '+ IN ' :
                  r.txn_type === 'split_credit' ? '+ IN*' : r.txn_type;
      const linked = !linkedCol ? 'no-link-col' : (r.ledger_txn_id ? 'linked' : 'UNLINKED');
      console.log(`  ${r.id}`);
      console.log(`     ${String(r.txn_date).slice(0,10)}  ${String(r.member_name).padEnd(8)} ${dir} EUR ${Number(r.amount).toFixed(2).padStart(9)}  [${r.txn_type}, ${linked}]`);
      console.log(`     "${r.description || ''}"\n`);
    }
    console.log('To flip one:  node db/repair_member_txn_directions.js --flip <id> to deposit --apply\n');
  } finally {
    client.release();
    await pool.end();
  }
}

// ── MODE: --flip <id> to <deposit|withdrawal> ─────────────────────
async function flipOne(id, target) {
  if (!['deposit', 'withdrawal'].includes(target)) {
    console.error('❌ target must be "deposit" or "withdrawal"');
    process.exitCode = 1; await pool.end(); return;
  }
  const client = await pool.connect();
  try {
    const { rows } = await client.query(
      `SELECT id, member_name, amount, txn_type, txn_date, description
       FROM member_account_txns WHERE id = $1`, [id]
    );
    if (!rows.length) { console.log('No row with that id.'); return; }
    const r = rows[0];

    console.log('\nRow to change:');
    console.log(`  ${String(r.txn_date).slice(0,10)}  ${r.member_name}  €${Number(r.amount).toFixed(2)}`);
    console.log(`  "${r.description || ''}"`);
    console.log(`  ${r.txn_type}  →  ${target}`);

    const effect = target === 'deposit'
      ? `+€${Number(r.amount).toFixed(2)} will be ADDED to ${r.member_name}'s wallet`
      : `−€${Number(r.amount).toFixed(2)} will be SUBTRACTED from ${r.member_name}'s wallet`;
    console.log(`  Effect: ${effect}\n`);

    if (r.txn_type === target) { console.log('Already that direction — nothing to do.'); return; }

    if (!APPLY) { console.log('Dry run. Add --apply to make this change.'); return; }

    await client.query('BEGIN');
    await client.query(`UPDATE member_account_txns SET txn_type = $1 WHERE id = $2`, [target, id]);
    await client.query('COMMIT');
    console.log('✅ Done. Refresh the console — the wallet balance will reflect the change.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Failed:', err.message); process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// ── MODE: auto (linked rows) ──────────────────────────────────────
async function auto() {
  const client = await pool.connect();
  try {
    if (!(await hasLedgerCol(client))) {
      console.log('This database has no ledger_txn_id column, so there are no LINKED');
      console.log('rows to auto-repair. Use --list and --flip for unlinked rows:');
      console.log('  node db/repair_member_txn_directions.js --list PEDRO');
      return;
    }
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
      console.log('✅ No LINKED direction mismatches found.');
      console.log('   (Unlinked rows are not touched here — use --list then --flip. See header.)');
      return;
    }

    console.log(`Found ${mismatches.length} linked mismatch(es):\n`);
    for (const r of mismatches) {
      const fix = r.ledger_type === 'income' ? 'deposit' : 'withdrawal';
      console.log(`  ${r.id}  ${String(r.txn_date).slice(0,10)}  ${r.member_name} €${Number(r.amount).toFixed(2)}  ${r.txn_type} → ${fix}`);
    }

    if (!APPLY) { console.log('\nDry run. Re-run with --apply.'); return; }

    await client.query('BEGIN');
    const { rowCount } = await client.query(`
      UPDATE member_account_txns m
      SET txn_type = CASE WHEN t.type='income' THEN 'deposit' ELSE 'withdrawal' END
      FROM transactions t
      WHERE t.id = m.ledger_txn_id
        AND ((t.type='income' AND m.txn_type='withdrawal')
          OR (t.type='expense' AND m.txn_type='deposit'))
    `);
    await client.query('COMMIT');
    console.log(`\n✅ Repaired ${rowCount} linked row(s).`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Repair failed:', err.message); process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

// ── Dispatch ──────────────────────────────────────────────────────
const listWho = argVal('--list');
const flipId = argVal('--flip');
if (listWho) {
  listRows(listWho);
} else if (flipId) {
  // syntax: --flip <id> to <target>
  const toIdx = argv.indexOf('to');
  const target = toIdx >= 0 ? argv[toIdx + 1] : null;
  flipOne(flipId, target);
} else {
  auto();
}
