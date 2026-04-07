// ═══════════════════════════════════════════════════════════════
// PARTY COMBAT — Simultaneous action submission + round resolution
// Combat state lives on fantasy_parties.combat_state
// All players submit per round, resolve in DEX order, then enemies act
// ═══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { validate, schemas } = require('../validation');
const GAME_CONFIG = require('../shared/game-config');

const ROUND_TIMEOUT_MS = 30 * 1000; // 30 seconds
const AFK_DOWN_ROUNDS = 3; // auto-down after 3 consecutive missed rounds
const DISCONNECT_THRESHOLD_MS = 60 * 1000; // 60s no poll = disconnected
const RAID_DIR = path.join(__dirname, '..', 'content', 'raids');

function loadRaid(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(RAID_DIR, slug + '.json'), 'utf8')); }
  catch (e) { return null; }
}

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, withTransaction, getChar, getEquipment, addLog, addItem,
    buildState, getContent, gameEvents, CLASSES, EQUIPMENT_SLOTS, rand,
    getCharAbilities, computeStats, rollPerks, getPerkPrefix,
    buildScaledEnemy, buildCompanionAlly,
    applyEffect, removeEffect, getEffectStatMods, tickEffects, isStunned,
    applyDefenseReduction, applyDamagePassives, applyTurnRegenPassives,
    calcDodgeChance, calcEnemyDodgeChance, calcCritChance, calcEnemyCritChance,
    getCombatPassives, getEquipmentPerkBonuses,
    STATUS_EFFECTS, ENEMY_ABILITIES, xpForLevel, checkLevelUp,
    applyRacialDamageBonus, getRacialPassive, getAbilityRankCost,
  } = ctx;

  const MOMENTUM_MAX = 10;
  const MOMENTUM_THRESHOLDS = [
    { min: 0, name: null, dmgBonus: 0, critBonus: 0, mpDiscount: 0 },
    { min: 3, name: 'Warmed Up', dmgBonus: 0.05, critBonus: 0, mpDiscount: 0 },
    { min: 5, name: 'In The Zone', dmgBonus: 0.10, critBonus: 5, mpDiscount: 0 },
    { min: 7, name: 'Battle Focus', dmgBonus: 0.15, critBonus: 10, mpDiscount: 0.10 },
    { min: 9, name: 'Unstoppable', dmgBonus: 0.25, critBonus: 15, mpDiscount: 0.25 },
  ];
  function getMomentumTier(m) {
    for (let i = MOMENTUM_THRESHOLDS.length - 1; i >= 0; i--) {
      if (m >= MOMENTUM_THRESHOLDS[i].min) return MOMENTUM_THRESHOLDS[i];
    }
    return MOMENTUM_THRESHOLDS[0];
  }

  // ── Build initial party combat state ──
  async function buildPartyCombatState(party, enemies, raidState, opts = {}) {
    const players = {};
    const allies = [];
    let allyIdx = 0;

    for (const m of party.members) {
      if (m.status === 'down') continue;
      const char = await q1('SELECT * FROM fantasy_characters WHERE id=$1', [m.char_id]);
      if (!char) continue;
      const equipment = await getEquipment(char.id);
      const stats = computeStats(char, equipment);
      const charAbils = getCharAbilities(char);
      const perkBonuses = getEquipmentPerkBonuses(equipment);

      players[char.id] = {
        charId: char.id,
        name: char.name,
        race: char.race,
        class: char.class,
        level: char.level,
        hp: char.hp,
        maxHp: char.max_hp,
        mp: char.mp,
        maxMp: char.max_mp,
        stats,
        perkBonuses,
        abilityRanks: char.ability_ranks || {},
        activeAbilities: charAbils.activeAbilities.map(a => a.slug),
        buffs: (raidState?.floorBuffs || []).filter(b => b.turnsLeft > 0).map(b => ({ ...b })),
        effects: [],
        cooldowns: {},
        momentum: 0,
        pendingAction: null,
        submittedAt: null,
        defending: false,
        missedRounds: 0,
        lastPoll: new Date().toISOString(),
      };

      // Add debuffs from raid events
      for (const debuff of (raidState?.floorDebuffs || [])) {
        if (debuff.turns > 0) {
          players[char.id].effects.push({
            slug: debuff.slug,
            name: debuff.name || STATUS_EFFECTS[debuff.slug]?.name || debuff.slug,
            icon: STATUS_EFFECTS[debuff.slug]?.icon || '☠',
            turnsLeft: debuff.turns,
            source: debuff.name || 'Raid',
          });
        }
      }

      // Companion
      const comp = buildCompanionAlly(char);
      if (comp) {
        comp.id = 'a' + allyIdx++;
        comp.ownerId = char.id;
        allies.push(comp);
      }
    }

    return {
      enemies,
      players,
      allies,
      turn: 1,
      phase: 'submit',
      roundDeadline: new Date(Date.now() + ROUND_TIMEOUT_MS).toISOString(),
      roundLog: [],
      completedLog: [],
      raidRun: true,
      raidSlug: raidState?.raidSlug,
      raidFloor: raidState?.currentFloor,
      isBossRoom: opts.isBossRoom || false,
    };
  }

  // ── Get party for authenticated char ──
  async function getCharParty(userId, activeCharId) {
    const char = await getChar(userId, activeCharId);
    if (!char || !char.party_id) return { char: null, party: null };
    const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [char.party_id]);
    return { char, party };
  }

  // ── SUBMIT COMBAT ACTION ──
  app.post('/api/fantasy/party/combat/action', requireAuth, validate(schemas.combatAction), async (req, res) => {
    try {
      const { char, party } = await getCharParty(req.session.userId, req.session.activeCharId);
      if (!char || !party) return res.status(400).json({ error: 'Not in a party raid.' });
      if (party.state !== 'in_raid' || !party.combat_state) return res.status(400).json({ error: 'Not in party combat.' });

      const cs = party.combat_state;
      if (cs.phase !== 'submit') return res.status(400).json({ error: 'Round is resolving. Wait for results.' });

      const player = cs.players[char.id];
      if (!player) return res.status(400).json({ error: 'Not in this combat.' });
      if (player.hp <= 0) return res.status(400).json({ error: 'You are down. Wait for revival or combat end.' });
      if (player.pendingAction) return res.status(400).json({ error: 'Already submitted action this round.' });

      const { action, abilitySlug, targetId, petAbility } = req.body;

      // Validate action
      if (action === 'flee') return res.status(400).json({ error: 'Cannot flee from a raid!' });
      if (action === 'item') return res.status(400).json({ error: 'Consumables not allowed in raids!' });

      if (action === 'ability') {
        const cls = CLASSES.find(c => c.slug === player.class);
        const allAbilities = cls?.abilities || [];
        const ability = allAbilities.find(a => a.slug === abilitySlug && player.activeAbilities.includes(a.slug));
        if (!ability) return res.status(400).json({ error: 'Unknown ability.' });
        if ((player.cooldowns[abilitySlug] || 0) > 0) return res.status(400).json({ error: `${ability.name} on cooldown (${player.cooldowns[abilitySlug]} turns).` });

        const rank = player.abilityRanks[abilitySlug] || 1;
        const rd = ability.ranks?.[rank - 1] || {};
        let cost = getAbilityRankCost(ability.cost || 0, rank);
        const mTier = getMomentumTier(player.momentum || 0);
        if (mTier.mpDiscount > 0) cost = Math.floor(cost * (1 - mTier.mpDiscount));
        if (player.mp < cost) return res.status(400).json({ error: 'Not enough MP.' });
      }

      // Store pending action
      player.pendingAction = { action, abilitySlug, targetId, petAbility };
      player.submittedAt = new Date().toISOString();
      player.lastPoll = new Date().toISOString();
      player.missedRounds = 0; // reset on any manual action

      await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(cs), party.id]);

      // Check if all living players submitted
      const livingPlayers = Object.values(cs.players).filter(p => p.hp > 0);
      const allSubmitted = livingPlayers.every(p => p.pendingAction);

      if (allSubmitted) {
        // Resolve immediately
        await resolveRound(party.id);
      }

      const updated = await q1('SELECT combat_state FROM fantasy_parties WHERE id=$1', [party.id]);
      res.json({ ok: true, combat: updated.combat_state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Action failed.' }); }
  });

  // ── POLL COMBAT STATE ──
  app.get('/api/fantasy/party/combat/poll', requireAuth, async (req, res) => {
    try {
      const { char, party } = await getCharParty(req.session.userId, req.session.activeCharId);
      if (!char || !party) return res.status(400).json({ error: 'Not in a party raid.' });

      if (ctx.friendsOnline) ctx.friendsOnline.touchOnline(char.id);
      await db.query('UPDATE fantasy_party_members SET last_poll=NOW() WHERE party_id=$1 AND char_id=$2', [party.id, char.id]);

      // Update lastPoll in combat state for this player
      if (party.combat_state && party.combat_state.players[char.id]) {
        party.combat_state.players[char.id].lastPoll = new Date().toISOString();
        await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(party.combat_state), party.id]);
      }

      if (!party.combat_state) {
        // Not in combat — return raid state
        return res.json({ ok: true, combat: null, raidState: party.raid_state });
      }

      const cs = party.combat_state;

      // Check timeout
      if (cs.phase === 'submit' && cs.roundDeadline) {
        const deadline = new Date(cs.roundDeadline);
        if (Date.now() > deadline.getTime()) {
          // Auto-defend for anyone who hasn't submitted + track missed rounds
          for (const p of Object.values(cs.players)) {
            if (p.hp > 0 && !p.pendingAction) {
              p.missedRounds = (p.missedRounds || 0) + 1;
              // After AFK_DOWN_ROUNDS consecutive misses, auto-down the player
              if (p.missedRounds >= AFK_DOWN_ROUNDS) {
                p.hp = 0;
                cs.roundLog = cs.roundLog || [];
                cs.roundLog.push(`💀 ${p.name} has been removed from combat (AFK — ${AFK_DOWN_ROUNDS} missed rounds).`);
                cs.completedLog = cs.completedLog || [];
                cs.completedLog.push(`💀 ${p.name} has been removed from combat (AFK — ${AFK_DOWN_ROUNDS} missed rounds).`);
              } else {
                p.pendingAction = { action: 'defend' };
                p.submittedAt = new Date().toISOString();
                const warn = AFK_DOWN_ROUNDS - p.missedRounds;
                cs.roundLog = cs.roundLog || [];
                cs.roundLog.push(`⏳ ${p.name} timed out — auto-defending. (${warn} round${warn !== 1 ? 's' : ''} until AFK removal)`);
              }
            }
          }
          await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(cs), party.id]);
          // Only resolve if there are still living players
          const hasLiving = Object.values(cs.players).some(p => p.hp > 0);
          if (hasLiving) {
            await resolveRound(party.id);
          }
          const updated = await q1('SELECT combat_state, raid_state FROM fantasy_parties WHERE id=$1', [party.id]);
          return res.json({ ok: true, combat: updated.combat_state, raidState: updated.raid_state });
        }
      }

      res.json({ ok: true, combat: cs, raidState: party.raid_state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Poll failed.' }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // ROUND RESOLUTION — the heart of party combat
  // ═══════════════════════════════════════════════════════════════
  async function resolveRound(partyId) {
    const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [partyId]);
    if (!party || !party.combat_state) return;
    const cs = party.combat_state;
    cs.phase = 'resolving';
    const log = [];

    // Sort players by DEX (highest first)
    const playerOrder = Object.values(cs.players)
      .filter(p => p.hp > 0 && p.pendingAction)
      .sort((a, b) => (b.stats?.dex || 10) - (a.stats?.dex || 10));

    // ── PLAYER ACTIONS ──
    for (const player of playerOrder) {
      const action = player.pendingAction;
      if (!action) continue;
      if (player.hp <= 0) continue;

      const livingEnemies = cs.enemies.filter(e => e.hp > 0);
      if (livingEnemies.length === 0 && ['attack', 'ability'].includes(action.action)) continue;

      const target = action.targetId
        ? livingEnemies.find(e => e.id === action.targetId)
        : livingEnemies[0];

      // Check stun
      if (isStunned(player.effects)) {
        log.push(`💫 ${player.name} is stunned!`);
        continue;
      }

      player.defending = false;
      const pStats = player.stats || {};
      const mTier = getMomentumTier(player.momentum || 0);
      const prp = getRacialPassive(player.race);
      const critChance = Math.min(35, calcCritChance(pStats.cha || 10) + (player.perkBonuses?.critBonus || 0) + mTier.critBonus + (prp?.critBonusPct || 0));

      if (action.action === 'attack') {
        if (!target) continue;
        const dodgeChance = calcEnemyDodgeChance(target.defense || 0);
        if (rand(1, 100) <= dodgeChance) {
          log.push(`${target.name} dodges ${player.name}'s attack!`);
        } else {
          let dmg = Math.floor((pStats.attack || 10) * 0.92) + rand(0, 3);
          dmg = applyDefenseReduction(dmg, target.defense || 0);
          const isCrit = rand(1, 100) <= critChance;
          if (isCrit) dmg = Math.floor(dmg * 1.5);
          if (mTier.dmgBonus > 0) dmg = Math.floor(dmg * (1 + mTier.dmgBonus));
          const ampEff = (target.effects || []).find(e => e.damageAmp);
          if (ampEff) dmg = Math.floor(dmg * (1 + ampEff.damageAmp / 100));
          dmg = applyRacialDamageBonus(dmg, player.race, 'attack');
          target.hp -= dmg;
          log.push(isCrit ? `⚡ ${player.name} crits ${target.name} for ${dmg}!` : `${player.name} strikes ${target.name} for ${dmg}.`);
          // Racial lifesteal
          if (prp?.lifestealPct) {
            const rHeal = Math.min(player.maxHp - player.hp, Math.max(0, Math.floor(dmg * prp.lifestealPct / 100)));
            if (rHeal > 0) { player.hp += rHeal; log.push(`🔥 ${prp.name} restores ${rHeal} HP to ${player.name}.`); }
          }
        }
        adjustPlayerMomentum(player, 1);
      } else if (action.action === 'defend') {
        player.defending = true;
        log.push(`🛡 ${player.name} braces for impact.`);
        adjustPlayerMomentum(player, 2);
      } else if (action.action === 'ability') {
        const cls = CLASSES.find(c => c.slug === player.class);
        const ability = cls?.abilities?.find(a => a.slug === action.abilitySlug);
        if (!ability) continue;

        const rank = player.abilityRanks[ability.slug] || 1;
        const rd = ability.ranks?.[rank - 1] || {};
        const rankedDmg = rd.damage || ability.damage || 0;
        const rankBonusCrit = rd.bonusCritChance || 0;
        const rankBonusDmgFlat = rd.bonusDamageFlat || 0;

        let cost = getAbilityRankCost(ability.cost || 0, rank);
        if (mTier.mpDiscount > 0) cost = Math.floor(cost * (1 - mTier.mpDiscount));
        if (player.mp < cost) { log.push(`${player.name} lacks MP for ${ability.name}!`); continue; }
        player.mp -= cost;

        const pveCd = ability.pveCooldown ?? (GAME_CONFIG.pveCooldowns?.[ability.slug]) ?? 0;
        if (pveCd > 0) player.cooldowns[ability.slug] = pveCd;

        if (ability.type === 'physical' || ability.type === 'magic') {
          const isAoe = ability.aoe || false;
          const targets = isAoe ? livingEnemies : (target ? [target] : []);
          const hits = (ability.hits || 1) + (rd.bonusHits || 0);

          for (const t of targets) {
            const tDef = t.defense || 0;
            const tDodge = calcEnemyDodgeChance(tDef);
            if (rand(1, 100) <= tDodge) { log.push(`${t.name} dodges ${player.name}'s ${ability.name}!`); continue; }

            const baseDmg = ability.type === 'magic'
              ? Math.floor(((pStats.int || 10) * 1.08) + (player.level * 0.4))
              : Math.floor((pStats.attack || 10) * 0.95);

            let totalDmg = 0;
            for (let h = 0; h < hits; h++) {
              totalDmg += Math.floor(baseDmg * rankedDmg) + rand(0, 2) + rankBonusDmgFlat;
            }
            totalDmg = applyDefenseReduction(totalDmg, tDef);
            const isCrit = rand(1, 100) <= (critChance + rankBonusCrit);
            if (isCrit) totalDmg = Math.floor(totalDmg * 1.5);
            if (isAoe && t.id !== target?.id) totalDmg = Math.floor(totalDmg * 0.7);
            if (mTier.dmgBonus > 0) totalDmg = Math.floor(totalDmg * (1 + mTier.dmgBonus));
            // Damage amp from party-debuff (expose weakness, hunter's mark)
            const ampEffect = (t.effects || []).find(e => e.damageAmp);
            if (ampEffect) totalDmg = Math.floor(totalDmg * (1 + ampEffect.damageAmp / 100));
            totalDmg = applyRacialDamageBonus(totalDmg, player.race, ability.type);
            t.hp -= totalDmg;
            log.push(isCrit ? `⚡ ${player.name}'s ${ability.name} crits ${t.name} for ${totalDmg}!` : `${player.name} uses ${ability.name} on ${t.name} for ${totalDmg}.`);
            // Racial lifesteal
            if (prp?.lifestealPct) {
              const rHeal = Math.min(player.maxHp - player.hp, Math.max(0, Math.floor(totalDmg * prp.lifestealPct / 100)));
              if (rHeal > 0) { player.hp += rHeal; log.push(`🔥 ${prp.name} restores ${rHeal} HP to ${player.name}.`); }
            }

            // Status effects
            if (ability.stun) { const eff = applyEffect(t.effects, 'stun', 1, ability.name); if (eff) log.push(`💫 ${t.name} is stunned!`); }
            if (ability.slow) { const eff = applyEffect(t.effects, 'slow', 3, ability.name); if (eff) log.push(`🐌 ${t.name} is slowed!`); }
            if (ability.dot) { const eff = applyEffect(t.effects, ability.dot.type || 'poison', ability.dot.turns || 3, ability.name); if (eff) { eff.damagePerTurn = ability.dot.damage || 3; log.push(`🧪 ${ability.name} applies ${ability.dot.type} to ${t.name}!`); } }
          }
          if (ability.healPct) {
            const healAmt = Math.floor(player.maxHp * ability.healPct / 100);
            const healed = Math.min(healAmt, player.maxHp - player.hp);
            player.hp += healed;
            if (healed > 0) log.push(`💚 ${player.name} heals ${healed} HP from ${ability.name}.`);
          }
          adjustPlayerMomentum(player, 1);
        } else if (ability.type === 'heal') {
          const rankedHealPct = rd.healPct || ability.healPct || 0;
          const healAmt = Math.max(1, Math.floor(player.maxHp * rankedHealPct / 100));
          const healed = Math.min(healAmt, player.maxHp - player.hp);
          player.hp += healed;
          log.push(`💚 ${player.name} uses ${ability.name}, healing ${healed} HP.`);
        } else if (ability.type === 'buff') {
          const buffDurBonus = rd.durationBonus || 0;
          const buffStrBonus = rd.buffBonus || 0;
          const scaledBuff = { ...ability.buff, name: ability.name, turnsLeft: (ability.buff?.turns || 3) + buffDurBonus };
          if (buffStrBonus > 0) {
            for (const k of Object.keys(scaledBuff)) {
              if (typeof scaledBuff[k] === 'number' && !['turns', 'turnsLeft'].includes(k)) scaledBuff[k] = Math.floor(scaledBuff[k] * (1 + buffStrBonus));
            }
          }
          player.buffs.push(scaledBuff);
          log.push(`✨ ${player.name} uses ${ability.name}. ${ability.description || ''}`);
        } else if (ability.type === 'restore') {
          const restoreMul = 1 + (rd.restoreBonus || 0);
          const restored = Math.min(Math.floor((ability.restore || 0) * restoreMul), player.maxMp - player.mp);
          player.mp += restored;
          log.push(`💜 ${player.name} recovers ${restored} MP with ${ability.name}.`);
        } else if (ability.type === 'purify') {
          const removable = player.effects.filter(e => { const d = STATUS_EFFECTS[e.slug]; return d && (d.type === 'dot' || d.type === 'debuff' || d.type === 'cc'); });
          if (removable.length > 0) { for (const eff of removable) removeEffect(player.effects, eff.slug); log.push(`✨ ${player.name} cleanses ${removable.map(e => e.name).join(', ')}!`); }
          const totalHealPct = (ability.healPct || 0) + (rd.bonusHealPct || 0);
          if (totalHealPct > 0) {
            const healed = Math.min(Math.floor(player.maxHp * totalHealPct / 100), player.maxHp - player.hp);
            player.hp += healed;
            if (healed > 0) log.push(`💚 ${ability.name} restores ${healed} HP to ${player.name}.`);
          }
        } else if (ability.type === 'party-buff') {
          // Buff ALL living party members
          const durBonus = rd.durationBonus || 0;
          const buffAmt = rd.buffAmount || ability.partyBuff?.amount || 3;
          const buffTurns = (ability.partyBuff?.turns || 3) + durBonus;
          const buffStat = ability.partyBuff?.stat || 'defense';
          for (const [pid2, p2] of Object.entries(cs.players)) {
            if (p2.hp <= 0) continue;
            p2.buffs.push({ stat: buffStat, amount: buffAmt, name: ability.name, turnsLeft: buffTurns });
          }
          log.push(`✨ ${player.name} uses ${ability.name}! All allies gain +${buffAmt} ${buffStat === 'all' ? 'all stats' : buffStat === 'dodge' ? '% dodge' : buffStat.toUpperCase()} for ${buffTurns} turns.`);
          // Second buff (Arcane Shield gives DEF + INT)
          if (ability.partyBuff2) {
            for (const [pid2, p2] of Object.entries(cs.players)) {
              if (p2.hp <= 0) continue;
              p2.buffs.push({ stat: ability.partyBuff2.stat, amount: ability.partyBuff2.amount, name: ability.name, turnsLeft: ability.partyBuff2.turns + durBonus });
            }
          }
        } else if (ability.type === 'ally-heal') {
          // Heal a target ally
          const targetPlayerId = action.targetPlayerId || action.targetId;
          const healTarget = targetPlayerId ? cs.players[targetPlayerId] : player; // default self
          if (healTarget && healTarget.hp > 0) {
            const healPct = rd.healPct || ability.allyHealPct || 30;
            const healAmt = Math.max(1, Math.floor(healTarget.maxHp * healPct / 100));
            const healed = Math.min(healAmt, healTarget.maxHp - healTarget.hp);
            healTarget.hp += healed;
            log.push(`💚 ${player.name} heals ${healTarget.name} for ${healed} HP with ${ability.name}.`);
          } else {
            // Fallback to self
            const healPct = rd.healPct || ability.allyHealPct || 30;
            const healAmt = Math.max(1, Math.floor(player.maxHp * healPct / 100));
            const healed = Math.min(healAmt, player.maxHp - player.hp);
            player.hp += healed;
            log.push(`💚 ${player.name} heals self for ${healed} HP with ${ability.name}.`);
          }
        } else if (ability.type === 'party-heal') {
          // Heal ALL living party members
          const healPct = rd.healPct || ability.partyHealPct || 20;
          for (const [pid2, p2] of Object.entries(cs.players)) {
            if (p2.hp <= 0) continue;
            const healAmt = Math.max(1, Math.floor(p2.maxHp * healPct / 100));
            const healed = Math.min(healAmt, p2.maxHp - p2.hp);
            p2.hp += healed;
          }
          log.push(`💚 ${player.name} uses ${ability.name}! All allies healed for ${healPct}% HP.`);
          // Rank cleanse
          if (rd.cleanse) {
            for (const [pid2, p2] of Object.entries(cs.players)) {
              if (p2.hp <= 0) continue;
              const removable = p2.effects.filter(e => { const d = STATUS_EFFECTS[e.slug]; return d && (d.type === 'dot' || d.type === 'debuff' || d.type === 'cc'); });
              if (removable.length > 0) {
                const toCleanse = rd.cleanse === 'all' ? removable : removable.slice(0, rd.cleanse);
                for (const eff of toCleanse) removeEffect(p2.effects, eff.slug);
                log.push(`✨ ${ability.name} cleanses ${toCleanse.map(e => e.name).join(', ')} from ${p2.name}!`);
              }
            }
          }
        } else if (ability.type === 'ally-restore') {
          // Restore MP to target ally
          const targetPlayerId = action.targetPlayerId || action.targetId;
          const restoreTarget = targetPlayerId ? cs.players[targetPlayerId] : player;
          if (restoreTarget) {
            const restoreAmt = rd.restore || ability.allyRestore || 15;
            const restored = Math.min(restoreAmt, restoreTarget.maxMp - restoreTarget.mp);
            restoreTarget.mp += restored;
            log.push(`💜 ${player.name} restores ${restored} MP to ${restoreTarget.name} with ${ability.name}.`);
          }
        } else if (ability.type === 'ally-revive') {
          // Revive a downed party member
          const targetPlayerId = action.targetPlayerId || action.targetId;
          const reviveTarget = targetPlayerId ? cs.players[targetPlayerId] : null;
          if (reviveTarget && reviveTarget.hp <= 0) {
            const revivePct = rd.reviveHpPct || ability.reviveHpPct || 40;
            reviveTarget.hp = Math.max(1, Math.floor(reviveTarget.maxHp * revivePct / 100));
            log.push(`🌟 ${player.name} resurrects ${reviveTarget.name} at ${reviveTarget.hp} HP!`);
          } else {
            log.push(`${player.name} tries to resurrect, but no valid target is down.`);
            // Refund cooldown
            if (ability.pveCooldown) delete player.cooldowns[ability.slug];
          }
        } else if (ability.type === 'party-debuff') {
          // Debuff target enemy — amplifies damage from all sources
          if (target) {
            const debuffTurns = (ability.enemyDebuff?.turns || 3) + (rd.durationBonus || 0);
            const damageAmp = rd.damageAmp || ability.enemyDebuff?.damageAmp || 20;
            const eff = applyEffect(target.effects, ability.enemyDebuff?.slug || 'weaken', debuffTurns, ability.name);
            if (eff) eff.damageAmp = damageAmp;
            log.push(`🎯 ${player.name} uses ${ability.name} on ${target.name}! +${damageAmp}% damage from all sources for ${debuffTurns} turns.`);
            // Also deal damage if ability has damage multiplier
            if (rd.damage) {
              const baseDmg = Math.floor((player.stats?.attack || 10) * 0.95);
              let dmg = applyDefenseReduction(Math.floor(baseDmg * rd.damage) + rand(0, 2), target.defense || 0);
              target.hp -= dmg;
              log.push(`${player.name}'s ${ability.name} hits ${target.name} for ${dmg}.`);
            }
          }
        } else if (ability.type === 'taunt') {
          // Redirect all enemy attacks to this player
          const tauntTurns = rd.tauntTurns || ability.tauntTurns || 2;
          cs.tauntPlayerId = player.charId;
          cs.tauntTurnsLeft = tauntTurns;
          // Bonus defense from ranks
          if (rd.bonusDefense) {
            player.buffs.push({ stat: 'defense', amount: rd.bonusDefense, name: ability.name + ' (guard)', turnsLeft: tauntTurns });
          }
          log.push(`🛡 ${player.name} TAUNTS! All enemies focus on ${player.name} for ${tauntTurns} turns.`);
        }
      }
    }

    // ── ALLY TURNS ──
    for (const ally of cs.allies) {
      if (ally.hp <= 0) continue;
      const livingEnemies = cs.enemies.filter(e => e.hp > 0);
      if (livingEnemies.length === 0) continue;
      const target = livingEnemies.reduce((a, b) => a.hp < b.hp ? a : b);
      const allyAtk = ally.attack || 5;
      const rawDmg = Math.floor(allyAtk * 0.9) + rand(0, 2);
      const dmg = Math.max(1, applyDefenseReduction(rawDmg, target.defense || 0));
      target.hp -= dmg;
      log.push(`${ally.icon || '🐾'} ${ally.name} attacks ${target.name} for ${dmg}.`);
    }
    cs.allies = cs.allies.filter(a => a.hp > 0);

    // ── ENEMY TURNS ──
    const livingPlayersForEnemies = Object.values(cs.players).filter(p => p.hp > 0);
    for (const en of cs.enemies) {
      if (en.hp <= 0) continue;
      if (isStunned(en.effects || [])) { log.push(`💫 ${en.name} is stunned!`); continue; }

      const enEffMods = getEffectStatMods(en.effects || []);
      const enAtk = Math.max(1, (en.attack || 10) + (enEffMods.attack || 0));

      // Enemy abilities
      for (const abSlug of (en.abilities || [])) {
        const abDef = ENEMY_ABILITIES[abSlug];
        if (!abDef || rand(1, 100) > abDef.chance) continue;
        // Target random player
        const victim = livingPlayersForEnemies[rand(0, livingPlayersForEnemies.length - 1)];
        if (!victim) continue;
        if (abDef.target === 'self') {
          const eff = applyEffect(en.effects, abDef.effect, abDef.turns || 3, abDef.name);
          if (eff) log.push(`${eff.icon || '✦'} ${en.name} uses ${abDef.name}!`);
        } else {
          const dodge = Math.min(25, calcDodgeChance(victim.stats?.dex || 10) + (victim.perkBonuses?.dodgeBonus || 0));
          if (rand(1, 100) <= dodge) { log.push(`${victim.name} dodges ${en.name}'s ${abDef.name}!`); continue; }
          const eff = applyEffect(victim.effects, abDef.effect, abDef.turns || 3, abDef.name);
          if (eff) log.push(`${eff.icon || '☠'} ${en.name} uses ${abDef.name} on ${victim.name}!`);
        }
      }

      // Enemy basic attack — target taunter if active, else random
      let victim;
      if (cs.tauntPlayerId && cs.tauntTurnsLeft > 0) {
        victim = cs.players[cs.tauntPlayerId];
        if (!victim || victim.hp <= 0) victim = livingPlayersForEnemies[rand(0, livingPlayersForEnemies.length - 1)];
      } else {
        victim = livingPlayersForEnemies[rand(0, livingPlayersForEnemies.length - 1)];
      }
      if (!victim) continue;

      const victimRp = getRacialPassive(victim.race);
      const playerDodge = Math.min(25, calcDodgeChance(victim.stats?.dex || 10) + (victim.perkBonuses?.dodgeBonus || 0) + (victimRp?.dodgeBonusPct || 0));
      // Check dodge buffs
      let dodged = rand(1, 100) <= playerDodge;
      if (!dodged && victim.buffs) {
        const dodgeBuff = victim.buffs.find(b => b.stat === 'dodge');
        if (dodgeBuff && rand(1, 100) <= dodgeBuff.amount) dodged = true;
      }

      if (dodged) {
        log.push(`${victim.name} dodges ${en.name}'s attack!`);
        adjustPlayerMomentum(victim, 1);
        continue;
      }

      let bonusDef = 0;
      if (victim.buffs) for (const b of victim.buffs) if (b.stat === 'defense') bonusDef += b.amount;
      const totalDef = (victim.stats?.defense || 0) + bonusDef;
      let eDmg = Math.floor(enAtk * 1.04) + rand(-1, 3);
      eDmg = Math.max(2, applyDefenseReduction(eDmg, totalDef));
      const eCrit = rand(1, 100) <= calcEnemyCritChance(en.attack || 10);
      if (eCrit) eDmg = Math.floor(eDmg * 1.5);
      if (victim.defending) eDmg = Math.max(1, Math.floor(eDmg * 0.5));
      victim.hp -= eDmg;
      adjustPlayerMomentum(victim, eCrit ? -2 : -1);
      log.push(eCrit ? `⚡ ${en.name} crits ${victim.name} for ${eDmg}!` : `${en.name} attacks ${victim.name} for ${eDmg}.`);

      if (victim.hp <= 0) {
        victim.hp = 0;
        log.push(`💀 ${victim.name} is DOWN!`);
      }
    }

    // ── TICK EFFECTS ──
    for (const en of cs.enemies) {
      if (en.hp <= 0 || !(en.effects?.length)) continue;
      const delta = tickEffects(en.effects, en.name, en.hp, en.maxHp, log);
      en.hp += delta;
    }
    for (const p of Object.values(cs.players)) {
      if (p.hp <= 0 || !(p.effects?.length)) continue;
      const delta = tickEffects(p.effects, p.name, p.hp, p.maxHp, log);
      p.hp += delta;
      p.hp = Math.min(p.hp, p.maxHp);
      if (p.hp <= 0) { p.hp = 0; log.push(`💀 ${p.name} is DOWN!`); }
    }

    // Tick buffs
    for (const p of Object.values(cs.players)) {
      if (p.buffs?.length) { for (const b of p.buffs) b.turnsLeft--; p.buffs = p.buffs.filter(b => b.turnsLeft > 0); }
    }

    // Racial passives: MP regen (elf), lifesteal (orc) per round
    for (const p of Object.values(cs.players)) {
      if (p.hp <= 0) continue;
      const rpP = getRacialPassive(p.race);
      if (rpP?.mpRegenFlat) {
        const mpGain = Math.min(rpP.mpRegenFlat, p.maxMp - p.mp);
        if (mpGain > 0) { p.mp += mpGain; log.push(`✨ ${rpP.name} restores ${mpGain} MP to ${p.name}.`); }
      }
    }

    // Tick cooldowns
    for (const p of Object.values(cs.players)) {
      for (const slug of Object.keys(p.cooldowns || {})) {
        p.cooldowns[slug]--;
        if (p.cooldowns[slug] <= 0) delete p.cooldowns[slug];
      }
    }

    // Clear pending actions for next round
    for (const p of Object.values(cs.players)) {
      p.pendingAction = null;
      p.submittedAt = null;
      p.defending = false;
      // missedRounds is incremented in timeout handler, reset in action submit
      // don't touch it here — it persists across rounds for tracking
    }

    // Tick taunt
    if (cs.tauntTurnsLeft > 0) {
      cs.tauntTurnsLeft--;
      if (cs.tauntTurnsLeft <= 0) { cs.tauntPlayerId = null; }
    }

    cs.turn++;
    cs.completedLog.push(...log);
    cs.roundLog = log;

    // ── CHECK VICTORY ──
    const allEnemiesDead = cs.enemies.every(e => e.hp <= 0);
    const allPlayersDead = Object.values(cs.players).every(p => p.hp <= 0);

    if (allEnemiesDead) {
      cs.phase = 'victory';
      // Award XP/gold
      let totalXp = 0, totalGold = 0;
      for (const en of cs.enemies) {
        totalXp += en.xp || 0;
        totalGold += en.gold || 0;
      }
      const livingCount = Object.values(cs.players).filter(p => p.hp > 0).length;
      const perPlayerXp = Math.floor(totalXp / Math.max(1, livingCount));
      const perPlayerGold = Math.floor(totalGold / Math.max(1, livingCount));

      log.push(`\n☠ All enemies defeated!`);

      // Distribute rewards
      for (const p of Object.values(cs.players)) {
        if (p.hp > 0) {
          log.push(`${p.name}: +${perPlayerXp} XP, +${perPlayerGold} gold`);
        }
      }

      // Revive downed players at 25% HP
      for (const p of Object.values(cs.players)) {
        if (p.hp <= 0) {
          p.hp = Math.floor(p.maxHp * 0.25);
          log.push(`💫 ${p.name} revives at ${p.hp} HP.`);
        }
      }

      // Save player HP/MP/gold/xp to DB
      await withTransaction(async (tx) => {
        for (const p of Object.values(cs.players)) {
          const cid = Number(p.charId);
          await tx.query('UPDATE fantasy_characters SET hp=$1, mp=$2, xp=xp+$3, gold=gold+$4 WHERE id=$5',
            [p.hp, p.mp, p.hp > 0 ? perPlayerXp : 0, p.hp > 0 ? perPlayerGold : 0, cid]);
          // Check level up
          const charRow = await q1('SELECT * FROM fantasy_characters WHERE id=$1', [Number(p.charId)], tx);
          if (charRow) {
            const lu = await checkLevelUp(charRow, tx);
            if (lu.messages.length) log.push(...lu.messages.map(m => `${p.name}: ${m}`));
            p.hp = charRow.hp; p.mp = charRow.mp;
            p.level = charRow.level; p.maxHp = charRow.max_hp; p.maxMp = charRow.max_mp;
          }
        }

        // Handle raid progression
        const rs = party.raid_state;
        if (rs) {
          const raid = loadRaid(rs.raidSlug);
          if (raid) {
            const floorDef = raid.floors?.[rs.currentFloor - 1];
            if (cs.isBossRoom) {
              rs.floorsCleared++;
              const floorGold = (raid.rewards?.goldBase || 50) + (raid.rewards?.goldPerFloor || 20) * rs.currentFloor;
              const floorXp = (raid.rewards?.xpBase || 80) + (raid.rewards?.xpPerFloor || 30) * rs.currentFloor;
              rs.totalXp = (rs.totalXp || 0) + floorXp;
              rs.totalGold = (rs.totalGold || 0) + floorGold;
              log.push(`🏰 Floor ${rs.currentFloor} cleared! +${floorXp} XP, +${floorGold} gold`);

              // Distribute floor rewards + tokens
              for (const p of Object.values(cs.players)) {
                const tokens = rand(1, 2);
                await tx.query('UPDATE fantasy_characters SET gold=gold+$1, xp=xp+$2, arcane_tokens=arcane_tokens+$3 WHERE id=$4',
                  [Math.floor(floorGold / livingCount), Math.floor(floorXp / livingCount), tokens, Number(p.charId)]);
                log.push(`${p.name}: +${tokens}✦`);
              }

              // Boss drops (raid-exclusive, personal loot per player)
              const bossDef = floorDef?.boss;
              if (bossDef?.drops?.length) {
                for (const p of Object.values(cs.players)) {
                  const dropChance = bossDef.dropChance || 20;
                  if (rand(1, 100) <= dropChance) {
                    const dropSlug = bossDef.drops[rand(0, bossDef.drops.length - 1)];
                    const item = getContent().items[dropSlug];
                    if (item) {
                      const perks = rollPerks(item.rarity, item);
                      await addItem(Number(p.charId), dropSlug, 1, perks, tx);
                      const name = perks ? (getPerkPrefix(perks) + ' ' + item.name) : item.name;
                      log.push(`${item.rarity === 'mythic' ? '🔴' : '🟡'} ${p.name} receives: ${name}!`);
                    }
                  }
                }
              }

              if (rs.floorsCleared >= rs.totalFloors) {
                // RAID COMPLETE
                const bonus = raid.rewards?.completionBonus || {};
                rs.totalXp += bonus.xp || 0;
                rs.totalGold += bonus.gold || 0;
                log.push(`\n🏆 ═══ RAID COMPLETE: ${raid.name} ═══`);
                for (const p of Object.values(cs.players)) {
                  await tx.query('UPDATE fantasy_characters SET gold=gold+$1, xp=xp+$2, arcane_tokens=arcane_tokens+$3 WHERE id=$4',
                    [Math.floor((bonus.gold||0)/livingCount), Math.floor((bonus.xp||0)/livingCount), raid.rewards?.arcaneTokens || 2, Number(p.charId)]);
                }
                // Record completion
                for (const p of Object.values(cs.players)) {
                  await tx.query('INSERT INTO fantasy_raid_runs (char_id, raid_slug, floors_reached, completed, ended_at) VALUES ($1,$2,$3,TRUE,NOW())',
                    [Number(p.charId), rs.raidSlug, rs.floorsCleared]);
                }

                // ── EXOTIC DROPS (party-only, final boss, class-locked) ──
                const allItems = getContent().items;
                const exoticPool = Object.entries(allItems).filter(([, it]) => it.rarity === 'exotic');
                if (exoticPool.length > 0) {
                  const EXOTIC_DROP_CHANCE = 18; // 18% per player
                  for (const p of Object.values(cs.players)) {
                    if (p.hp <= 0) continue; // must be alive
                    // Find exotic for this player's class
                    const classExotic = exoticPool.find(([, it]) => it.classReq === p.class);
                    if (!classExotic) continue;
                    if (rand(1, 100) <= EXOTIC_DROP_CHANCE) {
                      const [exSlug, exItem] = classExotic;
                      const perks = rollPerks('exotic', exItem);
                      await addItem(Number(p.charId), exSlug, 1, perks, tx);
                      const displayName = perks ? (getPerkPrefix(perks) + ' ' + exItem.name) : exItem.name;
                      log.push(`🔷 EXOTIC DROP: ${p.name} receives ${displayName}!`);
                      if (gameEvents) {
                        gameEvents.emit('item-looted', { charId: Number(p.charId), itemSlug: exSlug, source: 'exotic-drop', perks }).catch(() => {});
                      }
                    }
                  }
                }

                rs.phase = 'complete';
                rs.completionLore = raid.completionLore || null;
              } else {
                rs.phase = 'nextFloor';
                rs.floorDebuffs = [];
              }
            } else {
              rs.encounterIndex++;
              rs.phase = 'encounter';
            }
          }
          await tx.query('UPDATE fantasy_parties SET raid_state=$1 WHERE id=$2', [JSON.stringify(rs), party.id]);
        }
      });
    } else if (allPlayersDead) {
      cs.phase = 'wipe';
      log.push(`\n💀 ═══ PARTY WIPE ═══`);

      // Reset all players, clear raid
      await withTransaction(async (tx) => {
        const goldPenalty = 0.10;
        for (const p of Object.values(cs.players)) {
          await tx.query('UPDATE fantasy_characters SET hp=max_hp, mp=max_mp, gold=GREATEST(0, gold - FLOOR(gold*$1)), raid_state=NULL WHERE id=$2',
            [goldPenalty, Number(p.charId)]);
          await addLog(Number(p.charId), 'raid', `💀 Party wiped in ${cs.raidSlug}. Lost 10% gold.`, tx);
        }
        const rs = party.raid_state;
        for (const p of Object.values(cs.players)) {
          await tx.query('INSERT INTO fantasy_raid_runs (char_id, raid_slug, floors_reached, completed, ended_at) VALUES ($1,$2,$3,FALSE,NOW())',
            [Number(p.charId), rs?.raidSlug || 'unknown', rs?.floorsCleared || 0]);
        }
        // Disband party
        await tx.query("UPDATE fantasy_parties SET state='disbanded', combat_state=NULL, raid_state=NULL WHERE id=$1", [party.id]);
        const members = await q('SELECT char_id FROM fantasy_party_members WHERE party_id=$1', [party.id], tx);
        for (const m of members) {
          await tx.query('UPDATE fantasy_characters SET party_id=NULL, raid_state=NULL WHERE id=$1', [m.char_id]);
        }
        await tx.query('DELETE FROM fantasy_party_members WHERE party_id=$1', [party.id]);
      });
    } else {
      // Next round
      cs.phase = 'submit';
      cs.roundDeadline = new Date(Date.now() + ROUND_TIMEOUT_MS).toISOString();
    }

    cs.roundLog = log;
    await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(cs), party.id]);
  }

  function adjustPlayerMomentum(player, delta) {
    player.momentum = Math.max(0, Math.min(MOMENTUM_MAX, (player.momentum || 0) + delta));
  }

  // ── START PARTY COMBAT (called by party-raid flow) ──
  ctx.startPartyCombat = async function(partyId, enemies, raidState, opts = {}) {
    const party = await q1('SELECT * FROM fantasy_parties WHERE id=$1', [partyId]);
    if (!party) return;
    const members = await q('SELECT * FROM fantasy_party_members WHERE party_id=$1', [partyId]);
    party.members = members;

    const cs = await buildPartyCombatState(party, enemies, raidState, opts);
    await db.query('UPDATE fantasy_parties SET combat_state=$1 WHERE id=$2', [JSON.stringify(cs), partyId]);
    return cs;
  };

  // ── CHECK IF IN PARTY COMBAT ──
  ctx.isInPartyCombat = function(party) {
    return party && party.combat_state && ['submit', 'resolving'].includes(party.combat_state.phase);
  };
}

module.exports = { register };
