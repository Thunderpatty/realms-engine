// ═══════════════════════════════════════════════════════════════
// ARENA — Horde mode wave survival with Arena Points currency
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');
// Arena available at all towns (dynamic based on content)
function isArenaTown(location, getContent) {
  const loc = (getContent().locations || []).find(l => l.slug === location);
  return loc?.type === 'town';
}

// Static fallback pools + dynamic pool builder
const ARENA_POOLS_STATIC = {
  thornwall: ['whispering-woods', 'kings-road'],
  ironhold: ['crossroads', 'shadowfen', 'dark-hollow'],
  sunspire: ['ember-mines', 'witch-tower', 'dragon-peak'],
};
function getArenaPool(location, getContent) {
  if (ARENA_POOLS_STATIC[location]) return ARENA_POOLS_STATIC[location];
  // Dynamic: collect all connected non-town zones (BFS 2 hops)
  const locs = getContent().locations || [];
  const loc = locs.find(l => l.slug === location);
  if (!loc) return [];
  const pool = new Set();
  for (const conn of (loc.connections || [])) {
    const cl = locs.find(l => l.slug === conn);
    if (cl && cl.type !== 'town') pool.add(conn);
    if (cl) for (const c2 of (cl.connections || [])) { const c2l = locs.find(l => l.slug === c2); if (c2l && c2l.type !== 'town') pool.add(c2); }
  }
  return [...pool];
}

// AP per wave: floor(3 + wave*1.2 + wave²*0.05)
function waveAp(wave) {
  return Math.floor(3 + (wave * 1.2) + (wave * wave * 0.05));
}

// Stat scale factor for arena enemies
function waveStatScale(wave) {
  if (wave <= 5) return 1.0;
  if (wave <= 10) return 1.0 + (wave - 5) * 0.04;   // up to 1.20
  if (wave <= 15) return 1.20 + (wave - 10) * 0.06;  // up to 1.50
  if (wave <= 20) return 1.50 + (wave - 15) * 0.08;  // up to 1.90
  return 1.90 + (wave - 20) * 0.05;                   // keeps growing
}

function waveLevelBonus(wave) {
  if (wave <= 5) return 0;
  if (wave <= 10) return 1;
  if (wave <= 15) return 2;
  if (wave <= 20) return 3;
  return 3 + Math.floor((wave - 20) / 5);
}

// Arena store pricing
const STORE_PRICES = {
  common:    { buy: 40,   reroll: 15 },
  uncommon:  { buy: 120,  reroll: 45 },
  rare:      { buy: 350,  reroll: 120 },
  epic:      { buy: 900,  reroll: 350 },
  legendary: { buy: 2200, reroll: 800 },
  mythic:    { buy: 5500, reroll: 2000 },
};
const STORE_RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

function register(app, requireAuth, ctx) {
  const { db, q, q1, getChar, addLog, buildState, getContent, rand,
    pickEncounterForLocation, buildScaledEnemy, rollPerks, getPerkPrefix,
    addItem, EQUIPMENT_SLOTS } = ctx;

  // ─── ENTER ARENA ───
  app.post('/api/fantasy/arena/enter', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot enter arena during combat.' });
      if (char.arena_state) return res.status(400).json({ error: 'Already in an arena run.' });
      if (char.dungeon_state) return res.status(400).json({ error: 'Cannot enter arena during a dungeon run.' });
      if (char.raid_state) return res.status(400).json({ error: 'Cannot enter arena during a raid.' });
      if (char.party_id) return res.status(400).json({ error: 'Cannot enter arena while in a party.' });
      if (!isArenaTown(char.location, getContent)) return res.status(400).json({ error: 'No arena here.' });

      const arenaState = { wave: 0, ap: 0, apBonusActive: false, betweenWaves: true, location: char.location, choiceMade: true };
      await db.query('UPDATE fantasy_characters SET arena_state=$1, event_state=NULL WHERE id=$2', [JSON.stringify(arenaState), char.id]);
      await addLog(char.id, 'combat', `🏟 Entered the Arena at ${char.location}!`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Arena enter failed.' }); }
  });

  // ─── NEXT WAVE ───
  app.post('/api/fantasy/arena/next-wave', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.arena_state) return res.status(400).json({ error: 'Not in an arena run.' });
      if (char.in_combat) return res.status(400).json({ error: 'Already in combat.' });
      const as = char.arena_state;
      if (!as.betweenWaves) return res.status(400).json({ error: 'Not between waves.' });

      as.wave = (as.wave || 0) + 1;
      as.betweenWaves = false;
      as.choiceMade = false;

      const wave = as.wave;
      const isBossWave = wave % 5 === 0;
      const pools = getArenaPool(as.location, getContent);

      // Pick enemy from appropriate pool
      const allEnemies = [];
      for (const zone of pools) {
        const zoneEnemies = getContent().enemies[zone] || [];
        allEnemies.push(...zoneEnemies.map(e => ({ ...e, _zone: zone })));
      }
      if (!allEnemies.length) return res.status(500).json({ error: 'No enemies available.' });

      let enemy;
      if (isBossWave) {
        const bosses = allEnemies.filter(e => e.boss);
        enemy = bosses.length ? bosses[rand(0, bosses.length - 1)] : allEnemies[rand(0, allEnemies.length - 1)];
      } else {
        const nonBoss = allEnemies.filter(e => !e.boss);
        const pool = nonBoss.length ? nonBoss : allEnemies;
        enemy = pool[rand(0, pool.length - 1)];
      }

      // Elite chance scales with wave: 5% + wave*0.5%, capped at 25%
      const arenaEliteChance = Math.min(25, 5 + wave * 0.5);
      const isElite = !isBossWave && rand(1, 100) <= arenaEliteChance;
      // Scale enemy for arena
      const combatEnemy = buildScaledEnemy(enemy, char.level + waveLevelBonus(wave), enemy._zone, { elite: isElite });
      const scale = waveStatScale(wave);
      combatEnemy.hp = Math.floor(combatEnemy.hp * scale);
      combatEnemy.maxHp = combatEnemy.hp;
      combatEnemy.attack = Math.floor(combatEnemy.attack * scale);
      combatEnemy.defense = Math.floor(combatEnemy.defense * scale);
      if (isBossWave) {
        combatEnemy.hp = Math.floor(combatEnemy.hp * 1.5);
        combatEnemy.maxHp = combatEnemy.hp;
      }

      combatEnemy.id = 'e0';
      combatEnemy.effects = [];
      const combatState = {
        enemies: [combatEnemy],
        allies: [],
        turn: 1,
        playerBuffs: [],
        playerEffects: [],
        playerTempPassives: [],
        cooldowns: {},
        log: [isBossWave
          ? `🔥 ARENA WAVE ${wave} — ELITE: ${combatEnemy.name} enters the arena!`
          : `⚔ ARENA WAVE ${wave}: ${combatEnemy.name} charges in!`],
        arenaRun: true,
        arenaWave: wave,
        isBossRoom: isBossWave,
      };

      await db.query('UPDATE fantasy_characters SET in_combat=TRUE, combat_state=$1, arena_state=$2 WHERE id=$3',
        [JSON.stringify(combatState), JSON.stringify(as), char.id]);
      await addLog(char.id, 'combat', `🏟 Arena Wave ${wave}${isBossWave ? ' (ELITE)' : ''}: ${combatEnemy.name}`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Next wave failed.' }); }
  });

  // ─── BETWEEN-WAVE CHOICE ───
  app.post('/api/fantasy/arena/choice', requireAuth, validate(schemas.arenaChoice), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.arena_state) return res.status(400).json({ error: 'Not in an arena run.' });
      const as = char.arena_state;
      if (!as.betweenWaves) return res.status(400).json({ error: 'Not between waves.' });
      if (as.choiceMade) return res.status(400).json({ error: 'Choice already made this wave.' });

      const { choice } = req.body; // 'healHp' | 'restoreMp' | 'apBonus'
      let msg;
      if (choice === 'healHp') {
        const healAmt = Math.floor(char.max_hp * 0.30);
        char.hp = Math.min(char.max_hp, char.hp + healAmt);
        msg = `🩸 Restored ${healAmt} HP (${char.hp}/${char.max_hp})`;
      } else if (choice === 'restoreMp') {
        const manaAmt = Math.floor(char.max_mp * 0.30);
        char.mp = Math.min(char.max_mp, char.mp + manaAmt);
        msg = `💜 Restored ${manaAmt} MP (${char.mp}/${char.max_mp})`;
      } else if (choice === 'apBonus') {
        as.apBonusActive = true;
        msg = `⭐ Next wave AP bonus active (+50%)`;
      } else {
        return res.status(400).json({ error: 'Invalid choice.' });
      }

      as.choiceMade = true;
      await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2, arena_state=$3 WHERE id=$4',
        [char.hp, char.mp, JSON.stringify(as), char.id]);
      await addLog(char.id, 'combat', `🏟 ${msg}`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, message: msg });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Choice failed.' }); }
  });

  // ─── LEAVE ARENA (forfeit) ───
  app.post('/api/fantasy/arena/leave', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.arena_state) return res.status(400).json({ error: 'Not in an arena run.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot leave during combat. Fight or fall.' });
      const as = char.arena_state;
      const totalAp = as.ap || 0;
      char.arena_points = (char.arena_points || 0) + totalAp;
      await db.query('INSERT INTO fantasy_arena_runs (char_id, wave_reached, ap_earned, location_slug, ended_at) VALUES ($1,$2,$3,$4,NOW())',
        [char.id, as.wave || 0, totalAp, as.location]);
      await db.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, arena_state=NULL, arena_points=$1 WHERE id=$2',
        [char.arena_points, char.id]);
      await addLog(char.id, 'combat', `🏟 Left the Arena after Wave ${as.wave || 0}. Earned ${totalAp} AP.`);
      // Achievement: arena-best-wave
      if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'arena-best-wave', as.wave || 0);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, waveReached: as.wave || 0, apEarned: totalAp });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Leave failed.' }); }
  });

  // ─── ARENA LEADERBOARD ───
  app.get('/api/fantasy/arena/leaderboard', requireAuth, async (req, res) => {
    try {
      const rows = await q(`
        SELECT ar.wave_reached, ar.ap_earned, ar.ended_at, fc.name, fc.level, fc.class, fc.race
        FROM fantasy_arena_runs ar
        JOIN fantasy_characters fc ON fc.id = ar.char_id
        ORDER BY ar.wave_reached DESC, ar.ap_earned DESC
        LIMIT 20
      `);
      res.json({ ok: true, leaderboard: rows });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Leaderboard failed.' }); }
  });

  // ─── ARENA STORE ───
  function generateStoreSlots() {
    const slots = [];
    for (const rarity of STORE_RARITIES) {
      const allItems = Object.entries(getContent().items)
        .filter(([, item]) => item.rarity === rarity && EQUIPMENT_SLOTS.includes(item.type))
        .map(([slug, item]) => ({ slug, ...item }));
      if (!allItems.length) { slots.push(null); continue; }
      const picked = allItems[rand(0, allItems.length - 1)];
      const perks = rollPerks(rarity, picked);
      const displayName = perks ? (getPerkPrefix(perks) + ' ' + picked.name) : picked.name;
      slots.push({ slug: picked.slug, name: displayName, baseName: picked.name, rarity, type: picked.type, stats: picked.stats, description: picked.description, perks, cost: STORE_PRICES[rarity].buy });
    }
    return slots;
  }

  async function getOrCreateStore(charId) {
    let store = await q1('SELECT * FROM fantasy_arena_store WHERE char_id = $1', [charId]);
    const now = new Date();
    if (!store) {
      const slots = generateStoreSlots();
      await db.query('INSERT INTO fantasy_arena_store (char_id, slots, last_reroll, free_reroll_used) VALUES ($1,$2,$3,FALSE)',
        [charId, JSON.stringify(slots), now]);
      return { slots, lastReroll: now, freeRerollUsed: false };
    }
    // Check for daily refresh (midnight CST = UTC-6)
    const lastReroll = new Date(store.last_reroll);
    const cstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const cstLast = new Date(lastReroll.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const dayChanged = cstNow.toDateString() !== cstLast.toDateString();
    if (dayChanged) {
      const slots = generateStoreSlots();
      await db.query('UPDATE fantasy_arena_store SET slots=$1, last_reroll=$2, free_reroll_used=FALSE WHERE char_id=$3',
        [JSON.stringify(slots), now, charId]);
      return { slots, lastReroll: now, freeRerollUsed: false };
    }
    const slots = typeof store.slots === 'string' ? JSON.parse(store.slots) : store.slots;
    return { slots, lastReroll: store.last_reroll, freeRerollUsed: store.free_reroll_used };
  }

  app.post('/api/fantasy/arena/store', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isArenaTown(char.location, getContent)) return res.status(400).json({ error: 'No arena store here.' });
      const store = await getOrCreateStore(char.id);
      const rerollCost = store.freeRerollUsed
        ? STORE_RARITIES.reduce((sum, r) => sum + STORE_PRICES[r].reroll, 0)
        : 0;
      res.json({ ok: true, store: store.slots, rerollCost, freeRerollAvailable: !store.freeRerollUsed, arenaPoints: char.arena_points || 0, prices: STORE_PRICES });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Store failed.' }); }
  });

  app.post('/api/fantasy/arena/store/buy', requireAuth, validate(schemas.arenaStoreBuy), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { slotIndex } = req.body;
      const store = await getOrCreateStore(char.id);
      const slot = store.slots[slotIndex];
      if (!slot) return res.status(400).json({ error: 'Slot is empty or invalid.' });
      if ((char.arena_points || 0) < slot.cost) return res.status(400).json({ error: `Not enough Arena Points (need ${slot.cost}).` });

      // Deduct AP
      const apResult = await db.query('UPDATE fantasy_characters SET arena_points = arena_points - $1 WHERE id = $2 AND arena_points >= $1 RETURNING arena_points', [slot.cost, char.id]);
      if (apResult.rowCount === 0) return res.status(400).json({ error: `Not enough Arena Points (need ${slot.cost}).` });
      char.arena_points = apResult.rows[0].arena_points;

      // Add item to inventory
      await addItem(char.id, slot.slug, 1, slot.perks || null);

      // Empty the slot
      store.slots[slotIndex] = null;
      await db.query('UPDATE fantasy_arena_store SET slots=$1 WHERE char_id=$2', [JSON.stringify(store.slots), char.id]);

      await addLog(char.id, 'shop', `🏟 Purchased ${slot.name} from Arena Store for ${slot.cost} AP.`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, store: store.slots });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Buy failed.' }); }
  });

  // Reroll ALL slots (free daily or paid)
  app.post('/api/fantasy/arena/store/reroll', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const store = await getOrCreateStore(char.id);
      const isFree = !store.freeRerollUsed;
      const rerollCost = isFree ? 0 : STORE_RARITIES.reduce((sum, r) => sum + STORE_PRICES[r].reroll, 0);

      if (!isFree && (char.arena_points || 0) < rerollCost) {
        return res.status(400).json({ error: `Not enough Arena Points (need ${rerollCost}).` });
      }

      if (!isFree) {
        const apRes = await db.query('UPDATE fantasy_characters SET arena_points = arena_points - $1 WHERE id = $2 AND arena_points >= $1 RETURNING arena_points', [rerollCost, char.id]);
        if (apRes.rowCount === 0) return res.status(400).json({ error: `Not enough Arena Points (need ${rerollCost}).` });
        char.arena_points = apRes.rows[0].arena_points;
      }

      const newSlots = generateStoreSlots();
      await db.query('UPDATE fantasy_arena_store SET slots=$1, last_reroll=NOW(), free_reroll_used=TRUE WHERE char_id=$2',
        [JSON.stringify(newSlots), char.id]);

      await addLog(char.id, 'shop', `🏟 Rerolled Arena Store${isFree ? ' (free daily reroll)' : ` for ${rerollCost} AP`}.`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, store: newSlots, freeRerollAvailable: false, arenaPoints: char.arena_points, prices: STORE_PRICES });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Reroll failed.' }); }
  });

  // Reroll a SINGLE rarity slot
  app.post('/api/fantasy/arena/store/reroll-slot', requireAuth, validate(schemas.arenaRerollSlot), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { slotIndex } = req.body;
      if (slotIndex == null || slotIndex < 0 || slotIndex >= STORE_RARITIES.length) return res.status(400).json({ error: 'Invalid slot.' });
      const rarity = STORE_RARITIES[slotIndex];
      const cost = STORE_PRICES[rarity].reroll;
      const store = await getOrCreateStore(char.id);

      if ((char.arena_points || 0) < cost) {
        return res.status(400).json({ error: `Not enough Arena Points (need ${cost}).` });
      }

      const apRes2 = await db.query('UPDATE fantasy_characters SET arena_points = arena_points - $1 WHERE id = $2 AND arena_points >= $1 RETURNING arena_points', [cost, char.id]);
      if (apRes2.rowCount === 0) return res.status(400).json({ error: `Not enough Arena Points (need ${cost}).` });
      char.arena_points = apRes2.rows[0].arena_points;

      // Regenerate just this slot
      const allItems = Object.entries(getContent().items)
        .filter(([, item]) => item.rarity === rarity && EQUIPMENT_SLOTS.includes(item.type))
        .map(([slug, item]) => ({ slug, ...item }));
      if (allItems.length) {
        const picked = allItems[rand(0, allItems.length - 1)];
        const perks = rollPerks(rarity, picked);
        const displayName = perks ? (getPerkPrefix(perks) + ' ' + picked.name) : picked.name;
        store.slots[slotIndex] = { slug: picked.slug, name: displayName, baseName: picked.name, rarity, type: picked.type, stats: picked.stats, description: picked.description, perks, cost: STORE_PRICES[rarity].buy };
      }

      await db.query('UPDATE fantasy_arena_store SET slots=$1 WHERE char_id=$2', [JSON.stringify(store.slots), char.id]);
      await addLog(char.id, 'shop', `🏟 Rerolled ${rarity} slot for ${cost} AP.`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, store: store.slots, arenaPoints: char.arena_points, prices: STORE_PRICES });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Slot reroll failed.' }); }
  });
}

module.exports = { register };
