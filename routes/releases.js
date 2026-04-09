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

// ── Auto-ensure social_media column exists ──────────
// Runs once on first request, creates the column if missing.
// This replaces the need to manually run migrate_v5.
let _socialMediaColReady = false;

async function ensureSocialMediaColumn() {
  if (_socialMediaColReady) return;
  try {
    const { rows } = await pool.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'releases' AND column_name = 'social_media'
    `);
    if (rows.length === 0) {
      await pool.query(`ALTER TABLE releases ADD COLUMN social_media BOOLEAN NOT NULL DEFAULT false`);
      console.log('✅ Auto-created releases.social_media column');
    }
    _socialMediaColReady = true;
  } catch (err) {
    console.error('Failed to ensure social_media column:', err.message);
    // Don't cache the failure — try again next request
  }
}

// GET /api/releases
router.get('/', requireAuth, requirePerm(["viewLedger","viewReleases"]), async (req, res, next) => {
  try {
    await ensureSocialMediaColumn();
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
router.post('/', requireAuth, requirePerm(['addTxn','viewReleases']), async (req, res, next) => {
  try {
    await ensureSocialMediaColumn();
    const { title, type='single', stage='idea', release_date, spotify_url,
            artwork_done=false, video_done=false, press_pitched=false,
            spotify_pitched=false, social_media=false, notes, tracks=[] } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    if (!TYPES.includes(type)) return res.status(400).json({ error: 'invalid type. Valid: ' + TYPES.join(', ') });
    if (!STAGES.includes(stage)) return res.status(400).json({ error: 'invalid stage. Valid: ' + STAGES.join(', ') });

    const id = uuid();
    const { rows } = await pool.query(
      `INSERT INTO releases (id,title,type,stage,release_date,spotify_url,artwork_done,
         video_done,press_pitched,spotify_pitched,social_media,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, title, type, stage, release_date||null, spotify_url||null,
       !!artwork_done, !!video_done, !!press_pitched, !!spotify_pitched,
       !!social_media, notes||null, req.user.id]
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
router.put('/:id', requireAuth, requirePerm(['addTxn','viewReleases']), async (req, res, next) => {
  try {
    await ensureSocialMediaColumn();
    const { title, type, stage, release_date, spotify_url, artwork_done,
            video_done, press_pitched, spotify_pitched, social_media, notes } = req.body;

    function boolParam(val) {
      return val === undefined ? null : !!val;
    }

    const { rows } = await pool.query(
      `UPDATE releases SET
         title=COALESCE($1,title), type=COALESCE($2,type), stage=COALESCE($3,stage),
         release_date=COALESCE($4,release_date), spotify_url=COALESCE($5,spotify_url),
         artwork_done=COALESCE($6,artwork_done), video_done=COALESCE($7,video_done),
         press_pitched=COALESCE($8,press_pitched), spotify_pitched=COALESCE($9,spotify_pitched),
         social_media=COALESCE($10,social_media),
         notes=COALESCE($11,notes), updated_at=now()
       WHERE id=$12 RETURNING *`,
      [title||null, type||null, stage||null, release_date||null, spotify_url||null,
       boolParam(artwork_done), boolParam(video_done),
       boolParam(press_pitched), boolParam(spotify_pitched),
       boolParam(social_media), notes||null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Release not found' });
    await writeAudit(req,'RELEASE_UPDATE',{entityType:'release',entityId:req.params.id});
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/releases/:id
router.delete('/:id', requireAuth, requirePerm(['deleteTxn','viewReleases']), async (req, res, next) => {
  try {
    await pool.query('DELETE FROM release_tracks WHERE release_id=$1',[req.params.id]);
    const { rows } = await pool.query('DELETE FROM releases WHERE id=$1 RETURNING id',[req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    await writeAudit(req,'RELEASE_DELETE',{entityType:'release',entityId:req.params.id});
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
