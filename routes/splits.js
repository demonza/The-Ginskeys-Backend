// ══════════════════════════════════════════════════
// GIG SPLITS ROUTES — /api/splits
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

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
    const totalExpenses = shared_expenses.reduce((s,e)=>s+parseFloat(e.amount||0), 0);
    const bandFund = parseFloat((grossNum * (parseFloat(band_fund_pct)/100)).toFixed(2));
    const distributable = parseFloat((grossNum - totalExpenses - bandFund).toFixed(2));
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

module.exports = router;
// ── GET /api/splits/member-accounts ───────────────────────
// Returns balance per member + recent transactions
router.get('/member-accounts', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    // Get balances
    const { rows: balances } = await pool.query(`
      SELECT member_key, member_name,
        COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE 0 END), 0) AS total_in,
        COALESCE(SUM(CASE WHEN txn_type = 'withdrawal' THEN amount ELSE 0 END), 0) AS total_out,
        COALESCE(SUM(CASE WHEN txn_type IN ('split_credit','deposit') THEN amount ELSE -amount END), 0) AS balance
      FROM member_account_txns
      GROUP BY member_key, member_name
      ORDER BY member_key
    `);

    // Get recent transactions (last 50)
    const { rows: txns } = await pool.query(`
      SELECT * FROM member_account_txns
      ORDER BY txn_date DESC, created_at DESC
      LIMIT 50
    `);

    res.json({ balances, txns });
  } catch (err) { next(err); }
});

// ── POST /api/splits/member-accounts/txn ──────────────────
router.post('/member-accounts/txn', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { member_key, member_name, amount, txn_type, description, txn_date, split_id } = req.body;
    if (!member_key || !amount || !txn_type) return res.status(400).json({ error: 'member_key, amount, txn_type required' });
    const { rows } = await pool.query(`
      INSERT INTO member_account_txns
        (member_key, member_name, amount, txn_type, description, txn_date, split_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [member_key, member_name || member_key, Math.abs(parseFloat(amount)),
       txn_type, description || null, txn_date || new Date().toISOString().split('T')[0],
       split_id || null, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
