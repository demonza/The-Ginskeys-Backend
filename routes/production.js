// ══════════════════════════════════════════════════
// LIVE PRODUCTION ROUTES — /api/production
// Tech riders, stage plots, show files, advance sheets
// ══════════════════════════════════════════════════
const router = require('express').Router();
const { v4: uuid } = require('uuid');
const pool   = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const { writeAudit } = require('../middleware/audit');

// ── GET /api/production/shows ──────────────────────
router.get('/shows', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*,
        b.name AS venue_name, b.location AS venue_location,
        b.contact_email AS venue_email
      FROM production_shows s
      LEFT JOIN booking_contacts b ON b.id = s.booking_id
      ORDER BY s.show_date DESC
    `);
    res.json(rows);
  } catch(err) { next(err); }
});

// ── POST /api/production/shows ─────────────────────
router.post('/shows', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { booking_id, show_date, venue_name, venue_address,
            load_in_time, soundcheck_time, doors_time, show_time,
            set_length_min, stage_width_m, stage_depth_m,
            pa_system, console_foh, console_mon, notes } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO production_shows
         (id,booking_id,show_date,venue_name,venue_address,load_in_time,
          soundcheck_time,doors_time,show_time,set_length_min,
          stage_width_m,stage_depth_m,pa_system,console_foh,console_mon,notes,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [uuid(),booking_id||null,show_date,venue_name||null,venue_address||null,
       load_in_time||null,soundcheck_time||null,doors_time||null,show_time||null,
       set_length_min?parseInt(set_length_min):null,
       stage_width_m?parseFloat(stage_width_m):null,
       stage_depth_m?parseFloat(stage_depth_m):null,
       pa_system||null,console_foh||null,console_mon||null,
       notes||null,req.user.id]
    );
    await writeAudit(req,'SHOW_CREATED',{entityType:'show',entityId:rows[0].id,details:show_date});
    res.status(201).json(rows[0]);
  } catch(err) { next(err); }
});

// ── PUT /api/production/shows/:id ─────────────────
router.put('/shows/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const f = req.body;
    const { rows } = await pool.query(
      `UPDATE production_shows SET
         show_date=COALESCE($1,show_date), venue_name=COALESCE($2,venue_name),
         venue_address=COALESCE($3,venue_address), load_in_time=COALESCE($4,load_in_time),
         soundcheck_time=COALESCE($5,soundcheck_time), doors_time=COALESCE($6,doors_time),
         show_time=COALESCE($7,show_time), set_length_min=COALESCE($8,set_length_min),
         stage_width_m=COALESCE($9,stage_width_m), stage_depth_m=COALESCE($10,stage_depth_m),
         pa_system=COALESCE($11,pa_system), console_foh=COALESCE($12,console_foh),
         console_mon=COALESCE($13,console_mon), notes=COALESCE($14,notes), updated_at=now()
       WHERE id=$15 RETURNING *`,
      [f.show_date||null,f.venue_name||null,f.venue_address||null,
       f.load_in_time||null,f.soundcheck_time||null,f.doors_time||null,f.show_time||null,
       f.set_length_min?parseInt(f.set_length_min):null,
       f.stage_width_m?parseFloat(f.stage_width_m):null,
       f.stage_depth_m?parseFloat(f.stage_depth_m):null,
       f.pa_system||null,f.console_foh||null,f.console_mon||null,
       f.notes||null,req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Show not found' });
    res.json(rows[0]);
  } catch(err) { next(err); }
});

// ── GET /api/production/setlists ──────────────────
router.get('/setlists', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { show_id } = req.query;
    const params = [], wheres = [];
    if (show_id) { params.push(show_id); wheres.push(`sl.show_id=$${params.length}`); }
    const where = wheres.length ? 'WHERE '+wheres.join(' AND ') : '';
    const { rows } = await pool.query(
      `SELECT sl.*, array_agg(
         json_build_object('position',si.position,'title',si.title,
           'key',si.musical_key,'bpm',si.bpm,'duration_sec',si.duration_sec,
           'notes',si.notes,'tuning',si.tuning)
         ORDER BY si.position
       ) AS songs
       FROM setlists sl
       LEFT JOIN setlist_items si ON si.setlist_id = sl.id
       ${where}
       GROUP BY sl.id ORDER BY sl.created_at DESC`,
      params
    );
    res.json(rows);
  } catch(err) { next(err); }
});

// ── POST /api/production/setlists ─────────────────
router.post('/setlists', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { show_id, name, songs=[] } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = uuid();
    const { rows } = await pool.query(
      `INSERT INTO setlists (id,show_id,name,created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
      [id,show_id||null,name,req.user.id]
    );
    for (const [i,s] of songs.entries()) {
      await pool.query(
        `INSERT INTO setlist_items (id,setlist_id,position,title,musical_key,bpm,duration_sec,notes,tuning)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [uuid(),id,i+1,s.title,s.key||null,s.bpm?parseInt(s.bpm):null,
         s.duration_sec?parseInt(s.duration_sec):null,s.notes||null,s.tuning||'Standard']
      );
    }
    await writeAudit(req,'SETLIST_CREATED',{entityType:'setlist',entityId:id,details:name});
    res.status(201).json({...rows[0], songs});
  } catch(err) { next(err); }
});

// ── GET /api/production/checklist ─────────────────
router.get('/checklist', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { show_id } = req.query;
    if (!show_id) return res.status(400).json({ error: 'show_id required' });
    const { rows } = await pool.query(
      `SELECT * FROM show_checklist_items WHERE show_id=$1 ORDER BY phase, position`,
      [show_id]
    );
    res.json(rows);
  } catch(err) { next(err); }
});

// ── POST /api/production/checklist/seed ───────────
// Seeds default hard-rock show checklist for a show
router.post('/checklist/seed', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { show_id } = req.body;
    if (!show_id) return res.status(400).json({ error: 'show_id required' });

    // Delete existing
    await pool.query('DELETE FROM show_checklist_items WHERE show_id=$1',[show_id]);

    const DEFAULT_CHECKLIST = [
      // PRE-SHOW — 1 week out
      {phase:'pre_show',position:1,  task:'Send tech rider to venue',                   owner:'Tiago',  due_offset_hours:-168},
      {phase:'pre_show',position:2,  task:'Confirm PA / console availability',           owner:'Tiago',  due_offset_hours:-168},
      {phase:'pre_show',position:3,  task:'Confirm load-in time and parking',            owner:'Tiago',  due_offset_hours:-72},
      {phase:'pre_show',position:4,  task:'Print stage plot (2 copies)',                 owner:'Tiago',  due_offset_hours:-48},
      {phase:'pre_show',position:5,  task:'Prepare setlist — confirm with band',         owner:'All',    due_offset_hours:-48},
      {phase:'pre_show',position:6,  task:'Check all guitar strings (replace if >2 gigs old)', owner:'Fábio', due_offset_hours:-24},
      {phase:'pre_show',position:7,  task:'Check bass strings',                          owner:'Pedro',  due_offset_hours:-24},
      {phase:'pre_show',position:8,  task:'Check drum heads and tune kit',               owner:'Manuel', due_offset_hours:-24},
      {phase:'pre_show',position:9,  task:'Charge all wireless units / IEMs',            owner:'Tiago',  due_offset_hours:-24},
      {phase:'pre_show',position:10, task:'Pack spare strings (guitar + bass)',           owner:'All',    due_offset_hours:-24},
      {phase:'pre_show',position:11, task:'Pack spare 9V batteries (pedals)',             owner:'Fábio',  due_offset_hours:-24},
      {phase:'pre_show',position:12, task:'Pack all XLR + jack cables',                  owner:'Tiago',  due_offset_hours:-24},
      {phase:'pre_show',position:13, task:'Pack gaffer tape, black + silver',             owner:'Tiago',  due_offset_hours:-24},
      {phase:'pre_show',position:14, task:'Confirm transport / fuel',                    owner:'All',    due_offset_hours:-24},
      {phase:'pre_show',position:15, task:'Pack merch if available',                     owner:'Tiago',  due_offset_hours:-24},
      // LOAD-IN
      {phase:'load_in',position:1,   task:'Arrive at venue — introduce to production team', owner:'Tiago', due_offset_hours:0},
      {phase:'load_in',position:2,   task:'Confirm stage dimensions match plot',         owner:'Tiago',  due_offset_hours:0},
      {phase:'load_in',position:3,   task:'Hand stage plot to FOH engineer',             owner:'Tiago',  due_offset_hours:0},
      {phase:'load_in',position:4,   task:'Position drum kit per plot',                  owner:'Manuel', due_offset_hours:0},
      {phase:'load_in',position:5,   task:'Position guitar amp (stage right)',           owner:'Fábio',  due_offset_hours:0},
      {phase:'load_in',position:6,   task:'Position bass amp (stage left)',              owner:'Pedro',  due_offset_hours:0},
      {phase:'load_in',position:7,   task:'Run all jack cables to DIs/amps',             owner:'Tiago',  due_offset_hours:0},
      {phase:'load_in',position:8,   task:'Cable drum kit (kick / snare / toms / OH)',   owner:'Tiago',  due_offset_hours:0},
      {phase:'load_in',position:9,   task:'Gaffer all cables to stage floor',            owner:'All',    due_offset_hours:0},
      {phase:'load_in',position:10,  task:'Confirm monitor positions + mixes needed',    owner:'Tiago',  due_offset_hours:0},
      // SOUNDCHECK
      {phase:'soundcheck',position:1, task:'Line check — all channels to FOH',           owner:'Tiago',  due_offset_hours:0},
      {phase:'soundcheck',position:2, task:'Kick drum check',                            owner:'Manuel', due_offset_hours:0},
      {phase:'soundcheck',position:3, task:'Snare / toms / overheads check',             owner:'Manuel', due_offset_hours:0},
      {phase:'soundcheck',position:4, task:'Bass DI / amp check',                        owner:'Pedro',  due_offset_hours:0},
      {phase:'soundcheck',position:5, task:'Guitar amp check',                           owner:'Fábio',  due_offset_hours:0},
      {phase:'soundcheck',position:6, task:'Vocal mic check — gain / EQ / effects',      owner:'Fábio',  due_offset_hours:0},
      {phase:'soundcheck',position:7, task:'Monitor mixes — each member confirms',       owner:'All',    due_offset_hours:0},
      {phase:'soundcheck',position:8, task:'Full band run — one song',                   owner:'All',    due_offset_hours:0},
      {phase:'soundcheck',position:9, task:'FOH mix tweaks — walk the room',             owner:'Tiago',  due_offset_hours:0},
      {phase:'soundcheck',position:10,'task':'Save FOH scene (if digital console)',      owner:'Tiago',  due_offset_hours:0},
      // SHOW DAY
      {phase:'show_day',position:1,  task:'Back-stage / green room confirmed',           owner:'Tiago',  due_offset_hours:0},
      {phase:'show_day',position:2,  task:'All band members present 30min before show',  owner:'All',    due_offset_hours:0},
      {phase:'show_day',position:3,  task:'Tune all instruments',                        owner:'All',    due_offset_hours:0},
      {phase:'show_day',position:4,  task:'Setlist printed and on stage',                owner:'Tiago',  due_offset_hours:0},
      {phase:'show_day',position:5,  task:'Confirm set length with venue',               owner:'Tiago',  due_offset_hours:0},
      {phase:'show_day',position:6,  task:'Spare guitar on stand (stage right)',         owner:'Fábio',  due_offset_hours:0},
      {phase:'show_day',position:7,  task:'Water on stage — all members',                owner:'Tiago',  due_offset_hours:0},
      {phase:'show_day',position:8,  task:'Cue FOH engineer — 2 min to show',           owner:'Tiago',  due_offset_hours:0},
      // POST-SHOW
      {phase:'post_show',position:1, task:'Collect all cables and personal gear',        owner:'All',    due_offset_hours:0},
      {phase:'post_show',position:2, task:'Return borrowed venue gear',                  owner:'Tiago',  due_offset_hours:0},
      {phase:'post_show',position:3, task:'Collect payment / confirm bank transfer',     owner:'Tiago',  due_offset_hours:0},
      {phase:'post_show',position:4, task:'Sign any required receipts / contracts',      owner:'Tiago',  due_offset_hours:0},
      {phase:'post_show',position:5, task:'Note any gear issues for next gig',           owner:'All',    due_offset_hours:0},
      {phase:'post_show',position:6, task:'Log gig to financial terminal',               owner:'Tiago',  due_offset_hours:0},
      {phase:'post_show',position:7, task:'Post one show photo to social media',         owner:'All',    due_offset_hours:0},
      {phase:'post_show',position:8, task:'Send thank-you to venue (sets up rebook)',    owner:'Tiago',  due_offset_hours:0},
    ];

    for (const item of DEFAULT_CHECKLIST) {
      await pool.query(
        `INSERT INTO show_checklist_items
           (id,show_id,phase,position,task,owner,due_offset_hours,done)
         VALUES ($1,$2,$3,$4,$5,$6,$7,false)`,
        [uuid(),show_id,item.phase,item.position,item.task,item.owner||null,item.due_offset_hours||0]
      );
    }
    res.json({ seeded: DEFAULT_CHECKLIST.length });
  } catch(err) { next(err); }
});

// ── PATCH /api/production/checklist/:id ───────────
router.patch('/checklist/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { done } = req.body;
    const { rows } = await pool.query(
      `UPDATE show_checklist_items SET done=$1, done_at=${done?'now()':'NULL'} WHERE id=$2 RETURNING *`,
      [done, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json(rows[0]);
  } catch(err) { next(err); }
});

// ── GET /api/production/rider ──────────────────────
// ?show_id=UUID — returns all fields for that show (or global if omitted)
router.get('/rider', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { show_id } = req.query;
    let rows;
    if (show_id) {
      // Return show-specific fields, falling back to global defaults where missing
      const result = await pool.query(
        `SELECT COALESCE(s.field_key, g.field_key) AS field_key,
                COALESCE(s.field_value, g.field_value) AS field_value
         FROM tech_rider_fields g
         FULL OUTER JOIN tech_rider_fields s
           ON s.field_key = g.field_key || ':show:' || $1
         WHERE g.show_id IS NULL OR s.show_id = $1`,
        [show_id]
      );
      rows = result.rows;
    } else {
      // Simple: return all fields scoped to no show (global defaults)
      const result = await pool.query(
        `SELECT field_key, field_value FROM tech_rider_fields WHERE show_id IS NULL ORDER BY field_key`
      );
      rows = result.rows;
    }
    const data = {};
    for (const row of rows) data[row.field_key] = row.field_value;
    res.json(data);
  } catch (err) { next(err); }
});

// ── GET /api/production/rider/:show_id ─────────────
// Cleaner per-show fetch
router.get('/rider/:show_id', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const { show_id } = req.params;
    // Get show-specific fields
    const { rows } = await pool.query(
      `SELECT field_key, field_value FROM tech_rider_fields WHERE show_id = $1`,
      [show_id]
    );
    // Also get global defaults
    const { rows: globalRows } = await pool.query(
      `SELECT field_key, field_value FROM tech_rider_fields WHERE show_id IS NULL`
    );
    // Merge: show-specific overrides globals
    const data = {};
    for (const row of globalRows) data[row.field_key] = row.field_value;
    for (const row of rows) data[row.field_key] = row.field_value;
    res.json(data);
  } catch (err) { next(err); }
});

// ── PUT /api/production/rider ──────────────────────
// Body: { field_key, field_value, show_id? }
// show_id = null → saves as global default (template)
// show_id = UUID → saves for that specific show only
router.put('/rider', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  try {
    const { field_key, field_value, show_id = null } = req.body;
    if (!field_key) return res.status(400).json({ error: 'field_key required' });
    await pool.query(
      `INSERT INTO tech_rider_fields (field_key, field_value, show_id, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (field_key, show_id) DO UPDATE
         SET field_value = EXCLUDED.field_value,
             updated_by  = EXCLUDED.updated_by,
             updated_at  = now()`,
      [field_key, field_value ?? '', show_id, req.user.id]
    );
    res.json({ ok: true, field_key, show_id });
  } catch (err) { next(err); }
});

module.exports = router;
