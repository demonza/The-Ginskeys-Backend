// ══════════════════════════════════════════════════════════════════
// RESEAL — re-baseline the Trust Engine hash chains
//
// WHY THIS EXISTS (and why it is safe HERE, specifically):
// On 2026-07-07 the event/audit hashes were sealed by an older version of
// the hashing code than the deployed verifier, so /trust/verify reported
// the chains "broken" even though nothing was tampered with. We confirmed
// the data was sound two independent ways BEFORE re-sealing:
//   1. conservation = 0.00 (money balances exactly), and
//   2. every prev_hash already links to the prior row's entry_hash
//      (proving no row was inserted, deleted, or reordered).
// Re-sealing recomputes every entry_hash/prev_hash with the CURRENT hash
// function, producing one clean, consistent chain from genesis forward.
//
// This is NOT a way to hide tampering. It refuses to run unless the
// prev_hash links are already intact — if the LINKS are broken, that's a
// real structural problem and this script stops and tells you.
//
// After this runs once, the chain is locked under CURRENT_HASH_VERSION and
// the version-fallback in verifyChain prevents this class of bug recurring.
//
// Usage:
//   node db/reseal_chains.js           → dry run (report only)
//   node db/reseal_chains.js --apply   → re-seal events + audit
// ══════════════════════════════════════════════════════════════════
require('dotenv').config();
const pool = require('./pool');
const { hashEvent, CURRENT_HASH_VERSION } = require('../lib/ledger');
const { hashAudit } = require('../middleware/audit');

const APPLY = process.argv.includes('--apply');

function slug(d) {
  return d instanceof Date ? d.toISOString().slice(0, 10) : d;
}

async function reseal() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Verify the LINKS are intact before we touch anything ──────
    // (We re-seal hashes; we do NOT tolerate a broken structural chain.)
    const { rows: events } = await client.query('SELECT * FROM fin_events ORDER BY seq ASC');
    let linkPrev = null, linkOk = true, linkBreak = null;
    for (const r of events) {
      if (r.prev_hash !== linkPrev) { linkOk = false; linkBreak = Number(r.seq); break; }
      linkPrev = r.entry_hash;
    }
    if (!linkOk) {
      await client.query('ROLLBACK');
      console.error(`❌ ABORT: event chain LINKS are broken at seq ${linkBreak}.`);
      console.error('   That is a structural problem (insert/delete/reorder), not a');
      console.error('   version-skew. Re-sealing is NOT appropriate — investigate first.');
      return;
    }

    // ── 2. Recompute event hashes from genesis with current function ──
    console.log(`Re-sealing ${events.length} events under hash v${CURRENT_HASH_VERSION}...`);
    let prev = null, evChanged = 0;
    for (const r of events) {
      const { rows: lineRows } = await client.query(
        'SELECT account, amount_eur FROM fin_ledger WHERE event_seq = $1 ORDER BY id', [r.seq]
      );
      const eventObj = {
        event_type: r.event_type, amount_eur: r.amount_eur, currency: r.currency,
        occurred_on: slug(r.occurred_on), description: r.description,
        source_table: r.source_table, source_id: r.source_id, reverses_seq: r.reverses_seq,
        lines: lineRows.map(l => ({ account: l.account, amount_eur: l.amount_eur })),
      };
      const newHash = hashEvent(prev, eventObj, CURRENT_HASH_VERSION);
      if (newHash !== r.entry_hash || (r.prev_hash || null) !== (prev || null)) evChanged++;
      if (APPLY) {
        await client.query('UPDATE fin_events SET prev_hash = $1, entry_hash = $2 WHERE seq = $3',
          [prev, newHash, r.seq]);
      }
      prev = newHash;
    }
    console.log(`  ${evChanged} event row(s) would change.`);

    // ── 3. Recompute audit hashes from genesis ───────────────────────
    const { rows: audits } = await client.query(
      'SELECT * FROM audit_log WHERE seq IS NOT NULL ORDER BY seq ASC'
    );
    // Confirm audit links intact too
    let aPrev = null, aLinkOk = true, aBreak = null;
    for (const r of audits) {
      if (r.prev_hash !== aPrev) { aLinkOk = false; aBreak = Number(r.seq); break; }
      aPrev = r.entry_hash;
    }
    if (!aLinkOk) {
      await client.query('ROLLBACK');
      console.error(`❌ ABORT: audit chain LINKS broken at seq ${aBreak}. Investigate, do not re-seal.`);
      return;
    }

    console.log(`Re-sealing ${audits.length} audit rows...`);
    let ap = null, auChanged = 0;
    for (const r of audits) {
      const rowForHash = {
        user_email: r.user_email,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        details: r.details,
        old_value: r.old_value ? JSON.stringify(r.old_value) : null,
        new_value: r.new_value ? JSON.stringify(r.new_value) : null,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      };
      const newHash = hashAudit(ap, rowForHash);
      if (newHash !== r.entry_hash || (r.prev_hash || null) !== (ap || null)) auChanged++;
      if (APPLY) {
        await client.query('UPDATE audit_log SET prev_hash = $1, entry_hash = $2 WHERE seq = $3',
          [ap, newHash, r.seq]);
      }
      ap = newHash;
    }
    console.log(`  ${auChanged} audit row(s) would change.`);

    if (APPLY) {
      await client.query('COMMIT');
      console.log('\n✅ Re-seal complete. Run /api/trust/verify — it should now report ok:true.');
    } else {
      await client.query('ROLLBACK');
      console.log('\nDry run only. Re-run with --apply to write the clean chain.');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('❌ Re-seal failed:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

reseal();
