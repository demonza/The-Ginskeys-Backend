// ══════════════════════════════════════════════════
// PRESS & SYNC ROUTES — /api/press
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

const TYPES   = ['press','radio','blog','sync','playlist','podcast','tv','other'];
const STAGES  = ['target','pitched','following_up','responded','published','rejected'];

// GET /api/press
router.get('/', requireAuth, requirePerm(['viewLedger','viewPress']), async (req, res, next) => {
  try {
    const { type, stage } = req.query;
    const params=[], wheres=[];
    if (type)  { params.push(type);  wheres.push(`type=$${params.length}`); }
    if (stage) { params.push(stage); wheres.push(`stage=$${params.length}`); }
    const where = wheres.length ? 'WHERE '+wheres.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT * FROM press_contacts ${where} ORDER BY follow_up_date ASC NULLS LAST, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/press
router.post('/', requireAuth, requirePerm(['addTxn','viewPress']), async (req, res, next) => {
  try {
    const { outlet, type='press', contact_name, contact_email, country='PT',
            stage='target', pitched_release, notes, follow_up_date,
            estimated_value_eur } = req.body;
    if (!outlet) return res.status(400).json({ error: 'outlet required' });

    const { rows } = await pool.query(
      `INSERT INTO press_contacts
         (id,outlet,type,contact_name,contact_email,country,stage,
          pitched_release,notes,follow_up_date,estimated_value_eur,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [uuid(),outlet,type,contact_name||null,contact_email||null,country,stage,
       pitched_release||null,notes||null,follow_up_date||null,
       estimated_value_eur?parseFloat(estimated_value_eur):null,req.user.id]
    );
    await writeAudit(req,'PRESS_ADD',{entityType:'press',entityId:rows[0].id,details:outlet});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/press/:id
router.put('/:id', requireAuth, requirePerm(['addTxn','viewPress']), async (req, res, next) => {
  try {
    const { outlet,type,contact_name,contact_email,country,stage,
            pitched_release,notes,follow_up_date,estimated_value_eur,published_url } = req.body;
    const { rows } = await pool.query(
      `UPDATE press_contacts SET
         outlet=COALESCE($1,outlet), type=COALESCE($2,type),
         contact_name=COALESCE($3,contact_name), contact_email=COALESCE($4,contact_email),
         country=COALESCE($5,country), stage=COALESCE($6,stage),
         pitched_release=COALESCE($7,pitched_release), notes=COALESCE($8,notes),
         follow_up_date=COALESCE($9,follow_up_date),
         estimated_value_eur=COALESCE($10,estimated_value_eur),
         published_url=COALESCE($11,published_url), updated_at=now()
       WHERE id=$12 RETURNING *`,
      [outlet||null,type||null,contact_name||null,contact_email||null,country||null,
       stage||null,pitched_release||null,notes||null,follow_up_date||null,
       estimated_value_eur?parseFloat(estimated_value_eur):null,
       published_url||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await writeAudit(req,'PRESS_UPDATE',{entityType:'press',entityId:req.params.id});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/press/:id
router.delete('/:id', requireAuth, requirePerm(['deleteTxn','viewPress']), async (req, res, next) => {
  try {
    const { rows } = await pool.query('DELETE FROM press_contacts WHERE id=$1 RETURNING id',[req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await writeAudit(req,'PRESS_DELETE',{entityType:'press',entityId:req.params.id});
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
