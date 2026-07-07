// ══════════════════════════════════════════════════
// GIG SPLITS ROUTES — /api/splits
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');
const { appendEvent } = require('../lib/ledger');

// ── GET /api/splits/member-accounts ───────────────────────
// FIX: moved BEFORE '/:id' style routes to prevent Express matching
// 'member-accounts' as a :id parameter
router.get('/member-accounts', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    // Check if the table exists at all
    const tableCheck = await pool.query(`
      SELECT 1 FROM information_schema.tables
      WHERE table_name = 'member_account_txns'
    `);
    if (tableCheck.rows.length === 0) {
      const { rows: totals } = await pool.query(
        `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_eur ELSE -amount_eur END), 0) AS total_balance FROM transactions`
      );
      return res.json({ balances: [], txns: [], total_balance: parseFloat(totals[0].total_balance) });
    }

    // Check if ledger_txn_id column exists (migrate_v5)
    const colCheck = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'member_account_txns' AND column_name = 'ledger_txn_id'
    `);
    const hasLedgerCol = colCheck.rows.length > 0;

    // Get balances
    const { rows: balances } = await pool.query(`
      SELECT
        member_key,
        (array_agg(member_name ORDER BY created_at DESC))[1] AS member_name,
        COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN txn_type = 'withdrawal' THEN amount ELSE 0 END), 0) AS total_out,
        COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE -amount END), 0) AS balance
      FROM member_account_txns
      GROUP BY member_key
      ORDER BY member_key
    `);

    let txns = [];
    if (hasLedgerCol) {
      const { rows } = await pool.query(`
        SELECT m.*,
          t.description AS ledger_description,
          t.date        AS ledger_date
        FROM member_account_txns m
        LEFT JOIN transactions t ON t.id = m.ledger_txn_id
        ORDER BY m.txn_date DESC, m.created_at DESC
        LIMIT 100
      `);
      txns = rows;
    } else {
      const { rows } = await pool.query(`
        SELECT * FROM member_account_txns
        ORDER BY txn_date DESC, created_at DESC
        LIMIT 100
      `);
      txns = rows;
    }

    const { rows: totals } = await pool.query(`
      SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount_eur ELSE -amount_eur END), 0) AS total_balance
      FROM transactions
    `);

    res.json({ balances, txns, total_balance: parseFloat(totals[0].total_balance) });
  } catch (err) { next(err); }
});

// ── POST /api/splits/member-accounts/txn ──────────────────
router.post('/member-accounts/txn', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { member_key, member_name, amount, txn_type, description, txn_date, split_id, ledger_txn_id } = req.body;
    if (!member_key || !amount || !txn_type) return res.status(400).json({ error: 'member_key, amount, txn_type required' });

    // FIX: validate txn_type
    if (!['split_credit', 'withdrawal', 'deposit'].includes(txn_type))
      return res.status(400).json({ error: 'txn_type must be split_credit, withdrawal, or deposit' });

    const amt = Math.abs(parseFloat(amount));
    // FIX: validate amount
    if (!isFinite(amt) || amt <= 0)
      return res.status(400).json({ error: 'amount must be a positive number' });

    const date = txn_date || new Date().toISOString().split('T')[0];
    const desc = description || null;

    // GUARD: if this member movement mirrors an existing ledger transaction,
    // the direction must be consistent — an 'expense' ledger txn can only pair
    // with a 'withdrawal', and an 'income' ledger txn with a 'deposit' or
    // 'split_credit'. This prevents the class of bug where income was mirrored
    // as a withdrawal and silently drained a member's wallet.
    if (ledger_txn_id) {
      const { rows: [ledgerTxn] } = await client.query(
        'SELECT type FROM transactions WHERE id = $1', [ledger_txn_id]
      );
      if (!ledgerTxn) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'ledger_txn_id does not reference an existing transaction' });
      }
      const expected = ledgerTxn.type === 'expense' ? ['withdrawal'] : ['deposit', 'split_credit'];
      if (!expected.includes(txn_type)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Direction mismatch: ledger transaction is '${ledgerTxn.type}' but member txn_type is '${txn_type}'. ` +
                 `Expected: ${expected.join(' or ')}.`
        });
      }
    }

    // Check if ledger_txn_id column exists
    const colChk = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'member_account_txns' AND column_name = 'ledger_txn_id'
    `);
    const hasLedgerCol = colChk.rows.length > 0;

    let rows;
    if (hasLedgerCol) {
      const result = await client.query(`
        INSERT INTO member_account_txns
          (member_key, member_name, amount, txn_type, description, txn_date, split_id, ledger_txn_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [member_key, member_name || member_key, amt, txn_type, desc, date,
         split_id || null, ledger_txn_id || null, req.user.id]
      );
      rows = result.rows;
    } else {
      const result = await client.query(`
        INSERT INTO member_account_txns
          (member_key, member_name, amount, txn_type, description, txn_date, split_id, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [member_key, member_name || member_key, amt, txn_type, desc, date,
         split_id || null, req.user.id]
      );
      rows = result.rows;
    }

    // Mirror to main ledger for non-split transactions
    let newLedgerTxnId = ledger_txn_id || null;
    if (!split_id && !ledger_txn_id && txn_type !== 'split_credit') {
      let catId = null;
      const catRes = await client.query(
        `SELECT id FROM categories WHERE name = 'Divisão de Cachets' LIMIT 1`
      );
      if (catRes.rows[0]) {
        catId = catRes.rows[0].id;
      } else {
        const newCat = await client.query(
          `INSERT INTO categories (id, name, type) VALUES (gen_random_uuid(), 'Divisão de Cachets', 'expense') RETURNING id`
        );
        catId = newCat.rows[0].id;
      }

      // FIX: withdrawal amount should be stored as positive in transactions
      // (the type field indicates income/expense, not the sign)
      const ledgerRes = await client.query(`
        INSERT INTO transactions
          (id, date, type, amount, amount_eur, currency, description, source_dest, category_id, notes, created_by)
        VALUES (gen_random_uuid(), $1, $2, $3, $3, 'EUR', $4, $5, $6, $7, $8)
        RETURNING id`,
        [date,
         txn_type === 'withdrawal' ? 'expense' : 'income',
         amt,  // FIX: always positive — was using -amt for withdrawals, causing negative amounts in DB
         desc || (txn_type === 'withdrawal' ? 'Levantamento — ' : 'Depósito — ') + (member_name || member_key),
         member_name || member_key,
         catId,
         'member_account:' + member_key,
         req.user.id]
      );
      newLedgerTxnId = ledgerRes.rows[0].id;

      if (hasLedgerCol) {
        await client.query(
          `UPDATE member_account_txns SET ledger_txn_id = $1 WHERE id = $2`,
          [newLedgerTxnId, rows[0].id]
        );
      }
    }

    // ── TRUST ENGINE ─────────────────────────────────────────────
    // Mirror this movement into the append-only event store (same txn).
    // split_credit / deposit → money INTO the member wallet.
    // withdrawal            → money OUT of the member wallet.
    try {
      const evType = txn_type === 'withdrawal' ? 'member_withdrawal'
                   : txn_type === 'split_credit' ? 'treasury_allocated'
                   : 'member_deposit';
      await appendEvent(client, {
        event_type: evType,
        amount_eur: amt,
        occurred_on: date,
        description: desc || (member_name || member_key),
        source_table: 'member_account_txns',
        source_id: rows[0].id,
        metadata: { member_key, account: 'member:' + member_key },
      }, req.user.id);
    } catch (evErr) {
      // A failed event mirror MUST fail the whole operation — otherwise the
      // event store silently drifts from reality, which defeats its purpose.
      await client.query('ROLLBACK');
      return next(new Error('Trust-ledger write failed: ' + evErr.message));
    }

    await client.query('COMMIT');
    res.status(201).json({ ...rows[0], ledger_txn_id: newLedgerTxnId });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// GET /api/splits — list all gig splits
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, array_agg(
         json_build_object('member',m.member_name,'base',m.base_share,'expenses',m.expenses_eur,'net',m.net_eur)
         ORDER BY m.member_name
       ) AS members
       FROM gig_splits s
       LEFT JOIN gig_split_members m ON m.split_id = s.id
       GROUP BY s.id ORDER BY s.gig_date DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/splits — create a gig split calculation
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { gig_name, gig_date, gross_eur, band_fund_pct=10,
            shared_expenses=[], members=[] } = req.body;
    if (!gig_name || !gross_eur) return res.status(400).json({ error: 'gig_name and gross_eur required' });

    const grossNum = parseFloat(gross_eur);
    // FIX: validate gross_eur
    if (!isFinite(grossNum) || grossNum <= 0)
      return res.status(400).json({ error: 'gross_eur must be a positive number' });

    const fundPct = parseFloat(band_fund_pct);
    // FIX: validate band_fund_pct range
    if (!isFinite(fundPct) || fundPct < 0 || fundPct > 100)
      return res.status(400).json({ error: 'band_fund_pct must be between 0 and 100' });

    const totalExpenses = shared_expenses.reduce((s,e)=>s+parseFloat(e.amount||0), 0);
    const bandFund = parseFloat((grossNum * (fundPct/100)).toFixed(2));
    const distributable = parseFloat((grossNum - totalExpenses - bandFund).toFixed(2));

    // FIX: check for negative distributable
    if (distributable < 0)
      return res.status(400).json({ error: 'Expenses + band fund exceed gross amount' });

    const perMember = members.length > 0
      ? parseFloat((distributable / members.length).toFixed(2))
      : distributable;

    const id = uuid();
    const { rows } = await pool.query(
      `INSERT INTO gig_splits
         (id,gig_name,gig_date,gross_eur,total_expenses_eur,band_fund_eur,distributable_eur,
          member_count,per_member_eur,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [id,gig_name,gig_date||null,grossNum,totalExpenses,bandFund,distributable,
       members.length,perMember,req.body.notes||null,req.user.id]
    );

    for (const m of members) {
      const memberExpenses = parseFloat(m.personal_expenses||0);
      const net = parseFloat((perMember - memberExpenses).toFixed(2));
      await pool.query(
        `INSERT INTO gig_split_members (id,split_id,member_name,base_share,expenses_eur,net_eur)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuid(),id,m.name,perMember,memberExpenses,net]
      );
    }

    await writeAudit(req,'SPLIT_CALC',{entityType:'split',entityId:id,details:`${gig_name} — €${grossNum}`});
    res.status(201).json({...rows[0], per_member_eur: perMember, band_fund_eur: bandFund });
  } catch (err) { next(err); }
});

// DELETE /api/splits/:id
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM gig_split_members WHERE split_id=$1',[req.params.id]);
    const { rows } = await pool.query('DELETE FROM gig_splits WHERE id=$1 RETURNING id',[req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

// FIX: single module.exports at the end (was exported twice in original, causing
// the member-accounts routes to be silently dropped)
module.exports = router;
