// ══════════════════════════════════════════════════
// BOOKING CRM ROUTES — /api/booking
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

const STAGES = ['cold','contacted','negotiating','confirmed','completed','rejected'];
const VALID_TYPES = ['venue','festival','private','corporate','wedding','other'];

// GET /api/booking
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { stage, from, to } = req.query;
    const params = [], wheres = [];
    if (stage) { params.push(stage); wheres.push(`stage = $${params.length}`); }
    if (from)  { params.push(from);  wheres.push(`date >= $${params.length}`); }
    if (to)    { params.push(to);    wheres.push(`date <= $${params.length}`); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM booking_contacts ${where} ORDER BY follow_up_date ASC NULLS LAST, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/booking/stats
router.get('/stats', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE stage='cold')        AS cold,
        COUNT(*) FILTER (WHERE stage='contacted')   AS contacted,
        COUNT(*) FILTER (WHERE stage='negotiating') AS negotiating,
        COUNT(*) FILTER (WHERE stage='confirmed')   AS confirmed,
        COUNT(*) FILTER (WHERE stage='completed')   AS completed,
        COUNT(*) FILTER (WHERE stage='rejected')    AS rejected,
        COALESCE(SUM(fee_eur) FILTER (WHERE stage='confirmed'), 0)  AS pipeline_value,
        COALESCE(SUM(fee_eur) FILTER (WHERE stage='completed'), 0)  AS earned_value,
        COUNT(*) FILTER (WHERE follow_up_date <= now() AND stage NOT IN ('completed','rejected')) AS overdue_followups
      FROM booking_contacts
    `);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/booking
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { name, type='venue', location, contact_email, contact_name,
            stage='cold', fee_eur, date, notes, follow_up_date } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'invalid stage' });
    if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'invalid type. Valid: ' + VALID_TYPES.join(', ') });

    const { rows } = await pool.query(
      `INSERT INTO booking_contacts
         (id,name,type,location,contact_email,contact_name,stage,fee_eur,date,notes,follow_up_date,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [uuid(),name,type,location||null,contact_email||null,contact_name||null,
       stage,fee_eur?parseFloat(fee_eur):null,date||null,notes||null,
       follow_up_date||null,req.user.id]
    );
    await writeAudit(req,'BOOKING_ADD',{entityType:'booking',entityId:rows[0].id,details:name});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/booking/:id
router.put('/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { name,type,location,contact_email,contact_name,
            stage,fee_eur,date,notes,follow_up_date,contacted_at } = req.body;
    const { rows } = await pool.query(
      `UPDATE booking_contacts SET
         name=COALESCE($1,name), type=COALESCE($2,type), location=COALESCE($3,location),
         contact_email=COALESCE($4,contact_email), contact_name=COALESCE($5,contact_name),
         stage=COALESCE($6,stage), fee_eur=COALESCE($7,fee_eur), date=COALESCE($8,date),
         notes=COALESCE($9,notes), follow_up_date=COALESCE($10,follow_up_date),
         contacted_at=COALESCE($11,contacted_at), updated_at=now()
       WHERE id=$12 RETURNING *`,
      [name||null,type||null,location||null,contact_email||null,contact_name||null,
       stage||null,fee_eur?parseFloat(fee_eur):null,date||null,notes||null,
       follow_up_date||null,contacted_at||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Contact not found' });
    await writeAudit(req,'BOOKING_UPDATE',{entityType:'booking',entityId:req.params.id,details:`Stage → ${stage}`});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/booking/:id
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM booking_contacts WHERE id=$1 RETURNING id',[req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await writeAudit(req,'BOOKING_DELETE',{entityType:'booking',entityId:req.params.id});
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
