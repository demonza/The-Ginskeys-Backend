// ══════════════════════════════════════════════════
// THE GREEN ROOM — band chat  /api/chat
//
// A lightweight, poll-based group chat for the whole band. Every authenticated
// member can read and post (no extra permission gate — this is the one place
// everyone belongs). Messages can carry a rich "embed" snapshot of something
// elsewhere in the console (a booking, show, release, invoice or tour) so the
// thing being discussed travels with the message.
//
// Transport is simple long-ish polling: the frontend asks for messages `since`
// a cursor every few seconds. That keeps the deploy single-process and avoids a
// websocket dependency on Railway while still feeling live.
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool   = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const EMBED_TYPES = ['booking', 'show', 'release', 'invoice', 'tour', 'document'];
const MAX_BODY    = 4000;
const ALLOWED_REACTIONS = ['🔥', '👍', '🎸', '❤️', '😂', '👀', '✅', '🤘'];

// Touch presence/last_seen for the caller. Best-effort, never blocks a request.
async function touchSeen(userId) {
  if (!userId) return;
  try {
    await pool.query(
      `INSERT INTO chat_reads (user_id, last_seen_at)
       VALUES ($1, now())
       ON CONFLICT (user_id) DO UPDATE SET last_seen_at = now()`,
      [userId]
    );
  } catch (_) { /* presence is non-critical */ }
}

// ─── GET /api/chat ─────────────────────────────────
// ?since=<ISO>  → only messages strictly newer than the cursor (for live poll)
// ?limit=<n>    → cap (default 200, max 500)
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const since = req.query.since ? new Date(req.query.since) : null;

    let rows;
    if (since && !isNaN(since)) {
      ({ rows } = await pool.query(
        `SELECT * FROM chat_messages
         WHERE created_at > $1 AND deleted_at IS NULL
         ORDER BY created_at ASC LIMIT $2`,
        [since.toISOString(), limit]
      ));
    } else {
      // Initial load: newest N, returned in chronological order.
      const r = await pool.query(
        `SELECT * FROM (
           SELECT * FROM chat_messages
           WHERE deleted_at IS NULL
           ORDER BY created_at DESC LIMIT $1
         ) m ORDER BY created_at ASC`,
        [limit]
      );
      rows = r.rows;
    }

    touchSeen(req.user.id);
    res.json({ messages: rows, server_time: new Date().toISOString() });
  } catch (err) { next(err); }
});

// ─── GET /api/chat/state ───────────────────────────
// Unread count + who's been active in the last 5 minutes. Cheap; safe to poll.
router.get('/state', requireAuth, async (req, res, next) => {
  try {
    const { rows: readRows } = await pool.query(
      'SELECT last_read_at FROM chat_reads WHERE user_id = $1', [req.user.id]
    );
    const lastRead = readRows[0]?.last_read_at || new Date(0);

    const { rows: unreadRows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM chat_messages
       WHERE deleted_at IS NULL AND created_at > $1 AND user_id IS DISTINCT FROM $2`,
      [lastRead, req.user.id]
    );

    const { rows: present } = await pool.query(
      `SELECT u.name, u.role
       FROM chat_reads cr JOIN users u ON u.id = cr.user_id
       WHERE cr.last_seen_at > now() - interval '5 minutes'
       ORDER BY u.name`
    );

    touchSeen(req.user.id);
    res.json({ unread: unreadRows[0].n, present });
  } catch (err) { next(err); }
});

// ─── POST /api/chat/read ───────────────────────────
router.post('/read', requireAuth, async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO chat_reads (user_id, last_read_at, last_seen_at)
       VALUES ($1, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET last_read_at = now(), last_seen_at = now()`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── POST /api/chat ────────────────────────────────
router.post('/', requireAuth, async (req, res, next) => {
  try {
    let { body = '', embed_type = null, embed_id = null, embed_data = null } = req.body;
    body = String(body || '').slice(0, MAX_BODY).trim();

    if (embed_type && !EMBED_TYPES.includes(embed_type)) {
      return res.status(400).json({ error: 'invalid embed_type' });
    }
    // A message must say something OR carry an embed.
    if (!body && !embed_type) {
      return res.status(400).json({ error: 'message is empty' });
    }

    const { rows } = await pool.query(
      `INSERT INTO chat_messages
         (user_id, user_name, user_role, body, embed_type, embed_id, embed_data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        req.user.id,
        req.user.name || req.user.email || 'Member',
        req.user.role || null,
        body,
        embed_type,
        embed_id ? String(embed_id) : null,
        embed_data ? JSON.stringify(embed_data) : null,
      ]
    );

    // Posting counts as reading everything up to now.
    await pool.query(
      `INSERT INTO chat_reads (user_id, last_read_at, last_seen_at)
       VALUES ($1, now(), now())
       ON CONFLICT (user_id) DO UPDATE SET last_read_at = now(), last_seen_at = now()`,
      [req.user.id]
    );

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// ─── POST /api/chat/:id/react ──────────────────────
// Toggles the caller's reaction. Body: { emoji }
router.post('/:id/react', requireAuth, async (req, res, next) => {
  const client = await pool.connect();
  try {
    const emoji = String(req.body.emoji || '');
    if (!ALLOWED_REACTIONS.includes(emoji)) {
      return res.status(400).json({ error: 'unsupported reaction' });
    }
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT reactions FROM chat_messages WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [req.params.id]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'message not found' }); }

    const reactions = rows[0].reactions || {};
    const uid = req.user.id;
    const list = new Set(reactions[emoji] || []);
    if (list.has(uid)) list.delete(uid); else list.add(uid);
    if (list.size) reactions[emoji] = [...list]; else delete reactions[emoji];

    const { rows: upd } = await client.query(
      'UPDATE chat_messages SET reactions = $1 WHERE id = $2 RETURNING *',
      [JSON.stringify(reactions), req.params.id]
    );
    await client.query('COMMIT');
    res.json(upd[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ─── POST /api/chat/:id/pin ────────────────────────
router.post('/:id/pin', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE chat_messages SET pinned = NOT pinned
       WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /api/chat/:id ──────────────────────────
// Soft-delete. Author can delete their own; admin/co-admin can delete any.
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT user_id FROM chat_messages WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'message not found' });
    const isOwner = rows[0].user_id === req.user.id;
    const isAdmin = ['admin', 'co-admin'].includes(req.user.role);
    if (!isOwner && !isAdmin) return res.status(403).json({ error: 'not allowed' });

    await pool.query('UPDATE chat_messages SET deleted_at = now() WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
