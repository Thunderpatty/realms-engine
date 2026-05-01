// ═══════════════════════════════════════════════════════════════
// CHARACTERS — Create, Reset, Switch, Travel
// Extracted from fantasy-rpg.js (Tier 2A)
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const { validate, schemas } = require('../validation');

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, withTransaction, getChar, getCharList, addLog, addItem, removeItem,
    buildState, getContent, RACES, CLASSES, HOME_LOCATION,
  } = ctx;

  // Get portal connections from realms.json for a given location + unlocked realms
  function getPortalConnections(locationSlug, unlockedRealms) {
    const portals = [];
    for (const realm of (getContent().realms || [])) {
      if (!unlockedRealms.includes(realm.slug)) continue;
      if (realm.portalFromLocation === locationSlug && realm.portalToLocation) portals.push(realm.portalToLocation);
      if (realm.portalToLocation === locationSlug && realm.portalFromLocation) portals.push(realm.portalFromLocation);
    }
    return portals;
  }

  // ─── STATIC PAGES ──────────────────────────────────────────

  app.get('/fantasy-rpg', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(path.join(__dirname, '..', 'public', 'fantasy-rpg.html'));
  });

  app.get('/leaderboard', (_req, res) => {
    return res.sendFile(path.join(__dirname, '..', 'public', 'leaderboard.html'));
  });

  // ─── STATE ─────────────────────────────────────────────────

  app.get('/api/fantasy/state', requireAuth, async (req, res) => {
    try {
      if (!req.session.activeCharId) {
        const chars = await getCharList(req.session.userId);
        if (chars.length) req.session.activeCharId = chars[0].id;
      }
      const state = await buildState(req.session.userId, req.session.activeCharId);
      if (req.session.activeCharId) {
        const shopModule = require('./shop');
        state.buyback = shopModule.getBuyback(req.session.activeCharId);
      }
      res.json({ ok: true, state });
    } catch (e) { console.error('STATE ERROR:', e.message, e.stack); res.status(500).json({ error: 'Failed to load state.' }); }
  });

  // ─── CREATE ────────────────────────────────────────────────

  app.post('/api/fantasy/create', requireAuth, validate(schemas.createChar), async (req, res) => {
    try {
      const userId = req.session.userId;
      const charCount = (await q('SELECT COUNT(*)::int as cnt FROM fantasy_characters WHERE user_id = $1', [userId]))[0]?.cnt || 0;
      if (charCount >= 10) return res.status(400).json({ error: 'Maximum 10 characters per account.' });
      const { name, race, class: cls } = req.body;
      if (!name || name.length < 1 || name.length > 24) return res.status(400).json({ error: 'Name must be 1-24 characters.' });
      if (!RACES.find(r => r.slug === race)) return res.status(400).json({ error: 'Invalid race.' });
      const classDef = CLASSES.find(c => c.slug === cls);
      if (!classDef) return res.status(400).json({ error: 'Invalid class.' });
      const hp = classDef.baseHp;
      const mp = classDef.baseMp;
      const startingGold = 120;
      const char = await q1(
        `INSERT INTO fantasy_characters (user_id, name, race, class, hp, max_hp, mp, max_mp, gold)
         VALUES ($1, $2, $3, $4, $5, $5, $6, $6, $7) RETURNING *`,
        [userId, name.trim(), race, cls, hp, mp, startingGold]
      );
      req.session.activeCharId = char.id;
      await addItem(char.id, 'health-potion', 3);
      await addItem(char.id, 'mana-potion', 2);
      // Class-appropriate starter weapon — auto-equipped
      const starterWeapons = { warrior: 'rusty-sword', mage: 'apprentice-wand', rogue: 'thief-stiletto', cleric: 'pilgrim-mace', ranger: 'ashwood-bow' };
      const starterWeapon = starterWeapons[cls] || 'rusty-sword';
      const maxDur = ctx.getMaxDurability(starterWeapon);
      await db.query('INSERT INTO fantasy_equipment (char_id, slot, item_slug, durability) VALUES ($1, $2, $3, $4)', [char.id, 'weapon', starterWeapon, maxDur]);
      await addLog(char.id, 'story', `⚔ ${name} the ${RACES.find(r=>r.slug===race).name} ${classDef.name} arrives in Thornwall Village. The adventure begins.`);
      const state = await buildState(userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error('CREATE ERROR:', e.message, e.stack); res.status(500).json({ error: 'Character creation failed: ' + e.message }); }
  });

  // ─── TRAVEL ────────────────────────────────────────────────

  app.post('/api/fantasy/travel', requireAuth, validate(schemas.travel), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot travel during combat.' });
      if (char.raid_state) return res.status(400).json({ error: 'Cannot travel during a raid. Fight or forfeit.' });
      if (char.party_id) {
        const p = await q1('SELECT state FROM fantasy_parties WHERE id=$1', [char.party_id]);
        if (p && p.state === 'in_raid') return res.status(400).json({ error: 'Cannot travel during a raid. Fight or forfeit.' });
      }
      const { destination } = req.body;
      const loc = getContent().locations.find(l => l.slug === char.location);
      const dest = getContent().locations.find(l => l.slug === destination);
      if (!dest) return res.status(400).json({ error: 'Unknown destination.' });
      // Realm gate: check if destination realm is unlocked
      const unlockedRealms = char.unlocked_realms || ['ashlands'];
      if (dest.realm && !unlockedRealms.includes(dest.realm)) {
        return res.status(400).json({ error: `You haven't unlocked ${dest.realm} yet. Complete the portal quest first.` });
      }
      // Build connections including portal links
      const baseConnections = loc?.connections || [];
      const portalConnections = getPortalConnections(char.location, unlockedRealms);
      const allConnections = [...baseConnections, ...portalConnections];
      const canTravelDirectlyHome = destination === HOME_LOCATION;
      if (!canTravelDirectlyHome && !allConnections.includes(destination)) {
        return res.status(400).json({ error: 'Cannot travel there from here.' });
      }
      await withTransaction(async (tx) => {
        await tx.query('UPDATE fantasy_characters SET location = $1, dungeon_state = NULL, event_state = NULL, arena_state = NULL, raid_state = NULL WHERE id = $2', [destination, char.id]);
        await addLog(char.id, 'travel', `🗺 You travel to ${dest.name}. ${dest.description}`, tx);
        const destHasShop = !!(getContent().shopItems[destination]?.length);
        if (destHasShop) {
          const junkRows = await q('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND junk=TRUE', [char.id], tx);
          if (junkRows.length > 0) {
            let totalGold = 0;
            const soldNames = [];
            for (const row of junkRows) {
              const item = getContent().items[row.item_slug];
              const sellPrice = (item?.sell || 1) * row.quantity;
              totalGold += sellPrice;
              soldNames.push(`${item?.name || row.item_slug}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`);
              await tx.query('DELETE FROM fantasy_inventory WHERE id=$1', [row.id]);
            }
            await tx.query('UPDATE fantasy_characters SET gold=gold+$1 WHERE id=$2', [totalGold, char.id]);
            await addLog(char.id, 'shop', `🗑 Merchant buys your junk: ${soldNames.join(', ')}. +${totalGold} gold.`, tx);
          }
        }
      });
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Travel failed.' }); }
  });

  app.post('/api/fantasy/travel-path', requireAuth, validate(schemas.travelPath), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot travel during combat.' });
      if (char.raid_state) return res.status(400).json({ error: 'Cannot travel during a raid. Fight or forfeit.' });
      if (char.party_id) {
        const p = await q1('SELECT state FROM fantasy_parties WHERE id=$1', [char.party_id]);
        if (p && p.state === 'in_raid') return res.status(400).json({ error: 'Cannot travel during a raid. Fight or forfeit.' });
      }
      const { destination } = req.body;
      const locations = getContent().locations;
      const dest = locations.find(l => l.slug === destination);
      if (!dest) return res.status(400).json({ error: 'Unknown destination.' });
      if (char.location === destination) return res.status(400).json({ error: 'You are already here.' });
      const unlockedRealms = char.unlocked_realms || ['ashlands'];
      if (dest.realm && !unlockedRealms.includes(dest.realm)) {
        return res.status(400).json({ error: `You haven't unlocked ${dest.realm} yet. Complete the portal quest first.` });
      }

      // Build adjacency map including portal connections
      const adjMap = {};
      for (const loc of locations) adjMap[loc.slug] = [...(loc.connections || [])];
      // Inject portal connections for unlocked realms
      for (const realm of (getContent().realms || [])) {
        if (realm.portalFromLocation && realm.portalToLocation && unlockedRealms.includes(realm.slug)) {
          if (adjMap[realm.portalFromLocation]) adjMap[realm.portalFromLocation].push(realm.portalToLocation);
          if (adjMap[realm.portalToLocation]) adjMap[realm.portalToLocation].push(realm.portalFromLocation);
        }
      }
      for (const slug of Object.keys(adjMap)) {
        if (slug !== HOME_LOCATION && !adjMap[slug].includes(HOME_LOCATION)) {
          adjMap[slug] = [...adjMap[slug], HOME_LOCATION];
        }
      }

      const queue = [[char.location]];
      const visited = new Set([char.location]);
      let pathResult = null;
      while (queue.length > 0) {
        const current = queue.shift();
        const lastNode = current[current.length - 1];
        if (lastNode === destination) { pathResult = current; break; }
        for (const neighbor of (adjMap[lastNode] || [])) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push([...current, neighbor]);
          }
        }
      }

      if (!pathResult || pathResult.length < 2) return res.status(400).json({ error: 'No path exists to that destination.' });

      const hops = pathResult.slice(1);
      const hopNames = hops.map(slug => locations.find(l => l.slug === slug)?.name || slug);
      const finalDest = locations.find(l => l.slug === hops[hops.length - 1]);

      await withTransaction(async (tx) => {
        await tx.query('UPDATE fantasy_characters SET location = $1, dungeon_state = NULL, event_state = NULL, arena_state = NULL, raid_state = NULL WHERE id = $2', [destination, char.id]);
        if (hops.length === 1) {
          await addLog(char.id, 'travel', `🗺 You travel to ${finalDest.name}. ${finalDest.description}`, tx);
        } else {
          await addLog(char.id, 'travel', `🗺 You journey through ${hopNames.slice(0, -1).join(' → ')} and arrive at ${finalDest.name}. ${finalDest.description}`, tx);
        }
        const destHasShop = !!(getContent().shopItems[destination]?.length);
        if (destHasShop) {
          const junkRows = await q('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND junk=TRUE', [char.id], tx);
          if (junkRows.length > 0) {
            let totalGold = 0;
            const soldNames = [];
            for (const row of junkRows) {
              const item = getContent().items[row.item_slug];
              const sellPrice = (item?.sell || 1) * row.quantity;
              totalGold += sellPrice;
              soldNames.push(`${item?.name || row.item_slug}${row.quantity > 1 ? ` ×${row.quantity}` : ''}`);
              await tx.query('DELETE FROM fantasy_inventory WHERE id=$1', [row.id]);
            }
            await tx.query('UPDATE fantasy_characters SET gold=gold+$1 WHERE id=$2', [totalGold, char.id]);
            await addLog(char.id, 'shop', `🗑 Merchant buys your junk: ${soldNames.join(', ')}. +${totalGold} gold.`, tx);
          }
        }
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, path: hops, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Travel failed.' }); }
  });

  // ─── RESET / SWITCH / NEW CHARACTER ──────────────────────

  app.post('/api/fantasy/reset', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const char = await getChar(userId, req.session.activeCharId);
      if (char) {
        const inDuel = await q1("SELECT id FROM fantasy_duels WHERE state = 'active' AND (challenger_id = $1 OR defender_id = $1)", [char.id]);
        if (inDuel) return res.status(400).json({ error: 'Cannot delete a character in an active duel.' });
        await db.query('DELETE FROM fantasy_game_log WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_quests WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_equipment WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_inventory WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_home_storage WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_known_recipes WHERE char_id=$1', [char.id]);
        // Clean up progression & social data
        await db.query('DELETE FROM fantasy_bounty_progress WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_arena_runs WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_codex WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_achievements WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_weekly_progress WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_raid_runs WHERE char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_friends WHERE char_id=$1 OR friend_char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_party_invites WHERE from_char_id=$1 OR to_char_id=$1', [char.id]);
        await db.query('DELETE FROM fantasy_party_members WHERE char_id=$1', [char.id]);
        // Cancel active auction listings (return items already removed with inventory)
        await db.query("UPDATE fantasy_auction_listings SET state='cancelled' WHERE seller_id=$1 AND state='active'", [char.id]);
        // Arena store
        await db.query('DELETE FROM fantasy_arena_store WHERE char_id=$1', [char.id]);
        // Finally delete the character
        await db.query('DELETE FROM fantasy_characters WHERE id=$1', [char.id]);
      }
      req.session.activeCharId = null;
      const remaining = await getCharList(userId);
      if (remaining.length) req.session.activeCharId = remaining[0].id;
      const state = await buildState(userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Reset failed.' }); }
  });

  app.post('/api/fantasy/switch-character', requireAuth, validate(schemas.switchChar), async (req, res) => {
    try {
      const userId = req.session.userId;
      const { charId } = req.body;
      const char = await q1('SELECT * FROM fantasy_characters WHERE id = $1 AND user_id = $2', [charId, userId]);
      if (!char) return res.status(400).json({ error: 'Character not found.' });
      const currentChar = await getChar(userId, req.session.activeCharId);
      if (currentChar?.in_combat) return res.status(400).json({ error: 'Cannot switch characters during combat.' });
      if (currentChar) {
        const inDuel = await q1("SELECT id FROM fantasy_duels WHERE state = 'active' AND (challenger_id = $1 OR defender_id = $1)", [currentChar.id]);
        if (inDuel) return res.status(400).json({ error: 'Cannot switch characters during an active duel.' });
      }
      req.session.activeCharId = char.id;
      const state = await buildState(userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Switch failed.' }); }
  });

  app.post('/api/fantasy/new-character', requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      const currentChar = await getChar(userId, req.session.activeCharId);
      if (currentChar?.in_combat) return res.status(400).json({ error: 'Cannot create a new character during combat.' });
      req.session.activeCharId = null;
      const state = await buildState(userId, null);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
  });
}

module.exports = { register };
