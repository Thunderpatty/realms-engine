// ═══════════════════════════════════════════════════════════════
// EXPLORATION — Explore, Dungeon, Events
// Extracted from fantasy-rpg.js (Tier 2A.6)
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');

function register(app, requireAuth, ctx) {
  const {
    db, q, getChar, addLog, addItem, buildState, buildPatch, getContent,
    rand, getEquipment, computeStats, xpForLevel,
    isExploreGated, pickEncounterForLocation, buildScaledEnemy, buildCompanionAlly,
    removeEffect, getRespawnLocation,
  } = ctx;

  function spawnAllies(char) {
    const allies = [];
    const comp = buildCompanionAlly(char);
    if (comp) allies.push(comp);
    return allies;
  }

  // ─── EXPLORE (with quest-gating and dungeon system) ────────

  app.post('/api/fantasy/explore', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Already in combat.' });
      if (char.raid_state) return res.status(400).json({ error: 'Cannot explore during a raid.' });
      if (char.party_id) return res.status(400).json({ error: 'Cannot explore while in a party.' });

      const loc = getContent().locations.find(l => l.slug === char.location);
      const isDungeon = loc?.type === 'dungeon';
      const dungeonConfig = getContent().dungeonConfig[char.location];

      // ── DUNGEON EXPLORE ──
      if (isDungeon && dungeonConfig) {
        let ds = char.dungeon_state;

        if (!ds || ds.dungeon !== char.location) {
          const totalRooms = rand(dungeonConfig.minRooms, dungeonConfig.maxRooms);
          ds = { dungeon: char.location, totalRooms, currentRoom: 1, roomsCleared: 0 };
          await addLog(char.id, 'dungeon', `🏰 Entering ${dungeonConfig.name}... ${totalRooms} chambers lie ahead.`);
        } else {
          ds.currentRoom = ds.roomsCleared + 1;
        }

        const isBossRoom = ds.currentRoom >= ds.totalRooms;
        let enemy;

        const dungeonBountyRows = await q(
          `SELECT b.enemy_slug FROM fantasy_bounty_progress bp
           JOIN fantasy_bounties b ON b.id = bp.bounty_id
           WHERE bp.char_id = $1 AND bp.claimed = FALSE AND b.area_slug = $2`,
          [char.id, char.location]
        );
        const dungeonBountyTargets = dungeonBountyRows.map(r => r.enemy_slug);

        if (isBossRoom) {
          const locEnemies = getContent().enemies[char.location] || [];
          enemy = locEnemies.find(e => e.slug === dungeonConfig.boss) || locEnemies.find(e => e.boss);
          if (!enemy) enemy = pickEncounterForLocation(char.location, char.level, dungeonBountyTargets);
        } else {
          const nonBossPool = (getContent().enemies[char.location] || []).filter(e => !e.boss);
          if (nonBossPool.length === 0) return res.status(400).json({ error: 'No enemies here.' });
          const bountyInDungeon = nonBossPool.filter(e => dungeonBountyTargets.includes(e.slug));
          if (bountyInDungeon.length > 0 && Math.random() < 0.35) {
            enemy = bountyInDungeon[rand(0, bountyInDungeon.length - 1)];
          } else {
            enemy = nonBossPool[rand(0, nonBossPool.length - 1)];
          }
        }

        // ── Dungeon mechanic: room-entry effects ──
        const mechanic = dungeonConfig.mechanic;
        const roomLog = [];
        if (mechanic && !isBossRoom) {
          if (mechanic.effect.roomDamagePct) {
            const dmg = Math.max(1, Math.floor(char.max_hp * mechanic.effect.roomDamagePct / 100));
            char.hp = Math.max(1, char.hp - dmg);
            roomLog.push(`☠ ${mechanic.name}: You take ${dmg} damage from the cursed ground.`);
          }
          if (mechanic.effect.caveInChance && rand(1, 100) <= mechanic.effect.caveInChance) {
            const strMod = Math.floor((char.str || 10) - 10) / 2;
            const roll = rand(1, 20) + strMod;
            if (roll >= (mechanic.effect.caveInDC || 12)) {
              roomLog.push(`🪨 Cave-in! You brace against the falling rocks and avoid injury. (DC ${mechanic.effect.caveInDC}, rolled ${Math.floor(roll)})`);
            } else {
              const dmg = Math.max(1, Math.floor(char.max_hp * 0.08) + rand(1, 5));
              char.hp = Math.max(1, char.hp - dmg);
              roomLog.push(`🪨 Cave-in! Rocks crash down on you for ${dmg} damage! (DC ${mechanic.effect.caveInDC}, rolled ${Math.floor(roll)})`);
            }
          }
          if (roomLog.length) {
            await db.query('UPDATE fantasy_characters SET hp=$1 WHERE id=$2', [char.hp, char.id]);
          }
        }

        const isElite = !isBossRoom && !enemy.boss && rand(1, 100) <= 5;
        const combatEnemy = buildScaledEnemy(enemy, char.level, char.location, { elite: isElite });
        const enemyLabel = isElite ? `⭐ Elite ${enemy.name}` : enemy.name;
        const combatLog = [
          ...roomLog,
          isBossRoom
            ? `🔥 BOSS — Room ${ds.currentRoom}/${ds.totalRooms}: ${enemy.name} blocks the way!`
            : `⚔ Room ${ds.currentRoom}/${ds.totalRooms}: ${isElite ? '⭐ An Elite ' : 'A '}${enemy.name} lurches from the shadows!`,
        ];
        if (mechanic && !roomLog.length) {
          combatLog.unshift(`⚠ ${mechanic.name}: ${mechanic.description}`);
        }
        combatEnemy.id = 'e0';
        combatEnemy.effects = [];
        const combatState = {
          enemies: [combatEnemy],
          allies: spawnAllies(char),
          turn: 1,
          playerBuffs: [],
          playerEffects: [],
          playerTempPassives: [],
          cooldowns: {},
          log: combatLog,
          dungeonRun: true,
          isBossRoom,
          dungeonMechanic: mechanic?.slug || null,
        };

        await db.query('UPDATE fantasy_characters SET in_combat=TRUE, combat_state=$1, dungeon_state=$2 WHERE id=$3',
          [JSON.stringify(combatState), JSON.stringify(ds), char.id]);
        await addLog(char.id, 'dungeon', isBossRoom
          ? `🔥 BOSS: ${enemy.name} in ${dungeonConfig.name}! (Room ${ds.currentRoom}/${ds.totalRooms})`
          : `⚔ Room ${ds.currentRoom}/${ds.totalRooms}: Encountered ${enemy.name}`);

        const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
        return res.json({ ok: true, patch });
      }

      // ── WILD / NORMAL EXPLORE ──
      const locEnemies = getContent().enemies[char.location];
      if (!locEnemies || locEnemies.length === 0) return res.status(400).json({ error: 'Nothing to fight here. This is a safe location.' });

      const gated = await isExploreGated(char.id, char.location, char.level);
      if (gated) {
        return res.status(400).json({ error: 'Complete available quests at this location before exploring freely.' });
      }

      const activeBountyRows = await q(
        `SELECT b.enemy_slug FROM fantasy_bounty_progress bp
         JOIN fantasy_bounties b ON b.id = bp.bounty_id
         WHERE bp.char_id = $1 AND bp.claimed = FALSE AND b.area_slug = $2`,
        [char.id, char.location]
      );
      const bountyTargets = activeBountyRows.map(r => r.enemy_slug);

      // ── EXPLORATION EVENT ROLL ──
      const locationEvents = getContent().exploreEvents?.[char.location] || [];
      if (locationEvents.length > 0 && !char.event_state) {
        const eventRoll = Math.random();
        const eventChance = 0.22;
        if (eventRoll < eventChance) {
          const rarityWeight = { common: 60, uncommon: 25, rare: 15 };
          const weighted = [];
          for (const ev of locationEvents) {
            const w = rarityWeight[ev.rarity] || rarityWeight.common;
            for (let i = 0; i < w; i++) weighted.push(ev);
          }
          const picked = weighted[rand(0, weighted.length - 1)];
          const eventState = { slug: picked.slug, location: char.location };
          await db.query('UPDATE fantasy_characters SET event_state = $1 WHERE id = $2', [JSON.stringify(eventState), char.id]);
          await addLog(char.id, 'quest', `${picked.icon || '✦'} ${picked.name} — a chance encounter in ${loc?.name || char.location}!`);
          // Achievement: events-encountered
          if (ctx.recordCodex) await ctx.recordCodex(char.id, 'event', picked.slug);
          if (ctx.checkAndAwardAchievements) {
            const totalEvents = await q('SELECT COALESCE(SUM(count),0)::int as total FROM fantasy_codex WHERE char_id=$1 AND category=$2', [char.id, 'event']);
            await ctx.checkAndAwardAchievements(char.id, 'events-encountered', totalEvents[0]?.total || 0);
          }
          const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'location', 'log']);
          return res.json({ ok: true, patch, event: true });
        }
      }

      // ── NORMAL COMBAT ──
      // 20% chance for group encounter if groups defined for this zone
      const zoneGroups = getContent().enemyGroups?.[char.location] || [];
      const locEnemiesAll = getContent().enemies[char.location] || [];
      const groupRoll = zoneGroups.length > 0 && rand(1, 100) <= 20;

      let combatState;
      if (groupRoll) {
        // Weighted random group selection
        const totalWeight = zoneGroups.reduce((s, g) => s + (g.spawnWeight || 10), 0);
        let roll = rand(1, totalWeight);
        let picked = zoneGroups[0];
        for (const g of zoneGroups) {
          roll -= (g.spawnWeight || 10);
          if (roll <= 0) { picked = g; break; }
        }
        // Build enemy array from composition
        const enemies = [];
        let eidx = 0;
        for (const comp of picked.composition) {
          const count = Array.isArray(comp.count) ? rand(comp.count[0], comp.count[1]) : comp.count;
          const baseDef = locEnemiesAll.find(e => e.slug === comp.enemySlug);
          if (!baseDef) continue;
          for (let i = 0; i < count; i++) {
            const isElite = rand(1, 100) <= 5;
            const scaled = buildScaledEnemy(baseDef, char.level, char.location, { elite: isElite });
            scaled.id = 'e' + eidx++;
            scaled.effects = [];
            enemies.push(scaled);
          }
        }
        if (enemies.length === 0) {
          // Fallback to single enemy if group resolution produced nothing
          const enemy = pickEncounterForLocation(char.location, char.level, bountyTargets);
          const scaled = buildScaledEnemy(enemy, char.level, char.location);
          scaled.id = 'e0'; scaled.effects = [];
          enemies.push(scaled);
        }
        const names = enemies.map(e => (e.elite ? '⭐ ' : '') + e.name);
        combatState = {
          enemies, allies: spawnAllies(char), turn: 1, playerBuffs: [], playerEffects: [],
          playerTempPassives: [], cooldowns: {},
          log: [`⚔ ${picked.name}! ${names.join(', ')} appear!`],
        };
        await db.query('UPDATE fantasy_characters SET in_combat = TRUE, combat_state = $1 WHERE id = $2',
          [JSON.stringify(combatState), char.id]);
        await addLog(char.id, 'combat', `⚔ Encountered a ${picked.name} in ${loc?.name || char.location}!`);
      } else {
        // Single enemy encounter
        const enemy = pickEncounterForLocation(char.location, char.level, bountyTargets);
        const isElite = !enemy.boss && rand(1, 100) <= 5;
        const combatEnemy = buildScaledEnemy(enemy, char.level, char.location, { elite: isElite });

        combatEnemy.id = 'e0';
        combatEnemy.effects = [];
        combatState = {
          enemies: [combatEnemy], allies: spawnAllies(char), turn: 1, playerBuffs: [],
          playerEffects: [], playerTempPassives: [], cooldowns: {},
          log: [`⚔ ${isElite ? '⭐ An Elite ' : 'A '}${enemy.name} appears! (Level ${enemy.level})`],
        };
        await db.query('UPDATE fantasy_characters SET in_combat = TRUE, combat_state = $1 WHERE id = $2',
          [JSON.stringify(combatState), char.id]);
        await addLog(char.id, 'combat', `⚔ Encountered ${isElite ? 'an ⭐ Elite ' : 'a '}${enemy.name} in ${loc?.name || char.location}!`);
      }
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Explore failed.' }); }
  });

  // ─── LEAVE DUNGEON ────────────────────────────────────────────

  app.post('/api/fantasy/dungeon/leave', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot leave during combat.' });
      if (!char.dungeon_state) return res.status(400).json({ error: 'Not in a dungeon run.' });
      const cfg = getContent().dungeonConfig[char.dungeon_state.dungeon];
      await db.query('UPDATE fantasy_characters SET dungeon_state=NULL WHERE id=$1', [char.id]);
      await addLog(char.id, 'dungeon', `🚪 You retreat from ${cfg?.name || 'the dungeon'}. Progress is lost.`);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to leave dungeon.' }); }
  });

  // ─── EXPLORATION EVENT RESOLUTION ──────────────────────────────

  app.post('/api/fantasy/event/resolve', requireAuth, validate(schemas.eventResolve), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot resolve event during combat.' });
      const es = char.event_state;
      if (!es || es.location !== char.location) return res.status(400).json({ error: 'No active event.' });
      if (es.resolved) return res.status(400).json({ error: 'Event already resolved.' });

      const { choiceIdx } = req.body;
      const events = getContent().exploreEvents?.[char.location] || [];
      const eventDef = events.find(e => e.slug === es.slug);
      if (!eventDef) {
        await db.query('UPDATE fantasy_characters SET event_state = NULL WHERE id = $1', [char.id]);
        return res.status(400).json({ error: 'Event not found.' });
      }

      const choice = eventDef.choices?.[choiceIdx];
      if (!choice) return res.status(400).json({ error: 'Invalid choice.' });

      let success = true;
      let rollInfo = null;
      if (choice.check && !choice.auto) {
        const equipment = await getEquipment(char.id);
        const stats = computeStats(char, equipment);
        const statVal = stats[choice.check.stat] || 10;
        const modifier = Math.floor((statVal - 10) / 2);
        const roll = rand(1, 20);
        const total = roll + modifier;
        success = total >= choice.check.dc;
        rollInfo = { stat: choice.check.stat, dc: choice.check.dc, roll, modifier, total, success };
      }

      const outcome = success ? choice.success : (choice.failure || choice.success);
      const rewards = outcome.rewards || {};
      const messages = [];

      if (rewards.xp && rewards.xp > 0) { char.xp += rewards.xp; messages.push(`+${rewards.xp} XP`); }
      if (rewards.gold && rewards.gold > 0) { char.gold += rewards.gold; messages.push(`+${rewards.gold} gold`); }
      if (rewards.healPct && rewards.healPct > 0) {
        const healAmt = Math.floor(char.max_hp * rewards.healPct / 100);
        char.hp = Math.min(char.max_hp, char.hp + healAmt);
        messages.push(`Healed ${healAmt} HP`);
      }
      if (rewards.manaPct && rewards.manaPct > 0) {
        const manaAmt = Math.floor(char.max_mp * rewards.manaPct / 100);
        char.mp = Math.min(char.max_mp, char.mp + manaAmt);
        messages.push(`Restored ${manaAmt} MP`);
      }
      if (rewards.damage && rewards.damage > 0) {
        char.hp = Math.max(1, char.hp - rewards.damage);
        messages.push(`Took ${rewards.damage} damage`);
      }
      if (Array.isArray(rewards.items)) {
        for (const drop of rewards.items) {
          await addItem(char.id, drop.slug, drop.qty || 1);
          const itemDef = getContent().items[drop.slug];
          messages.push(`Received ${itemDef?.name || drop.slug}${(drop.qty || 1) > 1 ? ` ×${drop.qty}` : ''}`);
        }
      }

      // Use shared checkLevelUp for consistent HP/MP gains and event emission
      const levelResult = await ctx.checkLevelUp(char);
      const leveledUp = levelResult.leveled;
      if (levelResult.messages.length) messages.push(...levelResult.messages);

      if (char.hp <= 0) {
        const goldLoss = Math.floor(char.gold * 0.1);
        char.gold -= goldLoss;
        char.hp = char.max_hp;
        char.mp = char.max_mp;
        const respawnLoc = getRespawnLocation(char.location);
        const respawnName = getContent().locations.find(l => l.slug === respawnLoc)?.name || 'town';
        char.location = respawnLoc;
        messages.push(`💀 You succumbed to your injuries. Lost ${goldLoss} gold. Returned to ${respawnName}.`);
        await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2, gold=$3, xp=$4, level=$5, max_hp=$6, max_mp=$7, location=$8, event_state=NULL WHERE id=$9',
          [char.hp, char.mp, char.gold, char.xp, char.level, char.max_hp, char.max_mp, char.location, char.id]);
        await addLog(char.id, 'combat', `💀 Killed by a trap! Lost ${goldLoss} gold.`);
      } else {
        const resolvedState = { ...es, resolved: true, outcome: { success, text: outcome.text, messages, rollInfo } };
        await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2, gold=$3, xp=$4, level=$5, max_hp=$6, max_mp=$7, event_state=$8 WHERE id=$9',
          [char.hp, char.mp, char.gold, char.xp, char.level, char.max_hp, char.max_mp, JSON.stringify(resolvedState), char.id]);
      }

      const logIcon = success ? '✅' : '❌';
      await addLog(char.id, 'quest', `${logIcon} ${eventDef.name}: ${outcome.text.substring(0, 80)}${outcome.text.length > 80 ? '…' : ''}`);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, outcome: { success, text: outcome.text, messages, rollInfo } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Event resolution failed.' }); }
  });

  // ─── DISMISS EVENT ──

  app.post('/api/fantasy/event/dismiss', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      await db.query('UPDATE fantasy_characters SET event_state = NULL WHERE id = $1', [char.id]);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'location', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Dismiss failed.' }); }
  });
}

module.exports = { register };
