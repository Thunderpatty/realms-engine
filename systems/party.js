// ═══════════════════════════════════════════════════════════════
// PARTY SYSTEM — Create, invite, join, ready, start raid parties
// Foundation for multiplayer raid combat
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');

const MAX_PARTY_SIZE = 5;
const INVITE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
const DISCONNECT_THRESHOLD_MS = 60 * 1000; // 60 seconds

function register(app, requireAuth, ctx) {
  const { db, q, q1, withTransaction, getChar, addLog, buildState, gameEvents, getContent } = ctx;

  // Any realm's raidTown is a valid party location
  function isPartyLocation(locationSlug) {
    return (getContent().realms || []).some(r => r.raidTown === locationSlug);
  }
  function getPartyLocationName(locationSlug) {
    const loc = (getContent().locations || []).find(l => l.slug === locationSlug);
    return loc?.name || locationSlug;
  }

  // Helper: get party with members
  async function getPartyWithMembers(partyId) {
    const party = await q1('SELECT * FROM fantasy_parties WHERE id = $1', [partyId]);
    if (!party) return null;
    const members = await q(`
      SELECT pm.*, c.name, c.class, c.level, c.hp, c.max_hp, c.mp, c.max_mp, c.location, c.race
      FROM fantasy_party_members pm
      JOIN fantasy_characters c ON c.id = pm.char_id
      WHERE pm.party_id = $1
      ORDER BY pm.char_id
    `, [partyId]);
    const invites = await q(`
      SELECT pi.*, c.name as to_name, c.class as to_class, c.level as to_level
      FROM fantasy_party_invites pi
      JOIN fantasy_characters c ON c.id = pi.to_char_id
      WHERE pi.party_id = $1 AND pi.status = 'pending'
      ORDER BY pi.created_at DESC
    `, [partyId]);
    return { ...party, members, invites };
  }

  // Helper: build full canonical response for party state
  async function buildFullPartyResponse(charId, partyId) {
    const party = partyId ? await getPartyWithMembers(partyId) : null;
    const partyState = party && party.state !== 'disbanded' ? buildPartyState(party) : null;
    const raidState = party?.state === 'in_raid' ? party.raid_state : null;
    const combat = party?.state === 'in_raid' ? party.combat_state : null;
    const invites = await q(
      "SELECT pi.id as invite_id, pi.party_id, c.name as from_name, c.class as from_class, c.level as from_level FROM fantasy_party_invites pi JOIN fantasy_characters c ON c.id = pi.from_char_id WHERE pi.to_char_id=$1 AND pi.status='pending' AND pi.created_at > NOW() - INTERVAL '5 minutes'",
      [charId]
    );
    return { party: partyState, raidState, combat, pendingInvites: invites };
  }

  // Helper: build party state for frontend
  function buildPartyState(party) {
    if (!party) return null;
    return {
      id: party.id,
      leaderId: party.leader_id,
      state: party.state,
      raidSlug: party.raid_slug,
      members: party.members.map(m => ({
        charId: m.char_id,
        name: m.name,
        class: m.class,
        race: m.race,
        level: m.level,
        hp: m.hp,
        maxHp: m.max_hp,
        mp: m.mp,
        maxMp: m.max_mp,
        location: m.location,
        ready: m.ready,
        lobbyJoined: m.lobby_joined,
        status: m.status,
        isLeader: m.char_id === party.leader_id,
      })),
      invites: party.invites.map(i => ({
        inviteId: i.id,
        toCharId: i.to_char_id,
        toName: i.to_name,
        toClass: i.to_class,
        toLevel: i.to_level,
      })),
    };
  }

  // Helper: cleanup expired invites
  async function cleanupInvites(partyId) {
    await db.query(
      "UPDATE fantasy_party_invites SET status='expired' WHERE party_id=$1 AND status='pending' AND created_at < NOW() - INTERVAL '5 minutes'",
      [partyId]
    );
  }

  // Helper: disband party
  async function disbandParty(partyId, reason) {
    const members = await q('SELECT char_id FROM fantasy_party_members WHERE party_id = $1', [partyId]);
    await withTransaction(async (tx) => {
      for (const m of members) {
        await tx.query('UPDATE fantasy_characters SET party_id = NULL, raid_state = NULL WHERE id = $1', [m.char_id]);
      }
      await tx.query('DELETE FROM fantasy_party_members WHERE party_id = $1', [partyId]);
      await tx.query("UPDATE fantasy_party_invites SET status='expired' WHERE party_id=$1 AND status='pending'", [partyId]);
      await tx.query("UPDATE fantasy_parties SET state='disbanded', combat_state=NULL, raid_state=NULL WHERE id=$1", [partyId]);
    });
    for (const m of members) {
      await addLog(m.char_id, 'social', `👥 Party disbanded: ${reason}`);
    }
    // Notify each former member directly — broadcastParty(partyId) would query
    // fantasy_party_members which is now empty, so nobody would be reached.
    const disbandPayload = { type: 'state', party: null, raidState: null, combat: null, pendingInvites: [] };
    if (ctx.notifyChar) {
      for (const m of members) {
        await ctx.notifyChar(m.char_id, disbandPayload);
      }
    }
  }

  // ─── CREATE PARTY ───
  app.post('/api/fantasy/party/create', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot create a party during combat.' });
      if (char.party_id) return res.status(400).json({ error: 'Already in a party.' });
      if (char.raid_state) return res.status(400).json({ error: 'Cannot create a party during a raid.' });
      if (char.arena_state) return res.status(400).json({ error: 'Cannot create a party during an arena run.' });

      const partyId = await withTransaction(async (tx) => {
        const result = await tx.query("INSERT INTO fantasy_parties (leader_id, state) VALUES ($1, 'forming') RETURNING id", [char.id]);
        const pid = result.rows[0].id;
        await tx.query('INSERT INTO fantasy_party_members (party_id, char_id, ready) VALUES ($1, $2, FALSE)', [pid, char.id]);
        await tx.query('UPDATE fantasy_characters SET party_id = $1 WHERE id = $2', [pid, char.id]);
        return pid;
      });
      await addLog(char.id, 'social', '👥 Created a raid party.');

      if (ctx.notifyParty) ctx.notifyParty(partyId);
      const response = await buildFullPartyResponse(char.id, partyId);
      res.json({ ok: true, ...response });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to create party.' }); }
  });

  // ─── INVITE TO PARTY ───
  app.post('/api/fantasy/party/invite', requireAuth, validate(schemas.partyInvite), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await getPartyWithMembers(char.party_id);
      if (!party || party.state !== 'forming') return res.status(400).json({ error: 'Party is not accepting invites.' });
      if (party.leader_id !== char.id) return res.status(400).json({ error: 'Only the leader can invite.' });
      if (party.members.length >= MAX_PARTY_SIZE) return res.status(400).json({ error: 'Party is full (max 5).' });

      const { charId } = req.body;
      const target = await q1('SELECT id, name, location, party_id, in_combat, raid_state, arena_state FROM fantasy_characters WHERE id = $1', [charId]);
      if (!target) return res.status(400).json({ error: 'Character not found.' });
      if (target.id === char.id) return res.status(400).json({ error: "Can't invite yourself." });
      if (target.party_id) return res.status(400).json({ error: `${target.name} is already in a party.` });
      if (target.in_combat) return res.status(400).json({ error: `${target.name} is in combat.` });
      if (target.raid_state) return res.status(400).json({ error: `${target.name} is in a raid.` });
      if (target.arena_state) return res.status(400).json({ error: `${target.name} is in the arena.` });

      // Check they're friends
      const friendship = await q1(
        "SELECT id FROM fantasy_friends WHERE ((char_id=$1 AND friend_char_id=$2) OR (char_id=$2 AND friend_char_id=$1)) AND status='accepted'",
        [char.id, target.id]
      );
      if (!friendship) return res.status(400).json({ error: `${target.name} must be on your friends list.` });

      // Check for existing pending invite
      const existingInvite = await q1(
        "SELECT id FROM fantasy_party_invites WHERE party_id=$1 AND to_char_id=$2 AND status='pending'",
        [party.id, target.id]
      );
      if (existingInvite) return res.status(400).json({ error: `Already invited ${target.name}.` });

      await cleanupInvites(party.id);

      await db.query(
        'INSERT INTO fantasy_party_invites (party_id, from_char_id, to_char_id) VALUES ($1, $2, $3)',
        [party.id, char.id, target.id]
      );
      await addLog(char.id, 'social', `👥 Invited ${target.name} to the party.`);

      // Push invite notification to target via SSE
      if (ctx.notifyChar) {
        ctx.notifyChar(target.id, { type: 'invite', invite: { invite_id: null, party_id: party.id, from_name: char.name, from_class: char.class, from_level: char.level } });
      }

      const updated = await getPartyWithMembers(party.id);
      if (ctx.notifyParty) ctx.notifyParty(party.id);
      res.json({ ok: true, party: buildPartyState(updated), message: `Invited ${target.name}.` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to invite.' }); }
  });

  // ─── ACCEPT INVITE ───
  app.post('/api/fantasy/party/accept', requireAuth, validate(schemas.partyInviteResponse), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.party_id) return res.status(400).json({ error: 'Already in a party.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot join during combat.' });
      if (char.raid_state) return res.status(400).json({ error: 'Cannot join during a raid.' });

      const { inviteId } = req.body;
      const invite = await q1(
        "SELECT * FROM fantasy_party_invites WHERE id=$1 AND to_char_id=$2 AND status='pending'",
        [inviteId, char.id]
      );
      if (!invite) return res.status(400).json({ error: 'Invite not found or expired.' });

      // Check party still valid
      const party = await getPartyWithMembers(invite.party_id);
      if (!party || party.state !== 'forming') {
        await db.query("UPDATE fantasy_party_invites SET status='expired' WHERE id=$1", [inviteId]);
        return res.status(400).json({ error: 'Party no longer accepting members.' });
      }
      if (party.members.length >= MAX_PARTY_SIZE) {
        await db.query("UPDATE fantasy_party_invites SET status='expired' WHERE id=$1", [inviteId]);
        return res.status(400).json({ error: 'Party is full.' });
      }

      await withTransaction(async (tx) => {
        await tx.query("UPDATE fantasy_party_invites SET status='accepted' WHERE id=$1", [inviteId]);
        await tx.query('INSERT INTO fantasy_party_members (party_id, char_id, ready) VALUES ($1, $2, FALSE)', [party.id, char.id]);
        await tx.query('UPDATE fantasy_characters SET party_id = $1 WHERE id = $2', [party.id, char.id]);
        await tx.query("UPDATE fantasy_party_invites SET status='expired' WHERE to_char_id=$1 AND status='pending' AND id != $2", [char.id, inviteId]);
      });

      await addLog(char.id, 'social', `👥 Joined the party!`);
      for (const m of party.members) {
        await addLog(m.char_id, 'social', `👥 ${char.name} joined the party.`);
      }

      if (ctx.notifyParty) ctx.notifyParty(party.id);
      const response = await buildFullPartyResponse(char.id, party.id);
      res.json({ ok: true, ...response });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to join.' }); }
  });

  // ─── DECLINE INVITE ───
  app.post('/api/fantasy/party/decline', requireAuth, validate(schemas.partyInviteResponse), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      const { inviteId } = req.body;
      const invite = await q1(
        "SELECT * FROM fantasy_party_invites WHERE id=$1 AND to_char_id=$2 AND status='pending'",
        [inviteId, char.id]
      );
      if (!invite) return res.status(400).json({ error: 'Invite not found.' });

      await db.query("UPDATE fantasy_party_invites SET status='declined' WHERE id=$1", [inviteId]);
      res.json({ ok: true, message: 'Invite declined.' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to decline.' }); }
  });

  // ─── LEAVE PARTY ───
  app.post('/api/fantasy/party/leave', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await getPartyWithMembers(char.party_id);
      if (!party) {
        await db.query('UPDATE fantasy_characters SET party_id = NULL WHERE id = $1', [char.id]);
        return res.json({ ok: true });
      }

      if (party.state === 'in_raid') return res.status(400).json({ error: 'Cannot leave during a raid. The party fights together or falls together.' });

      if (party.leader_id === char.id) {
        // Leader leaves = disband
        await disbandParty(party.id, `${char.name} (leader) left.`);
      } else {
        // Member leaves
        await withTransaction(async (tx) => {
          await tx.query('DELETE FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [party.id, char.id]);
          await tx.query('UPDATE fantasy_characters SET party_id = NULL WHERE id = $1', [char.id]);
        });
        await addLog(char.id, 'social', '👥 Left the party.');
        for (const m of party.members) {
          if (m.char_id !== char.id) await addLog(m.char_id, 'social', `👥 ${char.name} left the party.`);
        }
        if (ctx.notifyParty) ctx.notifyParty(party.id);
      }

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to leave.' }); }
  });

  // ─── KICK MEMBER ───
  app.post('/api/fantasy/party/kick', requireAuth, validate(schemas.partyKick), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party || party.leader_id !== char.id) return res.status(400).json({ error: 'Only the leader can kick.' });
      if (party.state === 'in_raid') return res.status(400).json({ error: 'Cannot kick during a raid.' });

      const { charId } = req.body;
      if (charId === char.id) return res.status(400).json({ error: "Can't kick yourself." });

      const member = await q1('SELECT * FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [party.id, charId]);
      if (!member) return res.status(400).json({ error: 'Not in your party.' });

      const kicked = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [charId]);
      await withTransaction(async (tx) => {
        await tx.query('DELETE FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [party.id, charId]);
        await tx.query('UPDATE fantasy_characters SET party_id = NULL WHERE id = $1', [charId]);
      });
      await addLog(charId, 'social', '👥 You were kicked from the party.');

      if (ctx.notifyParty) ctx.notifyParty(party.id);
      const response = await buildFullPartyResponse(char.id, party.id);
      res.json({ ok: true, ...response, message: `Kicked ${kicked?.name || 'member'}.` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to kick.' }); }
  });

  // ─── VOTE KICK (during raids) ───
  app.post('/api/fantasy/party/votekick', requireAuth, validate(schemas.partyKick), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party) return res.status(400).json({ error: 'Party not found.' });

      const { charId: targetId } = req.body;
      if (targetId === char.id) return res.status(400).json({ error: "Can't vote-kick yourself." });

      const member = await q1('SELECT * FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [party.id, targetId]);
      if (!member) return res.status(400).json({ error: 'Player not in your party.' });

      const target = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [targetId]);
      const targetName = target?.name || 'Unknown';

      // Track votes on the party's raid_state or combat_state
      const cs = party.combat_state || {};
      if (!cs.voteKicks) cs.voteKicks = {};
      const voteKey = String(targetId);
      if (!cs.voteKicks[voteKey]) cs.voteKicks[voteKey] = [];

      // Can't vote twice
      if (cs.voteKicks[voteKey].includes(char.id)) {
        return res.status(400).json({ error: `Already voted to kick ${targetName}.` });
      }

      cs.voteKicks[voteKey].push(char.id);

      // Check majority: need > 50% of living members (excluding target)
      const allMembers = await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [party.id]);
      const eligible = allMembers.filter(m => m.char_id !== targetId).length;
      const votes = cs.voteKicks[voteKey].length;
      const needed = Math.ceil(eligible / 2);

      if (votes >= needed) {
        // Vote passed — remove from party + combat
        if (cs.players && cs.players[targetId]) {
          cs.players[targetId].hp = 0;
          const log = cs.completedLog || [];
          log.push(`🚪 ${targetName} was vote-kicked from the raid.`);
          cs.completedLog = log;
          if (cs.roundLog) cs.roundLog.push(`🚪 ${targetName} was vote-kicked from the raid.`);
        }
        delete cs.voteKicks[voteKey];

        await db.query('DELETE FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [party.id, targetId]);
        await db.query('UPDATE fantasy_characters SET party_id=NULL, raid_state=NULL WHERE id=$1', [targetId]);
        await addLog(targetId, 'social', '👥 You were vote-kicked from the raid party.');

        await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(cs), party.id]);

        const updated = await getPartyWithMembers(party.id);
        res.json({ ok: true, party: buildPartyState(updated), message: `${targetName} was kicked (${votes}/${needed} votes).`, kicked: true });
      } else {
        // Vote recorded but not enough yet
        await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(cs), party.id]);
        res.json({ ok: true, message: `Vote recorded (${votes}/${needed} needed to kick ${targetName}).`, kicked: false });
      }
    } catch (e) { console.error(e); res.status(500).json({ error: 'Vote-kick failed.' }); }
  });

  // ─── TOGGLE READY ───
  app.post('/api/fantasy/party/ready', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await q1('SELECT state FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party || party.state !== 'lobby') return res.status(400).json({ error: 'No active raid lobby — leader must select a raid first.' });

      const member = await q1('SELECT * FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [char.party_id, char.id]);
      if (!member) return res.status(400).json({ error: 'Not in party.' });
      if (!member.lobby_joined) return res.status(400).json({ error: 'Join the lobby first.' });

      const newReady = !member.ready;
      await db.query('UPDATE fantasy_party_members SET ready=$1 WHERE party_id=$2 AND char_id=$3', [newReady, char.party_id, char.id]);

      if (ctx.notifyParty) ctx.notifyParty(char.party_id);
      const response = await buildFullPartyResponse(char.id, char.party_id);
      res.json({ ok: true, ...response });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to toggle ready.' }); }
  });

  // ─── SELECT RAID (leader opens lobby) ───
  app.post('/api/fantasy/party/select-raid', requireAuth, validate(schemas.partyStart), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await getPartyWithMembers(char.party_id);
      if (!party) return res.status(400).json({ error: 'Party not found.' });
      if (party.leader_id !== char.id) return res.status(400).json({ error: 'Only the leader can select a raid.' });
      if (party.state !== 'forming' && party.state !== 'lobby') return res.status(400).json({ error: 'Cannot select a raid now.' });
      if (party.members.length < 2) return res.status(400).json({ error: 'Need at least 2 party members for a raid.' });

      const { raidSlug } = req.body;
      const fs = require('fs');
      const path = require('path');
      let raid;
      try {
        raid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'raids', raidSlug + '.json'), 'utf8'));
      } catch (e) {
        return res.status(400).json({ error: 'Unknown raid.' });
      }

      for (const m of party.members) {
        if (m.level < (raid.levelReq || 1)) return res.status(400).json({ error: `${m.name} must be level ${raid.levelReq}+ for ${raid.name}.` });
      }

      await withTransaction(async (tx) => {
        await tx.query('UPDATE fantasy_party_members SET lobby_joined=FALSE, ready=FALSE WHERE party_id=$1', [party.id]);
        await tx.query('UPDATE fantasy_party_members SET lobby_joined=TRUE WHERE party_id=$1 AND char_id=$2', [party.id, char.id]);
        await tx.query("UPDATE fantasy_parties SET state='lobby', raid_slug=$1 WHERE id=$2", [raidSlug, party.id]);
      });

      for (const m of party.members) {
        await addLog(m.char_id, 'social', `🎯 ${char.name} opened a lobby for ${raid.name}.`);
      }
      if (ctx.notifyParty) ctx.notifyParty(party.id);
      const response = await buildFullPartyResponse(char.id, party.id);
      res.json({ ok: true, ...response });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to select raid.' }); }
  });

  // ─── CANCEL LOBBY (leader only, back to forming) ───
  app.post('/api/fantasy/party/cancel-lobby', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await getPartyWithMembers(char.party_id);
      if (!party) return res.status(400).json({ error: 'Party not found.' });
      if (party.leader_id !== char.id) return res.status(400).json({ error: 'Only the leader can cancel the lobby.' });
      if (party.state !== 'lobby') return res.status(400).json({ error: 'No active lobby.' });

      await withTransaction(async (tx) => {
        await tx.query('UPDATE fantasy_party_members SET lobby_joined=FALSE, ready=FALSE WHERE party_id=$1', [party.id]);
        await tx.query("UPDATE fantasy_parties SET state='forming', raid_slug=NULL WHERE id=$1", [party.id]);
      });

      for (const m of party.members) {
        await addLog(m.char_id, 'social', `❌ ${char.name} cancelled the raid lobby.`);
      }
      if (ctx.notifyParty) ctx.notifyParty(party.id);
      const response = await buildFullPartyResponse(char.id, party.id);
      res.json({ ok: true, ...response });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to cancel lobby.' }); }
  });

  // ─── JOIN LOBBY (non-leader confirms they're in) ───
  app.post('/api/fantasy/party/join-lobby', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await q1('SELECT state FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party || party.state !== 'lobby') return res.status(400).json({ error: 'No active lobby.' });

      const member = await q1('SELECT * FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [char.party_id, char.id]);
      if (!member) return res.status(400).json({ error: 'Not in party.' });

      if (!member.lobby_joined) {
        await db.query('UPDATE fantasy_party_members SET lobby_joined=TRUE WHERE party_id=$1 AND char_id=$2', [char.party_id, char.id]);
      }

      if (ctx.notifyParty) ctx.notifyParty(char.party_id);
      const response = await buildFullPartyResponse(char.id, char.party_id);
      res.json({ ok: true, ...response });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to join lobby.' }); }
  });

  // ─── POLL PARTY STATE ───
  app.get('/api/fantasy/party/poll', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      // Update online status
      if (ctx.friendsOnline) ctx.friendsOnline.touchOnline(char.id);

      // Check for pending invites (even if not in party)
      const pendingInvites = await q(
        "SELECT pi.id as invite_id, pi.party_id, c.name as from_name, c.class as from_class, c.level as from_level FROM fantasy_party_invites pi JOIN fantasy_characters c ON c.id = pi.from_char_id WHERE pi.to_char_id=$1 AND pi.status='pending' AND pi.created_at > NOW() - INTERVAL '5 minutes'",
        [char.id]
      );

      if (!char.party_id) {
        return res.json({ ok: true, party: null, pendingInvites });
      }

      // Update last_poll
      await db.query('UPDATE fantasy_party_members SET last_poll = NOW() WHERE party_id=$1 AND char_id=$2', [char.party_id, char.id]);

      const party = await getPartyWithMembers(char.party_id);
      if (!party || party.state === 'disbanded') {
        await db.query('UPDATE fantasy_characters SET party_id = NULL WHERE id = $1', [char.id]);
        return res.json({ ok: true, party: null, pendingInvites });
      }

      await cleanupInvites(party.id);

      const partyState = buildPartyState(party);
      // Include raid state if in raid (so all members see it)
      const raidState = party.state === 'in_raid' ? party.raid_state : null;
      const combat = party.state === 'in_raid' ? party.combat_state : null;
      res.json({ ok: true, party: partyState, pendingInvites, raidState, combat });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Poll failed.' }); }
  });

  // ─── START RAID (leader only, lobby must be fully joined + ready) ───
  app.post('/api/fantasy/party/start', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.party_id) return res.status(400).json({ error: 'Not in a party.' });

      const party = await getPartyWithMembers(char.party_id);
      if (!party) return res.status(400).json({ error: 'Party not found.' });
      if (party.leader_id !== char.id) return res.status(400).json({ error: 'Only the leader can start the raid.' });
      if (party.state !== 'lobby') return res.status(400).json({ error: 'No active lobby — select a raid first.' });
      if (!party.raid_slug) return res.status(400).json({ error: 'No raid selected.' });
      if (party.members.length < 2) return res.status(400).json({ error: 'Need at least 2 party members to start.' });

      const notJoined = party.members.filter(m => !m.lobby_joined);
      if (notJoined.length > 0) return res.status(400).json({ error: `Waiting for lobby join: ${notJoined.map(m => m.name).join(', ')}` });
      const notReady = party.members.filter(m => !m.ready);
      if (notReady.length > 0) return res.status(400).json({ error: `Not ready: ${notReady.map(m => m.name).join(', ')}` });

      const fs = require('fs');
      const path = require('path');
      let raid;
      try {
        raid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'raids', party.raid_slug + '.json'), 'utf8'));
      } catch (e) {
        return res.status(400).json({ error: 'Raid content missing.' });
      }

      // Re-check level reqs at start in case someone deranked (shouldn't happen, but defensive)
      for (const m of party.members) {
        if (m.level < (raid.levelReq || 1)) return res.status(400).json({ error: `${m.name} must be level ${raid.levelReq}+.` });
      }

      const totalFloors = Array.isArray(raid.floors) ? raid.floors.length : (raid.floorCount || 3);
      const raidState = {
        raidSlug: raid.slug,
        currentFloor: 1,
        encounterIndex: 0,
        phase: 'lore',
        floorsCleared: 0,
        totalFloors,
        startedAt: new Date().toISOString(),
        floorBuffs: [],
        floorDebuffs: [],
        totalXp: 0,
        totalGold: 0,
        partyMode: true,
        votes: {},
      };

      await db.query(
        "UPDATE fantasy_parties SET state='in_raid', raid_state=$1 WHERE id=$2",
        [JSON.stringify(raidState), party.id]
      );

      for (const m of party.members) {
        await addLog(m.char_id, 'raid', `🕳 Party entered ${raid.name}!`);
      }

      const updated = await getPartyWithMembers(party.id);
      if (ctx.notifyParty) ctx.notifyParty(party.id);
      res.json({ ok: true, party: buildPartyState(updated) });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to start raid.' }); }
  });

  // ─── PARTY RAID ADVANCE (leader advances non-combat phases) ───
  app.post('/api/fantasy/party/raid/advance', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.party_id) return res.status(400).json({ error: 'Not in a party.' });
      const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party || party.state !== 'in_raid') return res.status(400).json({ error: 'Not in a party raid.' });
      if (party.combat_state && ['submit', 'resolving'].includes(party.combat_state.phase)) return res.status(400).json({ error: 'In combat. Submit your action.' });
      if (party.leader_id !== char.id) return res.status(400).json({ error: 'Only the leader can advance.' });

      const rs = party.raid_state;
      if (!rs) return res.status(400).json({ error: 'No raid state.' });

      const fs = require('fs');
      const path = require('path');
      const raid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'raids', rs.raidSlug + '.json'), 'utf8'));
      const floorDef = raid.floors?.[rs.currentFloor - 1];
      if (!floorDef) return res.status(400).json({ error: 'Invalid floor.' });

      // Handle phase transitions (mirrors solo raid.js but uses party tables)
      if (rs.phase === 'lore') {
        rs.phase = 'encounter'; rs.encounterIndex = 0;
      } else if (rs.phase === 'choiceResult') {
        rs.encounterIndex++; rs.phase = 'encounter';
      } else if (rs.phase === 'nextFloor') {
        rs.currentFloor++; rs.encounterIndex = 0; rs.phase = 'lore'; rs.floorDebuffs = [];
      } else if (rs.phase === 'encounter') {
        const encounters = floorDef.encounters || [];
        if (rs.encounterIndex >= encounters.length) {
          rs.phase = 'preBoss'; rs.preBossChoiceMade = {};
        } else {
          const encounter = encounters[rs.encounterIndex];
          if (encounter.type === 'combat') {
            // Start party combat
            const partySize = (await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [party.id])).length;
            const enemies = [];
            let eidx = 0;
            const floorScale = 1 + (rs.currentFloor - 1) * 0.15;
            const partySizeScale = 1 + 0.5 * (partySize - 1);

            for (let i = 0; i < (encounter.enemies || []).length; i++) {
              const slug = encounter.enemies[i];
              const count = (encounter.count || [])[i] || 1;
              const enemyDef = raid.enemies.find(e => e.slug === slug);
              if (!enemyDef) continue;
              for (let j = 0; j < count; j++) {
                const scaled = ctx.buildScaledEnemy(enemyDef, 7, rs.raidSlug, { elite: false });
                scaled.hp = Math.floor(scaled.hp * floorScale * 1.3 * partySizeScale);
                scaled.maxHp = scaled.hp;
                scaled.attack = Math.floor(scaled.attack * floorScale * 1.2 * (1 + 0.15 * (partySize - 1)));
                scaled.defense = Math.floor(scaled.defense * floorScale * 1.15);
                scaled.id = 'e' + eidx++;
                scaled.effects = [];
                enemies.push(scaled);
              }
            }

            if (enemies.length > 0) {
              const cs = await ctx.startPartyCombat(party.id, enemies, rs, { isBossRoom: false });
              for (const m of await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [party.id])) {
                await addLog(m.char_id, 'raid', `⚔ Party combat: Floor ${rs.currentFloor}`);
              }
              await db.query('UPDATE fantasy_parties SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), party.id]);
              if (ctx.notifyParty) ctx.notifyParty(party.id);
              const updated = await q1('SELECT combat_state, raid_state FROM fantasy_parties WHERE id=$1', [party.id]);
              return res.json({ ok: true, combat: updated.combat_state, raidState: updated.raid_state });
            }
            rs.encounterIndex++;
          } else if (encounter.type === 'choice') {
            rs.phase = 'choice'; rs.votes = {};
          } else {
            rs.encounterIndex++;
          }
        }
      } else if (rs.phase === 'preBoss' || rs.phase === 'boss') {
        // Start boss combat
        const bossDef = floorDef.boss;
        if (!bossDef) return res.status(400).json({ error: 'No boss.' });
        const partySize = (await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [party.id])).length;
        const floorScale = 1 + (rs.currentFloor - 1) * 0.15;
        const bossHpScale = 1 + 0.6 * (partySize - 1);

        const bossEnemy = ctx.buildScaledEnemy(bossDef, 7, rs.raidSlug, { elite: false });
        bossEnemy.hp = Math.floor(bossEnemy.hp * floorScale * 1.3 * bossHpScale);
        bossEnemy.maxHp = bossEnemy.hp;
        bossEnemy.attack = Math.floor(bossEnemy.attack * floorScale * 1.2 * (1 + 0.15 * (partySize - 1)));
        bossEnemy.defense = Math.floor(bossEnemy.defense * floorScale * 1.15);
        bossEnemy.id = 'e0';
        bossEnemy.boss = true;
        bossEnemy.effects = [];
        if (bossDef.telegraphs) bossEnemy.telegraphs = bossDef.telegraphs;
        if (bossDef.enrageThreshold) bossEnemy.enrageThreshold = bossDef.enrageThreshold;
        if (bossDef.enrageTelegraphs) bossEnemy.enrageTelegraphs = bossDef.enrageTelegraphs;

        rs.phase = 'boss';
        await ctx.startPartyCombat(party.id, [bossEnemy], rs, { isBossRoom: true });
        for (const m of await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [party.id])) {
          await addLog(m.char_id, 'raid', `🔥 Party boss fight: ${bossDef.name}`);
        }
        await db.query('UPDATE fantasy_parties SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), party.id]);
        if (ctx.notifyParty) ctx.notifyParty(party.id);
        const updated = await q1('SELECT combat_state, raid_state FROM fantasy_parties WHERE id=$1', [party.id]);
        return res.json({ ok: true, combat: updated.combat_state, raidState: updated.raid_state });
      } else if (rs.phase === 'complete') {
        // Raid finished — clear combat state so completion screen shows
        await db.query('UPDATE fantasy_parties SET combat_state=NULL WHERE id=$1', [party.id]);
        if (ctx.notifyParty) ctx.notifyParty(party.id);
        const partyState = buildPartyState(await getPartyWithMembers(party.id));
        return res.json({ ok: true, raidState: rs, party: partyState });
      } else {
        return res.status(400).json({ error: 'Unknown phase: ' + rs.phase });
      }

      await db.query('UPDATE fantasy_parties SET raid_state=$1, combat_state=NULL WHERE id=$2', [JSON.stringify(rs), party.id]);
      if (ctx.notifyParty) ctx.notifyParty(party.id);
      const partyState = buildPartyState(await getPartyWithMembers(party.id));
      res.json({ ok: true, raidState: rs, party: partyState });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Advance failed.' }); }
  });

  // ─── PARTY RAID CHOICE (vote system) ───
  app.post('/api/fantasy/party/raid/choice', requireAuth, validate(schemas.raidChoice), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.party_id) return res.status(400).json({ error: 'Not in a party.' });
      const { choiceIdx } = req.body;

      // Lock party row for vote read-modify-write
      const { party, rs, allVoted, members } = await withTransaction(async (tx) => {
        const p = (await tx.query('SELECT * FROM fantasy_parties WHERE id=$1 FOR UPDATE', [char.party_id])).rows[0];
        if (!p || !p.raid_state || p.raid_state.phase !== 'choice') throw new Error('Not at a choice point.');
        const rState = p.raid_state;
        rState.votes = rState.votes || {};
        rState.votes[char.id] = choiceIdx;
        const mems = (await tx.query('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [p.id])).rows;
        const voted = mems.every(m => rState.votes[m.char_id] !== undefined);
        // Write votes immediately (even if not all voted yet)
        await tx.query('UPDATE fantasy_parties SET raid_state=$1 WHERE id=$2', [JSON.stringify(rState), p.id]);
        return { party: p, rs: rState, allVoted: voted, members: mems };
      });

      if (allVoted) {
        // Tally votes — majority wins, ties go to leader
        const counts = {};
        for (const v of Object.values(rs.votes)) counts[v] = (counts[v] || 0) + 1;
        const maxVotes = Math.max(...Object.values(counts));
        const winners = Object.keys(counts).filter(k => counts[k] === maxVotes);
        const winningIdx = winners.length === 1 ? Number(winners[0]) : Number(rs.votes[party.leader_id] ?? winners[0]);

        // Resolve the choice (same as solo raid)
        const fs = require('fs');
        const path = require('path');
        const raid = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'raids', rs.raidSlug + '.json'), 'utf8'));
        const floorDef = raid.floors?.[rs.currentFloor - 1];
        const encounter = floorDef?.encounters?.[rs.encounterIndex];
        const choice = encounter?.choices?.[winningIdx];

        if (choice) {
          // Use leader's stats for the DC check
          const leaderChar = await q1('SELECT * FROM fantasy_characters WHERE id=$1', [party.leader_id]);
          let success = true;
          let rollInfo = null;
          if (choice.check && !choice.auto) {
            const equipment = await ctx.getEquipment(party.leader_id);
            const stats = ctx.computeStats(leaderChar || char, equipment);
            const statVal = stats[choice.check.stat] || 10;
            const modifier = Math.floor((statVal - 10) / 2);
            const roll = ctx.rand(1, 20);
            const total = roll + modifier;
            success = total >= choice.check.dc;
            rollInfo = { stat: choice.check.stat, dc: choice.check.dc, roll, modifier, total, success };
          }

          const outcome = success ? choice.success : (choice.failure || choice.success);
          const effect = outcome.effect || {};
          const messages = [];

          // Apply effects to all party members
          for (const m of members) {
            const mc = await q1('SELECT * FROM fantasy_characters WHERE id=$1', [m.char_id]);
            if (!mc) continue;
            if (effect.healPct) { mc.hp = Math.min(mc.max_hp, mc.hp + Math.floor(mc.max_hp * effect.healPct / 100)); }
            if (effect.manaPct) { mc.mp = Math.min(mc.max_mp, mc.mp + Math.floor(mc.max_mp * effect.manaPct / 100)); }
            if (effect.damagePct) { mc.hp = Math.max(1, mc.hp - Math.floor(mc.max_hp * effect.damagePct / 100)); }
            if (effect.mpDrain) { mc.mp = Math.max(0, mc.mp - Math.floor(mc.max_mp * effect.mpDrain / 100)); }
            await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2 WHERE id=$3', [mc.hp, mc.mp, mc.id]);
          }

          if (effect.healPct) messages.push(`🩸 Healed ${effect.healPct}% HP`);
          if (effect.manaPct) messages.push(`💜 Restored ${effect.manaPct}% MP`);
          if (effect.damagePct) messages.push(`💔 Took ${effect.damagePct}% damage`);
          if (effect.mpDrain) messages.push(`💜 Lost ${effect.mpDrain}% MP`);
          if (effect.buffStat) { rs.floorBuffs = rs.floorBuffs || []; rs.floorBuffs.push({ stat: effect.buffStat, amount: effect.buffAmount || 3, name: encounter.title, turnsLeft: effect.buffTurns || 99 }); messages.push(`⬆ +${effect.buffAmount||3} ${effect.buffStat.toUpperCase()}`); }
          if (effect.debuff) { rs.floorDebuffs = rs.floorDebuffs || []; rs.floorDebuffs.push({ slug: effect.debuff.slug, turns: effect.debuff.turns || 3, name: effect.debuff.name }); messages.push(`☠ ${effect.debuff.name}`); }

          // Preserve voter breakdown and choice labels so the client can render
          // "Party chose:" on the result screen without re-fetching raid content.
          const votersByChoice = {};
          for (const [cid, cidx] of Object.entries(rs.votes)) {
            if (!votersByChoice[cidx]) votersByChoice[cidx] = [];
            votersByChoice[cidx].push(Number(cid));
          }
          const choiceLabels = (encounter.choices || []).map(ch => ch.label);
          rs.lastChoiceOutcome = { title: encounter.title, success, text: outcome.text, messages, rollInfo, voteCounts: counts, winningIdx, choiceLabels, voters: votersByChoice };
          rs.phase = 'choiceResult';
          rs.votes = {};
        }
      }

      if (allVoted) {
        // Choice resolution already modified rs, save again
        await db.query('UPDATE fantasy_parties SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), party.id]);
      }
      if (ctx.notifyParty) ctx.notifyParty(party.id);
      res.json({ ok: true, raidState: rs, voted: true, allVoted });
    } catch (e) {
      if (e.message && !e.message.includes('ROLLBACK')) return res.status(400).json({ error: e.message });
      console.error(e); res.status(500).json({ error: 'Vote failed.' });
    }
  });

  // ─── PARTY PRE-BOSS RECOVERY (each player chooses independently) ───
  app.post('/api/fantasy/party/raid/floor-choice', requireAuth, validate(schemas.raidFloorChoice), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.party_id) return res.status(400).json({ error: 'Not in a party.' });
      const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party || !party.raid_state || party.raid_state.phase !== 'preBoss') return res.status(400).json({ error: 'Not at pre-boss.' });

      const rs = party.raid_state;
      rs.preBossChoiceMade = rs.preBossChoiceMade || {};
      if (rs.preBossChoiceMade[char.id]) return res.status(400).json({ error: 'Already chosen.' });

      const { choice } = req.body;
      if (choice === 'healHp') {
        char.hp = Math.min(char.max_hp, char.hp + Math.floor(char.max_hp * 0.25));
      } else if (choice === 'restoreMp') {
        char.mp = Math.min(char.max_mp, char.mp + Math.floor(char.max_mp * 0.25));
      } else if (choice === 'both') {
        char.hp = Math.min(char.max_hp, char.hp + Math.floor(char.max_hp * 0.15));
        char.mp = Math.min(char.max_mp, char.mp + Math.floor(char.max_mp * 0.15));
      }

      rs.preBossChoiceMade[char.id] = true;
      await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2 WHERE id=$3', [char.hp, char.mp, char.id]);
      await db.query('UPDATE fantasy_parties SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), party.id]);

      if (ctx.notifyParty) ctx.notifyParty(party.id);
      res.json({ ok: true, raidState: rs });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Choice failed.' }); }
  });

  // ─── PARTY RAID DISMISS (per-player acknowledge) ───
  // Each player closes the completion screen at their own pace. Their char leaves
  // the party individually; remaining members stay on the screen until they dismiss.
  // When the last player dismisses, the party row is marked disbanded.
  app.post('/api/fantasy/party/raid/dismiss', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      if (!char.party_id) {
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state });
      }

      const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [char.party_id]);
      if (!party || !party.raid_state || party.raid_state.phase !== 'complete') {
        return res.status(400).json({ error: 'Raid not complete.' });
      }

      let remaining = [];
      const wasLeader = party.leader_id === char.id;
      await withTransaction(async (tx) => {
        await tx.query('DELETE FROM fantasy_party_members WHERE party_id=$1 AND char_id=$2', [party.id, char.id]);
        await tx.query('UPDATE fantasy_characters SET party_id=NULL, raid_state=NULL WHERE id=$1', [char.id]);
        const rem = (await tx.query('SELECT char_id FROM fantasy_party_members WHERE party_id=$1 ORDER BY char_id', [party.id])).rows;
        remaining = rem;
        if (wasLeader && rem.length > 0) {
          await tx.query('UPDATE fantasy_parties SET leader_id=$1 WHERE id=$2', [rem[0].char_id, party.id]);
        }
        if (rem.length === 0) {
          await tx.query("UPDATE fantasy_parties SET state='disbanded', combat_state=NULL, raid_state=NULL WHERE id=$1", [party.id]);
        }
      });

      await addLog(char.id, 'raid', '🏁 You closed out the raid and returned to your adventure.');

      // Push null party state to this char (they're out)
      if (ctx.notifyChar) {
        await ctx.notifyChar(char.id, { type: 'state', party: null, raidState: null, combat: null, pendingInvites: [] });
      }
      // Remaining members see the shrunken party via a standard party broadcast
      if (remaining.length > 0 && ctx.notifyParty) {
        await ctx.notifyParty(party.id);
      }

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Dismiss failed.' }); }
  });

  // Expose helpers for other systems
  ctx.getPartyWithMembers = getPartyWithMembers;
  ctx.buildPartyState = buildPartyState;
  ctx.disbandParty = disbandParty;
}

module.exports = { register };
