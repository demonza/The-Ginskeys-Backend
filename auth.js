// ══════════════════════════════════════════════════════════════════
// TRUST ENGINE — lib/ledger.js
//
// The honest, blockchain-free version of an "immutable ledger":
//   • append-only event store, each event hash-sealing the previous one
//   • double-entry expansion so every movement is balanced by construction
//   • a verifier that proves the chain is intact AND balances reconcile
//
// Nothing here mutates the classic tables. Call appendEvent() alongside
// your existing writes (in the same DB transaction) and the event store
// becomes a parallel, verifiable source of truth.
// ══════════════════════════════════════════════════════════════════
const crypto = require('crypto');

// ── HASH VERSIONING ───────────────────────────────────────────────
// The canonical form below defines how an event is hashed. If it EVER
// changes, bump CURRENT_HASH_VERSION and add the OLD canonical form to
// LEGACY_CANONICALS. The verifier then tries the current form first and
// falls back to legacy forms — so a code change can never again silently
// "break" an intact chain (the bug that bit us on 2026-07-07).
const CURRENT_HASH_VERSION = 2;

// Build the canonical JSON string for a given version.
function canonicalForVersion(version, e) {
  const lines = (e.lines || []).map(l => ({ account: l.account, amount_eur: Number(l.amount_eur).toFixed(2) }));
  if (version === 1) {
    // v1: the original shape (no version field). Kept so legacy rows verify.
    return JSON.stringify({
      event_type:  e.event_type,
      amount_eur:  Number(e.amount_eur).toFixed(2),
      currency:    e.currency || 'EUR',
      occurred_on: String(e.occurred_on),
      description: e.description || '',
      source_table: e.source_table || null,
      source_id:   e.source_id != null ? String(e.source_id) : null,
      reverses_seq: e.reverses_seq || null,
      lines,
    });
  }
  // v2 (current): identical fields plus an explicit version tag, so the
  // hashed content itself records which rule sealed it.
  return JSON.stringify({
    v: 2,
    event_type:  e.event_type,
    amount_eur:  Number(e.amount_eur).toFixed(2),
    currency:    e.currency || 'EUR',
    occurred_on: String(e.occurred_on),
    description: e.description || '',
    source_table: e.source_table || null,
    source_id:   e.source_id != null ? String(e.source_id) : null,
    reverses_seq: e.reverses_seq || null,
    lines,
  });
}

// Deterministic hash of an event's meaningful fields + the previous hash.
// Any later edit to a sealed field changes this hash, breaking the chain.
function hashEvent(prevHash, e, version = CURRENT_HASH_VERSION) {
  const canonical = canonicalForVersion(version, e);
  return crypto.createHash('sha256').update((prevHash || 'GENESIS') + canonical).digest('hex');
}

// Try current + all known legacy versions; return the version that matches
// the stored hash, or null if none do (genuine mismatch / tampering).
const KNOWN_VERSIONS = [2, 1];
function matchHashVersion(prevHash, e, storedHash) {
  for (const v of KNOWN_VERSIONS) {
    if (hashEvent(prevHash, e, v) === storedHash) return v;
  }
  return null;
}


// Expand a high-level event into balanced double-entry lines.
// Convention: +amount = money INTO that account, -amount = money OUT.
// Every event's lines MUST sum to zero (conservation of money).
function expandLines(e) {
  const amt = Number(Number(e.amount_eur).toFixed(2));
  switch (e.event_type) {
    case 'revenue_received':      // outside world → band cash
      return [
        { account: 'external',  amount_eur: -amt },
        { account: 'band_cash', amount_eur: +amt },
      ];
    case 'expense_paid':          // band cash → outside world
      return [
        { account: 'band_cash', amount_eur: -amt },
        { account: 'external',  amount_eur: +amt },
      ];
    case 'treasury_allocated': {  // band cash → a member/fund wallet
      const to = e.metadata?.account || ('member:' + (e.metadata?.member_key || 'unknown'));
      return [
        { account: 'band_cash', amount_eur: -amt },
        { account: to,          amount_eur: +amt },
      ];
    }
    case 'member_deposit': {      // outside world → member wallet
      const to = 'member:' + (e.metadata?.member_key || 'unknown');
      return [
        { account: 'external', amount_eur: -amt },
        { account: to,         amount_eur: +amt },
      ];
    }
    case 'member_withdrawal': {   // member wallet → outside world
      const from = 'member:' + (e.metadata?.member_key || 'unknown');
      return [
        { account: from,       amount_eur: -amt },
        { account: 'external', amount_eur: +amt },
      ];
    }
    case 'reversal': {
      // A reversal mirrors the lines of the event it reverses (provided in metadata.lines).
      const orig = e.metadata?.lines || [];
      return orig.map(l => ({ account: l.account, amount_eur: -Number(l.amount_eur) }));
    }
    case 'adjustment': {
      // Free-form but still balanced: caller supplies explicit lines.
      return e.metadata?.lines || [];
    }
    default:
      throw new Error('Unknown event_type: ' + e.event_type);
  }
}

// Append an event + its ledger lines inside an existing transaction (client).
// Locks the chain tail so concurrent appends can't fork the hash chain.
async function appendEvent(client, e, userId = null) {
  // Lock the latest event row to serialise appends (advisory lock keyed to the chain).
  await client.query('SELECT pg_advisory_xact_lock($1)', [7423190]); // arbitrary constant = "fin chain"

  const { rows: [tail] } = await client.query(
    'SELECT entry_hash FROM fin_events ORDER BY seq DESC LIMIT 1'
  );
  const prevHash = tail?.entry_hash || null;

  const lines = expandLines(e);
  // Balance check: money is conserved.
  const sum = lines.reduce((s, l) => s + Number(l.amount_eur), 0);
  if (Math.abs(sum) > 0.001) {
    throw new Error(`Unbalanced event (lines sum to ${sum.toFixed(2)}, must be 0)`);
  }

  const entryHash = hashEvent(prevHash, { ...e, lines });

  const { rows: [ev] } = await client.query(
    `INSERT INTO fin_events
       (event_type, amount_eur, currency, occurred_on, description,
        source_table, source_id, reverses_seq, metadata, prev_hash, entry_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING seq, id`,
    [e.event_type, Number(e.amount_eur).toFixed(2), e.currency || 'EUR', e.occurred_on,
     e.description || '', e.source_table || null,
     e.source_id != null ? String(e.source_id) : null,
     e.reverses_seq || null, JSON.stringify(e.metadata || {}),
     prevHash, entryHash, userId]
  );

  for (const l of lines) {
    await client.query(
      `INSERT INTO fin_ledger (event_seq, account, amount_eur, occurred_on)
       VALUES ($1,$2,$3,$4)`,
      [ev.seq, l.account, Number(l.amount_eur).toFixed(2), e.occurred_on]
    );
  }
  return { seq: ev.seq, id: ev.id, entry_hash: entryHash, lines };
}

// Recompute the whole chain and confirm every stored hash matches.
// Returns { ok, count, brokenAt } — brokenAt is the seq of the first bad row.
async function verifyChain(pool) {
  const { rows } = await pool.query('SELECT * FROM fin_events ORDER BY seq ASC');
  let prev = null;
  for (const r of rows) {
    const { rows: lineRows } = await pool.query(
      'SELECT account, amount_eur FROM fin_ledger WHERE event_seq = $1 ORDER BY id', [r.seq]
    );
    const eventObj = {
      event_type: r.event_type, amount_eur: r.amount_eur, currency: r.currency,
      occurred_on: r.occurred_on instanceof Date ? r.occurred_on.toISOString().slice(0,10) : r.occurred_on,
      description: r.description, source_table: r.source_table, source_id: r.source_id,
      reverses_seq: r.reverses_seq,
      lines: lineRows.map(l => ({ account: l.account, amount_eur: l.amount_eur })),
    };
    // The prev_hash link must be intact, AND the stored entry_hash must match
    // under SOME known hash version (current or legacy).
    const matchedVersion = matchHashVersion(prev, eventObj, r.entry_hash);
    if (r.prev_hash !== prev || matchedVersion === null) {
      return { ok: false, count: rows.length, brokenAt: Number(r.seq) };
    }
    prev = r.entry_hash;
  }
  return { ok: true, count: rows.length, brokenAt: null };
}

// Derived balances per account, straight from the ledger lines.
async function accountBalances(pool) {
  const { rows } = await pool.query(
    `SELECT account, COALESCE(SUM(amount_eur),0)::numeric(14,2) AS balance
     FROM fin_ledger GROUP BY account ORDER BY account`
  );
  return rows;
}

// Global invariant: every event balanced ⇒ the sum of ALL ledger lines is 0.
// If it isn't, an event was written unbalanced (should be impossible via appendEvent).
async function verifyConservation(pool) {
  const { rows: [{ total }] } = await pool.query(
    'SELECT COALESCE(SUM(amount_eur),0)::numeric(14,2) AS total FROM fin_ledger'
  );
  return { ok: Math.abs(Number(total)) < 0.001, total: Number(total) };
}

module.exports = {
  hashEvent, expandLines, appendEvent,
  verifyChain, accountBalances, verifyConservation,
  matchHashVersion, CURRENT_HASH_VERSION,
};
