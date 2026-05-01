'use strict';
// ═══════════════════════════════════════════════════════════════
// SSE (Server-Sent Events) — Real-time party/raid state push
// Character-keyed connections: all authenticated players connect,
// party updates push to members, invites push to individuals
// Uses PostgreSQL LISTEN/NOTIFY as the event bus
// ═══════════════════════════════════════════════════════════════

const { getListenClient } = require('../postgres-runtime');

const CHANNEL = 'party_events';
const HEARTBEAT_MS = 30000;

function register(app, requireAuth, ctx) {
  const { db, q, q1, getChar } = ctx;

  // ── Connection Map: charId -> {res, partyId} ──
  const connections = new Map();
  let listenClient = null;
  let heartbeatTimer = null;

  // ── PG LISTEN setup ──
  async function startListening() {
    try {
      listenClient = await getListenClient();
      await listenClient.query(`LISTEN ${CHANNEL}`);
      console.log(`[sse] Listening on PG channel: ${CHANNEL}`);

      listenClient.on('notification', (msg) => {
        try {
          console.log('[sse] PG NOTIFY received:', msg.payload.substring(0, 100));
          const payload = JSON.parse(msg.payload);
          if (payload.partyId) broadcastParty(payload.partyId);
          if (payload.charId && payload.data) notifyChar(payload.charId, payload.data);
        } catch (e) {
          console.error('[sse] Bad notification payload:', e.message);
        }
      });

      listenClient.on('error', (err) => {
        console.error('[sse] LISTEN client error:', err.message);
        reconnectListener();
      });
      listenClient.on('end', () => {
        console.error('[sse] LISTEN client disconnected');
        reconnectListener();
      });
    } catch (err) {
      console.error('[sse] Failed to start LISTEN:', err.message);
      setTimeout(startListening, 5000);
    }
  }

  async function reconnectListener() {
    if (listenClient) { try { await listenClient.end(); } catch (_) {} listenClient = null; }
    setTimeout(startListening, 2000);
  }

  // ── Broadcast party state to all party members ──
  async function broadcastParty(partyId) {
    try {
      const members = await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [partyId]);
      console.log(`[sse] broadcastParty ${partyId}: ${members.length} members, connections: [${[...connections.keys()].join(',')}]`);
      const party = await ctx.getPartyWithMembers(partyId);

      let data;
      if (!party || party.state === 'disbanded') {
        data = { type: 'state', party: null, raidState: null, combat: null, pendingInvites: [] };
      } else {
        const partyState = ctx.buildPartyState(party);
        const raidState = party.state === 'in_raid' ? party.raid_state : null;
        const combat = party.state === 'in_raid' ? party.combat_state : null;
        data = { type: 'state', party: partyState, raidState, combat, pendingInvites: [] };
      }

      const payload = `data: ${JSON.stringify(data)}\n\n`;
      for (const m of members) {
        const conn = connections.get(m.char_id);
        if (conn) {
          try { conn.res.write(payload); } catch (_) { connections.delete(m.char_id); }
        }
      }
    } catch (err) {
      console.error(`[sse] Broadcast error for party ${partyId}:`, err.message);
    }
  }

  // ── Send targeted event to a single character ──
  function notifyChar(charId, data) {
    const conn = connections.get(Number(charId));
    if (!conn) return;
    try {
      conn.res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (_) {
      connections.delete(Number(charId));
    }
  }

  // ── Heartbeat ──
  function startHeartbeat() {
    heartbeatTimer = setInterval(() => {
      for (const [charId, conn] of connections) {
        try {
          const ok = conn.res.write(': keepalive\n\n');
          if (ok === false) connections.delete(charId);
        } catch (_) {
          connections.delete(charId);
        }
      }
    }, HEARTBEAT_MS);
  }

  // ── SSE Endpoint — available to ALL authenticated players ──
  app.get('/api/fantasy/party/stream', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      // SSE headers
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');

      // Replace existing connection (reconnect)
      const oldConn = connections.get(char.id);
      if (oldConn) { try { oldConn.res.end(); } catch (_) {} }
      connections.set(char.id, { res, partyId: char.party_id });

      if (ctx.friendsOnline) ctx.friendsOnline.touchOnline(char.id);

      // Send initial party state if in a party
      if (char.party_id) {
        const party = await ctx.getPartyWithMembers(char.party_id);
        if (party && party.state !== 'disbanded') {
          const partyState = ctx.buildPartyState(party);
          const raidState = party.state === 'in_raid' ? party.raid_state : null;
          const combat = party.state === 'in_raid' ? party.combat_state : null;
          res.write(`data: ${JSON.stringify({ type: 'state', party: partyState, raidState, combat, pendingInvites: [] })}\n\n`);
        }
      }

      // Send pending invites
      const invites = await q(
        "SELECT pi.id as invite_id, pi.party_id, c.name as from_name, c.class as from_class, c.level as from_level FROM fantasy_party_invites pi JOIN fantasy_characters c ON c.id = pi.from_char_id WHERE pi.to_char_id=$1 AND pi.status='pending' AND pi.created_at > NOW() - INTERVAL '5 minutes'",
        [char.id]
      );
      if (invites.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'invites', pendingInvites: invites })}\n\n`);
      }

      req.on('close', () => { connections.delete(char.id); });

    } catch (err) {
      console.error('[sse] Stream setup error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Stream failed.' });
    }
  });

  // ── Notify helpers ──
  async function notifyPartyFn(partyId) {
    console.log(`[sse] notifyParty called for party ${partyId}, ${connections.size} SSE connections active`);
    try {
      await db.query(`SELECT pg_notify('${CHANNEL}', $1)`, [JSON.stringify({ partyId })]);
      console.log(`[sse] pg_notify sent for party ${partyId}`);
    } catch (err) {
      console.error('[sse] pg_notify error:', err.message);
      broadcastParty(partyId);
    }
  }

  async function notifyCharFn(charId, data) {
    // Try direct push first (fastest), fall back to PG NOTIFY
    const conn = connections.get(Number(charId));
    if (conn) {
      try { conn.res.write(`data: ${JSON.stringify(data)}\n\n`); return; } catch (_) { connections.delete(Number(charId)); }
    }
    try {
      await db.query(`SELECT pg_notify('${CHANNEL}', $1)`, [JSON.stringify({ charId, data })]);
    } catch (err) {
      console.error('[sse] notifyChar failed:', err.message);
    }
  }

  startListening();
  startHeartbeat();

  function closeAll() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    for (const [, conn] of connections) { try { conn.res.end(); } catch (_) {} }
    connections.clear();
    if (listenClient) { try { listenClient.end(); } catch (_) {} listenClient = null; }
  }

  ctx.notifyParty = notifyPartyFn;
  ctx.notifyChar = notifyCharFn;
  ctx.sseCloseAll = closeAll;
  ctx.sseBroadcast = broadcastParty;
}

module.exports = { register };
