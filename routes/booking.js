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

    const id = uuid();
    const client = await pool.connect();
    let rows;
    try {
      await client.query('BEGIN');
      const ins = await client.query(
        `INSERT INTO booking_contacts
           (id,name,type,location,contact_email,contact_name,stage,fee_eur,date,notes,follow_up_date,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id,name,type,location||null,contact_email||null,contact_name||null,
         stage,fee_eur?parseFloat(fee_eur):null,date||null,notes||null,
         follow_up_date||null,req.user.id]
      );
      rows = ins.rows;

      // FORECAST ENGINE: record the booking's entry stage so conversion
      // rates can eventually be computed from real history.
      await client.query(
        `INSERT INTO booking_stage_events (booking_id, from_stage, to_stage, fee_eur, created_by)
         VALUES ($1, NULL, $2, $3, $4)`,
        [id, stage, fee_eur ? parseFloat(fee_eur) : null, req.user.id]
      );

      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await writeAudit(req,'BOOKING_ADD',{entityType:'booking',entityId:rows[0].id,details:name});
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// PUT /api/booking/:id
router.put('/:id', requireAuth, requirePerm('addTxn'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { name, type, location, contact_email, contact_name,
            stage, fee_eur, date, notes, follow_up_date, contacted_at } = req.body;

    // Fetch current booking to detect stage transition
    const { rows: current } = await client.query(
      'SELECT * FROM booking_contacts WHERE id = $1', [req.params.id]
    );
    if (!current[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Contact not found' });
    }
    const prev = current[0];

    // Validate stage
    if (stage && !STAGES.includes(stage)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid stage' });
    }

    // Update the booking
    const { rows } = await client.query(
      `UPDATE booking_contacts SET
         name=COALESCE($1,name), type=COALESCE($2,type), location=COALESCE($3,location),
         contact_email=COALESCE($4,contact_email), contact_name=COALESCE($5,contact_name),
         stage=COALESCE($6,stage), fee_eur=COALESCE($7,fee_eur), date=COALESCE($8,date),
         notes=COALESCE($9,notes), follow_up_date=COALESCE($10,follow_up_date),
         contacted_at=COALESCE($11,contacted_at), updated_at=now()
       WHERE id=$12 RETURNING *`,
      [name||null, type||null, location||null, contact_email||null, contact_name||null,
       stage||null, fee_eur ? parseFloat(fee_eur) : null, date||null, notes||null,
       follow_up_date||null, contacted_at||null, req.params.id]
    );
    const booking = rows[0];

    // FORECAST ENGINE: log the transition if the stage actually changed.
    if (stage && stage !== prev.stage) {
      await client.query(
        `INSERT INTO booking_stage_events (booking_id, from_stage, to_stage, fee_eur, created_by)
         VALUES ($1, $2, $3, $4, $5)`,
        [booking.id, prev.stage, stage, booking.fee_eur || null, req.user.id]
      );
    }

    // ── Keep the linked Tour record in sync with the booking lifecycle ──
    //
    // The booking pipeline (cold → … → confirmed → completed / rejected) is the
    // single source of truth. Whenever a booking reaches a "real gig" stage we
    // make sure a Tour row exists, and we ALWAYS mirror the booking's lifecycle
    // onto the tour's status so Tour P&L never shows a finished gig as "planned"
    // or keeps a dead deal alive as a ghost tour.
    const newStage     = stage || prev.stage;
    const wasConfirmed = ['confirmed', 'completed'].includes(prev.stage);
    const nowConfirmed = ['confirmed', 'completed'].includes(newStage);

    // Map a booking stage onto the equivalent tour lifecycle status.
    const tourStatusFor = (s) =>
      s === 'completed' ? 'completed' :
      s === 'rejected'  ? 'cancelled' :
      'planned';
    const desiredTourStatus = tourStatusFor(newStage);

    // Normalise dates to YYYY-MM-DD so a string from the request body never
    // compares unequal to a Date object coming back from Postgres (which used
    // to make every save fire a needless UPDATE).
    const toDateStr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
    const prevDateStr = toDateStr(prev.date);
    const newDateStr  = date ? toDateStr(date) : prevDateStr;

    let tourRow = null;

    if (nowConfirmed && !wasConfirmed && !prev.tour_id) {
      // First transition into a real gig — create the tour.
      const { rows: newTour } = await client.query(
        `INSERT INTO tours (name, start_date, end_date, budget, status, notes)
         VALUES ($1, $2, $2, $3, $4, $5) RETURNING *`,
        [
          booking.name,
          booking.date || null,
          booking.fee_eur || null,
          desiredTourStatus,
          booking.location ? `Location: ${booking.location}` : null,
        ]
      );
      tourRow = newTour[0];

      await client.query(
        'UPDATE booking_contacts SET tour_id = $1 WHERE id = $2',
        [tourRow.id, booking.id]
      );
      booking.tour_id = tourRow.id;

      await writeAudit(req, 'TOUR_AUTO_CREATE', {
        entityType: 'tour',
        entityId: tourRow.id,
        details: `Auto-created from booking: ${booking.name}`,
      });
    } else if (prev.tour_id) {
      // Already linked — sync any changed booking fields AND the lifecycle
      // status onto the tour, even when the booking leaves the confirmed set
      // (e.g. confirmed → rejected should cancel the tour).
      const updateFields = [];
      const updateParams = [];
      let p = 1;

      if (name && name !== prev.name) {
        updateFields.push(`name=$${p++}`); updateParams.push(name);
      }
      if (newDateStr && newDateStr !== prevDateStr) {
        updateFields.push(`start_date=$${p++}`); updateParams.push(newDateStr);
        updateFields.push(`end_date=$${p++}`);   updateParams.push(newDateStr);
      }
      if (fee_eur !== undefined && parseFloat(fee_eur) !== parseFloat(prev.fee_eur || 0)) {
        updateFields.push(`budget=$${p++}`); updateParams.push(parseFloat(fee_eur));
      }
      // Always reconcile status when the stage actually changed.
      if (newStage !== prev.stage) {
        updateFields.push(`status=$${p++}`); updateParams.push(desiredTourStatus);
      }

      if (updateFields.length > 0) {
        updateParams.push(prev.tour_id);
        const { rows: updatedTour } = await client.query(
          `UPDATE tours SET ${updateFields.join(', ')}, updated_at=now()
           WHERE id=$${p} RETURNING *`,
          updateParams
        );
        tourRow = updatedTour[0] || null;
      } else {
        const { rows: existingTour } = await client.query(
          'SELECT * FROM tours WHERE id = $1', [prev.tour_id]
        );
        tourRow = existingTour[0] || null;
      }
    }

    await client.query('COMMIT');

    await writeAudit(req, 'BOOKING_UPDATE', {
      entityType: 'booking',
      entityId: req.params.id,
      details: `Stage → ${newStage}`,
    });

    // Return booking with tour data attached if applicable
    res.json({ ...booking, tour: tourRow || null });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
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
