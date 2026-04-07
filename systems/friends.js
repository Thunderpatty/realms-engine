// ═══════════════════════════════════════════════════════════════
// FRIENDS LIST — Add, accept, remove friends. Online status tracking.
// Foundation for party invites and multiplayer.
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');

// Track last-seen timestamps for online status (in-memory, reset on restart)
const lastSeen = new Map(); // charId → Date
const ONLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function register(app, requireAuth, ctx) {
  const { db, q, q1, getChar, addLog, buildState } = ctx;

  function isOnline(charId) {
    const ts = lastSeen.get(charId);
    return ts && (Date.now() - ts.getTime()) < ONLINE_THRESHOLD_MS;
  }

  // Update last-seen on every friends poll
  function touchOnline(charId) {
    lastSeen.set(charId, new Date());
  }

  // ─── FRIENDS LIST ───
  app.get('/api/fantasy/friends', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      touchOnline(char.id);

      // Get all friend relationships involving this character
      const rows = await q(`
        SELECT f.id, f.char_id, f.friend_char_id, f.status, f.created_at,
          c1.name as char_name, c1.class as char_class, c1.level as char_level, c1.location as char_location,
          c2.name as friend_name, c2.class as friend_class, c2.level as friend_level, c2.location as friend_location
        FROM fantasy_friends f
        JOIN fantasy_characters c1 ON c1.id = f.char_id
        JOIN fantasy_characters c2 ON c2.id = f.friend_char_id
        WHERE f.char_id = $1 OR f.friend_char_id = $1
        ORDER BY f.status, f.created_at DESC
      `, [char.id]);

      const friends = [];
      const incoming = [];
      const outgoing = [];

      for (const row of rows) {
        const isRequester = row.char_id === char.id;
        const friendId = isRequester ? row.friend_char_id : row.char_id;
        const friendName = isRequester ? row.friend_name : row.char_name;
        const friendClass = isRequester ? row.friend_class : row.char_class;
        const friendLevel = isRequester ? row.friend_level : row.char_level;
        const friendLocation = isRequester ? row.friend_location : row.char_location;

        const entry = {
          friendshipId: row.id,
          charId: friendId,
          name: friendName,
          class: friendClass,
          level: friendLevel,
          location: friendLocation,
          online: isOnline(friendId),
        };

        if (row.status === 'accepted') {
          friends.push(entry);
        } else if (row.status === 'pending') {
          if (isRequester) {
            outgoing.push(entry);
          } else {
            incoming.push(entry);
          }
        }
      }

      // Sort: online first, then alphabetical
      friends.sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));

      res.json({ ok: true, friends, incoming, outgoing });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load friends.' }); }
  });

  // ─── SEND FRIEND REQUEST ───
  app.post('/api/fantasy/friends/add', requireAuth, validate(schemas.friendAdd), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      const { name } = req.body;
      const target = await q1('SELECT id, name FROM fantasy_characters WHERE LOWER(name) = LOWER($1)', [name.trim()]);
      if (!target) return res.status(400).json({ error: 'Character not found.' });
      if (target.id === char.id) return res.status(400).json({ error: "You can't add yourself." });

      // Check if relationship already exists (in either direction)
      const existing = await q1(
        'SELECT * FROM fantasy_friends WHERE (char_id=$1 AND friend_char_id=$2) OR (char_id=$2 AND friend_char_id=$1)',
        [char.id, target.id]
      );

      if (existing) {
        if (existing.status === 'accepted') return res.status(400).json({ error: `${target.name} is already your friend.` });
        if (existing.status === 'pending' && existing.char_id === char.id) return res.status(400).json({ error: 'Friend request already sent.' });
        if (existing.status === 'pending' && existing.friend_char_id === char.id) {
          // They sent us a request — auto-accept
          await db.query('UPDATE fantasy_friends SET status=$1 WHERE id=$2', ['accepted', existing.id]);
          await addLog(char.id, 'social', `👥 You and ${target.name} are now friends!`);
          return res.json({ ok: true, message: `${target.name} had already sent you a request — you are now friends!` });
        }
        if (existing.status === 'blocked') return res.status(400).json({ error: 'Cannot send request.' });
      }

      await db.query(
        'INSERT INTO fantasy_friends (char_id, friend_char_id, status) VALUES ($1, $2, $3)',
        [char.id, target.id, 'pending']
      );
      await addLog(char.id, 'social', `👥 Sent friend request to ${target.name}.`);

      res.json({ ok: true, message: `Friend request sent to ${target.name}.` });
    } catch (e) {
      if (e.code === '23505') return res.status(400).json({ error: 'Friend request already exists.' });
      console.error(e); res.status(500).json({ error: 'Failed to send request.' });
    }
  });

  // ─── ACCEPT FRIEND REQUEST ───
  app.post('/api/fantasy/friends/accept', requireAuth, validate(schemas.friendAction), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      const { friendshipId } = req.body;
      const row = await q1(
        "SELECT * FROM fantasy_friends WHERE id=$1 AND friend_char_id=$2 AND status='pending'",
        [friendshipId, char.id]
      );
      if (!row) return res.status(400).json({ error: 'No pending request found.' });

      await db.query('UPDATE fantasy_friends SET status=$1 WHERE id=$2', ['accepted', friendshipId]);
      const friend = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [row.char_id]);
      await addLog(char.id, 'social', `👥 You and ${friend?.name || 'someone'} are now friends!`);

      res.json({ ok: true, message: `You are now friends with ${friend?.name || 'them'}!` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to accept.' }); }
  });

  // ─── DECLINE / REMOVE FRIEND ───
  app.post('/api/fantasy/friends/remove', requireAuth, validate(schemas.friendAction), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      const { friendshipId } = req.body;
      const row = await q1(
        'SELECT * FROM fantasy_friends WHERE id=$1 AND (char_id=$2 OR friend_char_id=$2)',
        [friendshipId, char.id]
      );
      if (!row) return res.status(400).json({ error: 'Friendship not found.' });

      const otherId = row.char_id === char.id ? row.friend_char_id : row.char_id;
      const other = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [otherId]);

      await db.query('DELETE FROM fantasy_friends WHERE id=$1', [friendshipId]);

      const action = row.status === 'pending' ? 'declined request from' : 'removed friend';
      await addLog(char.id, 'social', `👥 ${action} ${other?.name || 'someone'}.`);

      res.json({ ok: true, message: row.status === 'pending' ? 'Request declined.' : `Removed ${other?.name || 'friend'}.` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to remove.' }); }
  });

  // Export online tracker for other systems (party invites will use this)
  ctx.friendsOnline = { touchOnline, isOnline, lastSeen };
}

module.exports = { register };
