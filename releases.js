// ══════════════════════════════════════════════════
// TRUST ROUTES — /api/trust
// Read-only integrity surface for the event-sourced ledger.
//   GET /api/trust/verify   — audit chain + event chain + conservation
//   GET /api/trust/balances — derived account balances from ledger lines
//   GET /api/trust/events   — recent events (append-only feed)
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { verifyChain, verifyConservation, accountBalances } = require('../lib/ledger');
const { verifyAuditChain } = require('../middleware/audit');

// Full integrity report. This is the "prove nothing was tampered with" button.
router.get('/verify', requireAuth, async (req, res, next) => {
  try {
    const [audit, events, conservation] = await Promise.all([
      verifyAuditChain(),
      verifyChain(pool),
      verifyConservation(pool),
    ]);
    const ok = audit.ok && events.ok && conservation.ok;
    res.json({
      ok,
      checked_at: new Date().toISOString(),
      audit_chain: audit,
      event_chain: events,
      conservation,
      summary: ok
        ? 'All integrity checks passed — audit history and money ledger are intact.'
        : 'INTEGRITY FAILURE — see individual checks. History or balances have been altered.',
    });
  } catch (err) { next(err); }
});

// Derived balances, straight from the immutable ledger lines.
router.get('/balances', requireAuth, async (req, res, next) => {
  try {
    const balances = await accountBalances(pool);
    // Split into friendly groups for the UI.
    const members = balances.filter(b => b.account.startsWith('member:'))
      .map(b => ({ member_key: b.account.slice(7), balance: Number(b.balance) }));
    const bandCash = Number(balances.find(b => b.account === 'band_cash')?.balance || 0);
    res.json({ band_cash: bandCash, members, raw: balances });
  } catch (err) { next(err); }
});

// Append-only event feed (most recent first).
router.get('/events', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT seq, id, event_type, amount_eur, currency, occurred_on, description,
              source_table, source_id, reverses_seq, created_at, entry_hash
       FROM fin_events ORDER BY seq DESC LIMIT $1`, [limit]
    );
    res.json({ events: rows });
  } catch (err) { next(err); }
});

module.exports = router;
