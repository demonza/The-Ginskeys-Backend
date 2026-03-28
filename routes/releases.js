// ══════════════════════════════════════════════════
// RELEASES ROUTES — /api/releases
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

const STAGES = ['idea','recorded','mixed','mastered','artwork','submitted','scheduled','released'];
const TYPES  = ['single','ep','album','live','remix'];

// GET /api/releases
router.get('/', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, array_agg(t.title ORDER BY t.position) FILTER (WHERE t.id IS NOT NULL) AS tracks
       FROM releases r
       LEFT JOIN release_tracks t ON t.release_id = r.id
       GROUP BY r.id ORDER BY r.release_date DESC NULLS LAST, r.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/releases
router.post('/', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { title, type='single', stage='idea', release_date, spotify_url,
            artwork_done=false, video_done=false, press_pitched=false,
            spotify_pitched=false, notes, tracks=[] } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const id = uuid();
    const { rows } = await pool.query(
      `INSERT INTO releases (id,title,type,stage,release_date,spotify_url,artwork_done,
         video_done,press_pitched,spotify_pitched,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id,title,type,stage,release_date||null,spotify_url||null,
       artwork_done,video_done,press_pitched,spotify_pitched,notes||null,req.user.id]
    );

    for (const [i, t] of tracks.entries()) {
      await pool.query(
        `INSERT INTO release_tracks (id,release_id,title,position,duration_sec,isrc)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [uuid(),id,t.title,i+1,t.duration_sec||null,t.isrc||null]
      );
    }

    await writeAudit(req,'RELEASE_ADD',{entityType:'release',entityId:id,details:title});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/releases/:id
router.put('/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { title,type,stage,release_date,spotify_url,artwork_done,
            video_done,press_pitched,spotify_pitched,notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE releases SET
         title=COALESCE($1,title), type=COALESCE($2,type), stage=COALESCE($3,stage),
         release_date=COALESCE($4,release_date), spotify_url=COALESCE($5,spotify_url),
         artwork_done=COALESCE($6,artwork_done), video_done=COALESCE($7,video_done),
         press_pitched=COALESCE($8,press_pitched), spotify_pitched=COALESCE($9,spotify_pitched),
         notes=COALESCE($10,notes), updated_at=now()
       WHERE id=$11 RETURNING *`,
      [title||null,type||null,stage||null,release_date||null,spotify_url||null,
       artwork_done??null,video_done??null,press_pitched??null,spotify_pitched??null,
       notes||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Release not found' });
    await writeAudit(req,'RELEASE_UPDATE',{entityType:'release',entityId:req.params.id});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/releases/:id
router.delete('/:id', requireAuth, requirePerm('deleteTxn'), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM release_tracks WHERE release_id=$1',[req.params.id]);
    const { rows } = await pool.query('DELETE FROM releases WHERE id=$1 RETURNING id',[req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await writeAudit(req,'RELEASE_DELETE',{entityType:'release',entityId:req.params.id});
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
