// ═══════════════════════════════════════════════════════════════
// RAID TOWER — Multi-floor raid dungeons with lore, choices, bosses
// Locked-in runs: enter/exit only, no leaving between floors
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { validate, schemas } = require('../validation');

const RAID_DIR = path.join(__dirname, '..', 'content', 'raids');
const RAID_LOCATION = 'sunspire'; // Raid tower is at Sunspire

// Load all raid definitions from content/raids/
function loadRaids() {
  const raids = {};
  if (!fs.existsSync(RAID_DIR)) return raids;
  for (const file of fs.readdirSync(RAID_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RAID_DIR, file), 'utf8'));
      if (data.slug) raids[data.slug] = data;
    } catch (e) {
      console.error(`Failed to load raid ${file}:`, e.message);
    }
  }
  return raids;
}

let RAIDS = loadRaids();

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, withTransaction, getChar, getEquipment, addLog, addItem, removeItem,
    buildState, buildPatch, getContent, gameEvents, CLASSES, EQUIPMENT_SLOTS, rand,
    getCharAbilities, computeStats, rollPerks, getPerkPrefix, getMaxDurability,
    buildScaledEnemy, buildCompanionAlly, applyEffect, STATUS_EFFECTS,
  } = ctx;

  function getRaids() { return RAIDS; }

  function spawnAllies(char) {
    const allies = [];
    const comp = buildCompanionAlly(char);
    if (comp) allies.push(comp);
    return allies;
  }

  // Build a raid enemy — significantly tougher scaling for endgame content
  function buildRaidEnemy(enemyDef, charLevel, floorNum, raidSlug) {
    const floorScale = 1 + (floorNum - 1) * 0.15; // 15% harder per floor
    const scaled = buildScaledEnemy(enemyDef, charLevel, raidSlug, { elite: false });
    scaled.hp = Math.floor(scaled.hp * floorScale * 1.3); // 30% tougher than regular
    scaled.maxHp = scaled.hp;
    scaled.attack = Math.floor(scaled.attack * floorScale * 1.2);
    scaled.defense = Math.floor(scaled.defense * floorScale * 1.15);
    scaled.effects = [];
    return scaled;
  }

  // ─── LIST AVAILABLE RAIDS ───
  app.post('/api/fantasy/raid/list', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.location !== RAID_LOCATION) return res.status(400).json({ error: 'The Raid Tower is at Sunspire Citadel.' });

      const raids = getRaids();
      const raidList = Object.values(raids).map(r => ({
        slug: r.slug,
        name: r.name,
        difficulty: r.difficulty,
        floors: r.floorCount || (Array.isArray(r.floors) ? r.floors.length : r.floors),
        levelReq: r.levelReq || 1,
        icon: r.icon || '🏰',
        description: r.description,
        canEnter: char.level >= (r.levelReq || 1),
      }));

      const completedRows = await q(
        'SELECT raid_slug, COUNT(*) as clears, MAX(ended_at) as last_clear FROM fantasy_raid_runs WHERE char_id=$1 AND completed=TRUE GROUP BY raid_slug',
        [char.id]
      );
      const completions = {};
      for (const row of completedRows) {
        completions[row.raid_slug] = { clears: Number(row.clears), lastClear: row.last_clear };
      }

      res.json({ ok: true, raids: raidList, completions, raidState: char.raid_state || null });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to list raids.' }); }
  });

  // ─── ENTER RAID ───
  app.post('/api/fantasy/raid/enter', requireAuth, validate(schemas.raidEnter), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot enter a raid during combat.' });
      if (char.raid_state) return res.status(400).json({ error: 'Already in a raid.' });
      if (char.arena_state) return res.status(400).json({ error: 'Cannot enter a raid during an arena run.' });
      if (char.dungeon_state) return res.status(400).json({ error: 'Cannot enter a raid during a dungeon run.' });
      if (char.location !== RAID_LOCATION) return res.status(400).json({ error: 'The Raid Tower is at Sunspire Citadel.' });

      const { raidSlug } = req.body;
      const raid = getRaids()[raidSlug];
      if (!raid) return res.status(400).json({ error: 'Unknown raid.' });
      if (char.level < (raid.levelReq || 1)) return res.status(400).json({ error: `You must be level ${raid.levelReq} to enter ${raid.name}.` });

      const totalFloors = Array.isArray(raid.floors) ? raid.floors.length : raid.floors;
      const raidState = {
        raidSlug: raid.slug,
        currentFloor: 1,
        encounterIndex: 0,
        phase: 'lore', // lore → encounter → (choice → choiceResult →) encounter → preBoss → boss → lore (next floor) | complete
        floorsCleared: 0,
        totalFloors,
        startedAt: new Date().toISOString(),
        floorBuffs: [], // accumulated buffs from choices
        floorDebuffs: [], // accumulated debuffs from failed choices
        totalXp: 0,
        totalGold: 0,
      };

      await db.query('UPDATE fantasy_characters SET raid_state=$1, event_state=NULL WHERE id=$2',
        [JSON.stringify(raidState), char.id]);
      await addLog(char.id, 'raid', `🕳 Entered ${raid.name} — ${raid.description}`);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Raid enter failed.' }); }
  });

  // ─── ADVANCE RAID ───
  app.post('/api/fantasy/raid/advance', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.raid_state) return res.status(400).json({ error: 'Not in a raid.' });
      if (char.in_combat) return res.status(400).json({ error: 'In combat — finish fighting first.' });

      const rs = char.raid_state;
      const raid = getRaids()[rs.raidSlug];
      if (!raid) return res.status(400).json({ error: 'Raid data not found.' });

      const floorDef = raid.floors[rs.currentFloor - 1];
      if (!floorDef) return res.status(400).json({ error: 'Invalid floor.' });

      // ── LORE: acknowledged → encounter ──
      if (rs.phase === 'lore') {
        rs.phase = 'encounter';
        rs.encounterIndex = 0;
        await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state });
      }

      // ── CHOICE RESULT: acknowledged → continue encounters ──
      if (rs.phase === 'choiceResult') {
        rs.encounterIndex++;
        rs.phase = 'encounter';
        await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state });
      }

      // ── ENCOUNTER: start next encounter or move to pre-boss ──
      if (rs.phase === 'encounter') {
        const encounters = floorDef.encounters || [];
        if (rs.encounterIndex >= encounters.length) {
          // All encounters done → pre-boss recovery
          rs.phase = 'preBoss';
          rs.preBossChoiceMade = false;
          await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state });
        }

        const encounter = encounters[rs.encounterIndex];

        if (encounter.type === 'combat') {
          const enemies = [];
          let eidx = 0;
          const enemySlugs = encounter.enemies || [];
          const counts = encounter.count || enemySlugs.map(() => 1);

          for (let i = 0; i < enemySlugs.length; i++) {
            const slug = enemySlugs[i];
            const count = Array.isArray(counts) ? (counts[i] || 1) : 1;
            const enemyDef = raid.enemies.find(e => e.slug === slug);
            if (!enemyDef) continue;
            for (let j = 0; j < count; j++) {
              const scaled = buildRaidEnemy(enemyDef, char.level, rs.currentFloor, raid.slug);
              scaled.id = 'e' + eidx++;
              enemies.push(scaled);
            }
          }

          if (enemies.length === 0) {
            rs.encounterIndex++;
            await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
            const state = await buildState(req.session.userId, req.session.activeCharId);
            return res.json({ ok: true, state });
          }

          const combatLog = [];
          if (encounter.intro) combatLog.push(`⚔ ${encounter.intro}`);

          // Build combat buffs from accumulated raid buffs
          const playerBuffs = (rs.floorBuffs || []).filter(b => b.turnsLeft > 0).map(b => ({ ...b }));

          // Build player effects from accumulated debuffs
          const playerEffects = [];
          for (const debuff of (rs.floorDebuffs || [])) {
            if (debuff.turns > 0) {
              playerEffects.push({
                slug: debuff.slug,
                name: debuff.name || STATUS_EFFECTS[debuff.slug]?.name || debuff.slug,
                icon: STATUS_EFFECTS[debuff.slug]?.icon || '☠',
                turnsLeft: debuff.turns,
                source: debuff.name || 'Raid',
              });
              combatLog.push(`☠ You enter combat with ${debuff.name || debuff.slug} (${debuff.turns} turns)`);
            }
          }

          const combatState = {
            enemies,
            allies: spawnAllies(char),
            turn: 1,
            playerBuffs,
            playerEffects,
            playerTempPassives: [],
            cooldowns: {},
            log: combatLog,
            raidRun: true,
            raidSlug: rs.raidSlug,
            raidFloor: rs.currentFloor,
          };

          await db.query('UPDATE fantasy_characters SET in_combat=TRUE, combat_state=$1, raid_state=$2 WHERE id=$3',
            [JSON.stringify(combatState), JSON.stringify(rs), char.id]);
          await addLog(char.id, 'raid', `⚔ Raid Floor ${rs.currentFloor}: Combat encounter`);
          const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
          return res.json({ ok: true, patch });
        }

        if (encounter.type === 'choice') {
          rs.phase = 'choice';
          await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state });
        }

        rs.encounterIndex++;
        await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state });
      }

      // ── PRE-BOSS: start boss fight ──
      if (rs.phase === 'preBoss' || rs.phase === 'boss') {
        const bossDef = floorDef.boss;
        if (!bossDef) return res.status(400).json({ error: 'No boss defined for this floor.' });

        const bossEnemy = buildRaidEnemy(bossDef, char.level, rs.currentFloor, raid.slug);
        bossEnemy.id = 'e0';
        bossEnemy.boss = true;
        if (bossDef.telegraphs) bossEnemy.telegraphs = bossDef.telegraphs;
        if (bossDef.enrageThreshold) bossEnemy.enrageThreshold = bossDef.enrageThreshold;
        if (bossDef.enrageTelegraphs) bossEnemy.enrageTelegraphs = bossDef.enrageTelegraphs;

        const combatLog = [];
        if (bossDef.intro) combatLog.push(bossDef.intro);

        const playerBuffs = (rs.floorBuffs || []).filter(b => b.turnsLeft > 0).map(b => ({ ...b }));
        const playerEffects = [];
        for (const debuff of (rs.floorDebuffs || [])) {
          if (debuff.turns > 0) {
            playerEffects.push({
              slug: debuff.slug,
              name: debuff.name || STATUS_EFFECTS[debuff.slug]?.name || debuff.slug,
              icon: STATUS_EFFECTS[debuff.slug]?.icon || '☠',
              turnsLeft: debuff.turns,
              source: debuff.name || 'Raid',
            });
            combatLog.push(`☠ You face the boss with ${debuff.name || debuff.slug} (${debuff.turns} turns)`);
          }
        }

        rs.phase = 'boss'; // in case it was preBoss
        const combatState = {
          enemies: [bossEnemy],
          allies: spawnAllies(char),
          turn: 1,
          playerBuffs,
          playerEffects,
          playerTempPassives: [],
          cooldowns: {},
          log: combatLog,
          raidRun: true,
          raidSlug: rs.raidSlug,
          raidFloor: rs.currentFloor,
          isBossRoom: true,
        };

        await db.query('UPDATE fantasy_characters SET in_combat=TRUE, combat_state=$1, raid_state=$2 WHERE id=$3',
          [JSON.stringify(combatState), JSON.stringify(rs), char.id]);
        await addLog(char.id, 'raid', `🔥 Raid Floor ${rs.currentFloor} BOSS: ${bossDef.name}`);
        const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
        return res.json({ ok: true, patch });
      }

      // ── NEXT FLOOR: advance to next floor lore ──
      if (rs.phase === 'nextFloor') {
        rs.currentFloor++;
        rs.encounterIndex = 0;
        rs.phase = 'lore';
        rs.floorDebuffs = []; // Reset debuffs on new floor
        // Buffs persist across floors
        await db.query('UPDATE fantasy_characters SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), char.id]);
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state });
      }

      return res.status(400).json({ error: `Unknown raid phase: ${rs.phase}` });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Raid advance failed.' }); }
  });

  // ─── RAID CHOICE RESOLUTION ───
  app.post('/api/fantasy/raid/choice', requireAuth, validate(schemas.raidChoice), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.raid_state) return res.status(400).json({ error: 'Not in a raid.' });
      if (char.in_combat) return res.status(400).json({ error: 'In combat.' });

      const rs = char.raid_state;
      if (rs.phase !== 'choice') return res.status(400).json({ error: 'Not at a choice point.' });

      const { choiceIdx } = req.body;
      const raid = getRaids()[rs.raidSlug];
      if (!raid) return res.status(400).json({ error: 'Raid not found.' });

      const floorDef = raid.floors[rs.currentFloor - 1];
      const encounter = floorDef?.encounters?.[rs.encounterIndex];
      if (!encounter || encounter.type !== 'choice') return res.status(400).json({ error: 'No choice at this point.' });

      const choice = encounter.choices?.[choiceIdx];
      if (!choice) return res.status(400).json({ error: 'Invalid choice.' });

      // DC check
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
      const effect = outcome.effect || {};
      const messages = [];

      // ── Apply effects ──
      if (effect.healPct) {
        const healAmt = Math.floor(char.max_hp * effect.healPct / 100);
        char.hp = Math.min(char.max_hp, char.hp + healAmt);
        messages.push(`🩸 Healed ${healAmt} HP`);
      }
      if (effect.manaPct) {
        const manaAmt = Math.floor(char.max_mp * effect.manaPct / 100);
        char.mp = Math.min(char.max_mp, char.mp + manaAmt);
        messages.push(`💜 Restored ${manaAmt} MP`);
      }
      if (effect.damagePct) {
        const dmg = Math.max(1, Math.floor(char.max_hp * effect.damagePct / 100));
        char.hp = Math.max(1, char.hp - dmg);
        messages.push(`💔 Took ${dmg} damage`);
      }
      if (effect.damage) {
        char.hp = Math.max(1, char.hp - effect.damage);
        messages.push(`💔 Took ${effect.damage} damage`);
      }
      if (effect.mpDrain) {
        const drain = Math.max(1, Math.floor(char.max_mp * effect.mpDrain / 100));
        char.mp = Math.max(0, char.mp - drain);
        messages.push(`💜 Lost ${drain} MP`);
      }
      if (effect.xpBonus) {
        char.xp += effect.xpBonus;
        rs.totalXp = (rs.totalXp || 0) + effect.xpBonus;
        messages.push(`⭐ +${effect.xpBonus} XP`);
      }
      // Buff
      if (effect.buffStat) {
        rs.floorBuffs = rs.floorBuffs || [];
        rs.floorBuffs.push({
          stat: effect.buffStat,
          amount: effect.buffAmount || 3,
          name: encounter.title || 'Raid Blessing',
          turnsLeft: effect.buffTurns || 99,
        });
        messages.push(`⬆ +${effect.buffAmount || 3} ${effect.buffStat.toUpperCase()} buff for this raid`);
      }
      // Second buff (for dual-buff choices)
      if (effect.buffStat2) {
        rs.floorBuffs.push({
          stat: effect.buffStat2,
          amount: effect.buffAmount2 || 3,
          name: encounter.title || 'Raid Blessing',
          turnsLeft: effect.buffTurns2 || 99,
        });
        messages.push(`⬆ +${effect.buffAmount2 || 3} ${effect.buffStat2.toUpperCase()} buff for this raid`);
      }
      // Debuff
      if (effect.debuff) {
        rs.floorDebuffs = rs.floorDebuffs || [];
        rs.floorDebuffs.push({
          slug: effect.debuff.slug,
          turns: effect.debuff.turns || 3,
          name: effect.debuff.name || effect.debuff.slug,
        });
        messages.push(`☠ ${effect.debuff.name || effect.debuff.slug} — debuff for next ${effect.debuff.turns} combat turns`);
      }

      // Store the outcome in raidState so the frontend can display it
      rs.lastChoiceOutcome = {
        title: encounter.title,
        success,
        text: outcome.text,
        messages,
        rollInfo,
      };

      // Move to choiceResult phase — player acknowledges, then continues
      rs.phase = 'choiceResult';

      await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2, xp=$3, raid_state=$4 WHERE id=$5',
        [char.hp, char.mp, char.xp, JSON.stringify(rs), char.id]);

      const logIcon = success ? '✅' : '❌';
      await addLog(char.id, 'raid', `${logIcon} ${encounter.title}: ${outcome.text.substring(0, 100)}...`);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, outcome: { success, text: outcome.text, messages, rollInfo } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Raid choice failed.' }); }
  });

  // ─── PRE-BOSS RECOVERY ───
  app.post('/api/fantasy/raid/floor-choice', requireAuth, validate(schemas.raidFloorChoice), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.raid_state) return res.status(400).json({ error: 'Not in a raid.' });
      const rs = char.raid_state;
      if (rs.phase !== 'preBoss') return res.status(400).json({ error: 'Not at a recovery point.' });
      if (rs.preBossChoiceMade) return res.status(400).json({ error: 'Already made a choice.' });

      const { choice } = req.body;
      let msg;
      if (choice === 'healHp') {
        const healAmt = Math.floor(char.max_hp * 0.25);
        char.hp = Math.min(char.max_hp, char.hp + healAmt);
        msg = `🩸 Restored ${healAmt} HP (${char.hp}/${char.max_hp})`;
      } else if (choice === 'restoreMp') {
        const manaAmt = Math.floor(char.max_mp * 0.25);
        char.mp = Math.min(char.max_mp, char.mp + manaAmt);
        msg = `💜 Restored ${manaAmt} MP (${char.mp}/${char.max_mp})`;
      } else if (choice === 'both') {
        const healAmt = Math.floor(char.max_hp * 0.15);
        const manaAmt = Math.floor(char.max_mp * 0.15);
        char.hp = Math.min(char.max_hp, char.hp + healAmt);
        char.mp = Math.min(char.max_mp, char.mp + manaAmt);
        msg = `✨ Restored ${healAmt} HP and ${manaAmt} MP`;
      } else {
        return res.status(400).json({ error: 'Invalid choice.' });
      }

      rs.preBossChoiceMade = true;
      await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2, raid_state=$3 WHERE id=$4',
        [char.hp, char.mp, JSON.stringify(rs), char.id]);
      await addLog(char.id, 'raid', `🏰 ${msg}`);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, message: msg });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Floor choice failed.' }); }
  });

  // ─── LEAVE RAID ───
  app.post('/api/fantasy/raid/leave', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.raid_state) return res.status(400).json({ error: 'Not in a raid.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot leave during combat. Fight or fall.' });

      const rs = char.raid_state;
      const raid = getRaids()[rs.raidSlug];

      await db.query(
        'INSERT INTO fantasy_raid_runs (char_id, raid_slug, floors_reached, completed, ended_at) VALUES ($1,$2,$3,FALSE,NOW())',
        [char.id, rs.raidSlug, rs.floorsCleared || 0]
      );

      await db.query('UPDATE fantasy_characters SET raid_state=NULL, in_combat=FALSE, combat_state=NULL WHERE id=$1', [char.id]);
      await addLog(char.id, 'raid', `🚪 Abandoned ${raid?.name || 'the raid'} at Floor ${rs.currentFloor}. All progress lost.`);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Raid leave failed.' }); }
  });

  // ─── RAID COMBAT VICTORY HANDLER (called from combat.js) ───
  ctx.handleRaidCombatVictory = async function(char, cs, log, tx) {
    const rs = char.raid_state;
    if (!rs) return;
    const raid = getRaids()[rs.raidSlug];
    if (!raid) return;

    const floorDef = raid.floors[rs.currentFloor - 1];

    if (cs.isBossRoom) {
      rs.floorsCleared++;

      // Floor rewards (gold/XP only — no random gear)
      const floorGold = (raid.rewards?.goldBase || 50) + (raid.rewards?.goldPerFloor || 20) * rs.currentFloor;
      const floorXp = (raid.rewards?.xpBase || 80) + (raid.rewards?.xpPerFloor || 30) * rs.currentFloor;
      char.gold += floorGold;
      char.xp += floorXp;
      rs.totalXp = (rs.totalXp || 0) + floorXp;
      rs.totalGold = (rs.totalGold || 0) + floorGold;
      log.push(`🏰 Floor ${rs.currentFloor} cleared! +${floorXp} XP, +${floorGold} gold`);

      // Arcane tokens from boss
      const bossTokens = rand(1, 3);
      char.arcane_tokens = (char.arcane_tokens || 0) + bossTokens;
      await tx.query('UPDATE fantasy_characters SET arcane_tokens=$1 WHERE id=$2', [char.arcane_tokens, char.id]);
      log.push(`✦ Earned ${bossTokens} Arcane Token${bossTokens > 1 ? 's' : ''} from the boss!`);

      // ── RAID-EXCLUSIVE BOSS DROPS ──
      const bossDef = floorDef?.boss;
      if (bossDef?.drops?.length) {
        const dropChance = bossDef.dropChance || 20;
        for (const dropSlug of bossDef.drops) {
          if (rand(1, 100) <= dropChance) {
            const item = getContent().items[dropSlug];
            if (!item) continue;
            const perks = rollPerks(item.rarity, item);
            await addItem(char.id, dropSlug, 1, perks, tx);
            const displayName = perks ? (getPerkPrefix(perks) + ' ' + item.name) : item.name;
            const rarityIcon = item.rarity === 'mythic' ? '🔴' : '🟡';
            log.push(`${rarityIcon} RAID DROP: ${displayName}!`);
            if (gameEvents) {
              gameEvents.emit('item-looted', { charId: char.id, itemSlug: dropSlug, source: 'raid-drop', perks, enemySlug: bossDef.slug }).catch(() => {});
            }
            break; // Only one exclusive drop per boss kill
          }
        }
      }

      // Mythic pool drop on final boss
      if (bossDef?.mythicDrop && rs.floorsCleared >= rs.totalFloors) {
        const mythicChance = bossDef.mythicDropChance || 5;
        if (rand(1, 100) <= mythicChance) {
          // Drop from raid-exclusive mythic pool first, then general pool
          const raidMythics = (bossDef.drops || []).filter(slug => {
            const it = getContent().items[slug];
            return it && it.rarity === 'mythic';
          });
          const allMythics = raidMythics.length > 0 ? raidMythics : Object.entries(getContent().items).filter(([, it]) => it.rarity === 'mythic' && EQUIPMENT_SLOTS.includes(it.type)).map(([s]) => s);
          if (allMythics.length > 0) {
            const mythicSlug = allMythics[rand(0, allMythics.length - 1)];
            const slug = typeof mythicSlug === 'string' ? mythicSlug : mythicSlug[0];
            const mythicBase = getContent().items[slug];
            if (mythicBase) {
              const perks = rollPerks('mythic', mythicBase);
              await addItem(char.id, slug, 1, perks, tx);
              const displayName = perks ? (getPerkPrefix(perks) + ' ' + mythicBase.name) : mythicBase.name;
              log.push(`🔴 MYTHIC DROP: ${displayName}! [${perks?.length || 0} perks]`);
              if (gameEvents) {
                gameEvents.emit('item-looted', { charId: char.id, itemSlug: slug, source: 'mythic-drop', perks, enemySlug: bossDef.slug }).catch(() => {});
              }
            }
          }
        }
      }

      if (rs.floorsCleared >= rs.totalFloors) {
        // ═══ RAID COMPLETE ═══
        const bonusGold = raid.rewards?.completionBonus?.gold || 100;
        const bonusXp = raid.rewards?.completionBonus?.xp || 150;
        const bonusTokens = raid.rewards?.arcaneTokens || 2;
        char.gold += bonusGold;
        char.xp += bonusXp;
        char.arcane_tokens += bonusTokens;
        rs.totalXp += bonusXp;
        rs.totalGold += bonusGold;
        await tx.query('UPDATE fantasy_characters SET arcane_tokens=$1 WHERE id=$2', [char.arcane_tokens, char.id]);

        log.push(`\n🏆 ═══ RAID COMPLETE: ${raid.name} ═══`);
        log.push(`💰 Completion bonus: +${bonusXp} XP, +${bonusGold} gold, +${bonusTokens} ✦`);
        log.push(`\n📊 Raid totals: ${rs.totalXp} XP, ${rs.totalGold} gold earned`);

        await tx.query(
          'INSERT INTO fantasy_raid_runs (char_id, raid_slug, floors_reached, completed, ended_at) VALUES ($1,$2,$3,TRUE,NOW())',
          [char.id, rs.raidSlug, rs.floorsCleared]
        );

        if (gameEvents) {
          gameEvents.emit('raid-completed', {
            charId: char.id, raidSlug: rs.raidSlug, raidName: raid.name,
            floorsCleared: rs.floorsCleared, totalXp: rs.totalXp, totalGold: rs.totalGold,
          }).catch(() => {});
        }

        rs.phase = 'complete';
        rs.completionLore = raid.completionLore || null;
      } else {
        // Next floor — no between-floor transition, straight to lore
        rs.phase = 'nextFloor';
        rs.floorDebuffs = []; // clear debuffs for new floor
      }
    } else {
      // Regular encounter victory
      rs.encounterIndex++;
      rs.phase = 'encounter';
    }
  };

  // ─── RAID COMBAT DEATH HANDLER ───
  ctx.handleRaidCombatDeath = async function(char, cs, log, tx) {
    const rs = char.raid_state;
    if (!rs) return;
    const raid = getRaids()[rs.raidSlug];

    log.push(`💀 You have fallen in ${raid?.name || 'the raid'} on Floor ${rs.currentFloor}.`);
    log.push(`🚪 The corruption consumes your gains. You awaken at Sunspire, diminished.`);

    await tx.query(
      'INSERT INTO fantasy_raid_runs (char_id, raid_slug, floors_reached, completed, ended_at) VALUES ($1,$2,$3,FALSE,NOW())',
      [char.id, rs.raidSlug, rs.floorsCleared || 0]
    );

    const goldLost = Math.floor(char.gold * 0.10);
    char.gold = Math.max(0, char.gold - goldLost);
    char.hp = char.max_hp;
    char.mp = char.max_mp;
    char.location = RAID_LOCATION;
    log.push(`💀 Lost ${goldLost} gold.`);
  };

  // ─── RAID CONTENT API ───
  app.get('/api/fantasy/raid/content', requireAuth, async (req, res) => {
    try {
      const slug = req.query.slug;
      const raid = getRaids()[slug];
      if (!raid) return res.status(400).json({ error: 'Unknown raid.' });

      const floors = (Array.isArray(raid.floors) ? raid.floors : []).map(f => ({
        floor: f.floor,
        name: f.name,
        lore: f.lore,
        encounters: (f.encounters || []).map(e => {
          if (e.type === 'choice') return { type: 'choice', title: e.title, text: e.text, choices: (e.choices || []).map(c => ({ label: c.label, check: c.check, auto: c.auto })) };
          return { type: e.type, intro: e.intro };
        }),
        boss: f.boss ? { name: f.boss.name, description: f.boss.description, intro: f.boss.intro } : null,
      }));

      res.json({ ok: true, slug: raid.slug, name: raid.name, loreIntro: raid.loreIntro, floors, completionLore: raid.completionLore });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load raid content.' }); }
  });

  // ─── DISMISS RAID COMPLETION ───
  app.post('/api/fantasy/raid/dismiss', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.raid_state) return res.status(400).json({ error: 'Not in a raid.' });
      if (char.raid_state.phase !== 'complete') return res.status(400).json({ error: 'Raid not complete.' });

      await db.query('UPDATE fantasy_characters SET raid_state=NULL WHERE id=$1', [char.id]);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Dismiss failed.' }); }
  });
}

module.exports = { register };
