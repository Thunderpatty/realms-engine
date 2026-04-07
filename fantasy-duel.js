// ═══════════════════════════════════════════════════════════════════
// FANTASY DUEL — PvP Duel Module
// Turn-based PvP combat with wager system, lobby presence,
// and forked combat logic independent from PvE.
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

// Load shared game data from game-config.json — single source of truth
const GAME_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'game-config.json'), 'utf8'));
const { validate, schemas } = require('./validation');

const { RACES, CLASSES, STATUS_EFFECTS, EQUIPMENT_SLOTS } = (() => {
  // Load from config so PvP always has the same classes/abilities as PvE

  const RACES = GAME_CONFIG.races || [
    { slug: 'human', name: 'Human', stats: { str: 1, con: 1, int: 1, wis: 1, dex: 1, cha: 1 } },
    { slug: 'elf', name: 'Elf', stats: { str: -1, con: -1, int: 2, wis: 2, dex: 3, cha: 1 } },
    { slug: 'dwarf', name: 'Dwarf', stats: { str: 2, con: 3, int: 0, wis: 1, dex: -1, cha: 0 } },
    { slug: 'halfling', name: 'Halfling', stats: { str: -2, con: 1, int: 0, wis: 1, dex: 3, cha: 2 } },
    { slug: 'orc', name: 'Half-Orc', stats: { str: 4, con: 2, int: -2, wis: 0, dex: 0, cha: -1 } },
  ];

  const CLASSES = GAME_CONFIG.classes || [];


  const STATUS_EFFECTS = GAME_CONFIG.statusEffects || {};

  const EQUIPMENT_SLOTS = ['weapon', 'shield', 'body', 'helmet', 'gloves', 'boots', 'amulet', 'ring', 'trinket'];

  return { RACES, CLASSES, STATUS_EFFECTS, EQUIPMENT_SLOTS };
})();


// ═══════════════════════════════════════════════════════════════════
// PVP COMBAT ENGINE (forked from PvE — independent tuning)
// ═══════════════════════════════════════════════════════════════════

const PVP_DAMAGE_SCALE = 0.70;  // PvP damage is 70% of PvE to avoid one-shots
const PVP_HEAL_SCALE   = 0.80;  // Heals slightly reduced in PvP
const DUEL_TIMEOUT_MS  = 120_000; // 2 minutes no action → auto-forfeit
const LOBBY_STALE_SEC  = 15;     // lobby presence drops after 15s

function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function pvpComputeStats(char, equipment) {
  const race = RACES.find(r => r.slug === char.race);
  const cls = CLASSES.find(c => c.slug === char.class);
  const base = { str: 8, con: 8, int: 8, wis: 8, dex: 8, cha: 8 };
  const stats = { ...base };
  if (race) {
    for (const [k, v] of Object.entries(race.stats)) stats[k] += v;
  }
  const broadGrowth = Math.floor((char.level - 1) / 5);
  stats.str += broadGrowth;
  stats.con += broadGrowth;
  stats.int += broadGrowth;
  stats.wis += broadGrowth;
  stats.dex += broadGrowth;
  stats.cha += Math.floor((char.level - 1) / 6);
  if (cls?.primaryStat && stats[cls.primaryStat] !== undefined) {
    stats[cls.primaryStat] += Math.floor((char.level - 1) / 2);
  }
  let bonusAttack = 0;
  let bonusDefense = 0;
  if (equipment) {
    for (const eq of Object.values(equipment)) {
      if (eq && eq.stats) {
        for (const [k, v] of Object.entries(eq.stats)) {
          if (k === 'attack') bonusAttack += v;
          else if (k === 'defense') bonusDefense += v;
          else if (stats[k] !== undefined) stats[k] += v;
        }
      }
    }
  }
  const primaryStat = stats[cls?.primaryStat || 'str'];
  const attack = Math.floor(primaryStat * 1.18) + bonusAttack + Math.floor(char.level * 0.35);
  const defense = Math.floor((stats.con * 0.6) + (stats.dex * 0.35)) + bonusDefense;
  return { ...stats, attack, defense };
}

function pvpGetEquipmentPassives(equipment) {
  return Object.values(equipment || {})
    .filter(Boolean)
    .map(eq => ({ source: eq.name || eq.slug, slot: eq.slot, ...(eq.passive || {}) }))
    .filter(passive => Object.keys(passive).length > 2);
}

// ── Status effect helpers (forked, identical logic, isolated) ──

function pvpApplyEffect(effectsArray, effectSlug, turns, source) {
  const def = STATUS_EFFECTS[effectSlug];
  if (!def) return null;
  const effectiveTurns = effectSlug === 'stun' ? turns + 1 : turns;
  const existing = effectsArray.find(e => e.slug === effectSlug);
  if (existing && !def.stackable) {
    existing.turnsLeft = Math.max(existing.turnsLeft, effectiveTurns);
    return null;
  }
  const effect = { slug: effectSlug, name: def.name, icon: def.icon, type: def.type, turnsLeft: effectiveTurns, source: source || def.name, description: def.description || '' };
  if (def.damagePerTurn) effect.damagePerTurn = def.damagePerTurn;
  if (def.healPerTurn) effect.healPerTurn = def.healPerTurn;
  if (def.statMod) effect.statMod = { ...def.statMod };
  effectsArray.push(effect);
  return effect;
}

function pvpRemoveEffect(effectsArray, effectSlug) {
  const idx = effectsArray.findIndex(e => e.slug === effectSlug);
  if (idx !== -1) return effectsArray.splice(idx, 1)[0];
  return null;
}

function pvpGetEffectStatMods(effectsArray) {
  const mods = {};
  for (const eff of effectsArray) {
    if (eff.statMod) {
      for (const [k, v] of Object.entries(eff.statMod)) {
        mods[k] = (mods[k] || 0) + v;
      }
    }
  }
  return mods;
}

function pvpTickEffects(effectsArray, targetName, targetHp, targetMaxHp, log) {
  let hpChange = 0;
  for (const eff of effectsArray) {
    if (eff.damagePerTurn && eff.turnsLeft > 0) {
      hpChange -= eff.damagePerTurn;
      log.push(`${eff.icon} ${targetName} takes ${eff.damagePerTurn} ${eff.name.toLowerCase()} damage.`);
    }
    if (eff.healPerTurn && eff.turnsLeft > 0) {
      const healed = Math.min(eff.healPerTurn, targetMaxHp - targetHp - hpChange);
      if (healed > 0) {
        hpChange += healed;
        log.push(`${eff.icon} ${targetName} regenerates ${healed} HP.`);
      }
    }
    eff.turnsLeft--;
  }
  const expired = effectsArray.filter(e => e.turnsLeft <= 0);
  for (const e of expired) {
    effectsArray.splice(effectsArray.indexOf(e), 1);
    log.push(`${e.icon} ${e.name} wears off on ${targetName}.`);
  }
  return hpChange;
}

function pvpIsStunned(effectsArray) {
  return effectsArray.some(e => e.slug === 'stun' && e.turnsLeft > 0);
}

function pvpApplyDefenseReduction(rawDmg, defense) {
  const reduction = defense / (defense + 50);
  return Math.max(1, Math.floor(rawDmg * (1 - reduction)));
}

function pvpCalcDodgeChance(dex) {
  return Math.min(18, Math.floor((dex || 0) * 0.6) + 2);
}
function pvpCalcCritChance(cha) {
  return Math.min(18, Math.floor((cha || 0) * 0.6) + 2);
}

function pvpApplyDamagePassives(attacker, defenderName, damageDealt, passives, defenderEffects, log) {
  if (!damageDealt || damageDealt <= 0) return;
  for (const passive of (passives || [])) {
    if (passive.lifestealPct) {
      const healed = Math.min(attacker.maxHp - attacker.hp, Math.max(0, Math.floor(damageDealt * (passive.lifestealPct / 100))));
      if (healed > 0) {
        attacker.hp += healed;
        log.push(`🩸 ${passive.source} restores ${healed} HP through lifesteal.`);
      }
    }
    if (passive.onHitStatus && rand(1, 100) <= (passive.onHitStatus.chance || 100)) {
      const status = passive.onHitStatus;
      const eff = pvpApplyEffect(defenderEffects, status.slug, status.turns || 1, passive.source);
      if (eff) {
        log.push(`${eff.icon} ${passive.source} inflicts ${eff.name} on ${defenderName}!`);
      }
    }
  }
}

function pvpApplyTurnRegenPassives(fighter, passives, log) {
  for (const passive of (passives || [])) {
    if (passive.manaRegen) {
      const restored = Math.min(passive.manaRegen, fighter.maxMp - fighter.mp);
      if (restored > 0) { fighter.mp += restored; log.push(`✨ ${passive.source} restores ${restored} MP.`); }
    }
    if (passive.hpRegen) {
      const healed = Math.min(passive.hpRegen, fighter.maxHp - fighter.hp);
      if (healed > 0) { fighter.hp += healed; log.push(`💚 ${passive.source} restores ${healed} HP.`); }
    }
  }
}

// ── Core PvP action processing ──

// PvP ability cooldowns (in turns). 0 or absent = no cooldown.
// PvP cooldowns: derived from PvE cooldowns (game-config) with ~1.3x multiplier
// Manual overrides for key abilities, auto-generated for everything else
const PVP_COOLDOWN_OVERRIDES = {
  'power-strike': 0, 'ice-lance': 0, 'smite': 0, 'twin-shot': 0, 'marked-shot': 0, // fillers stay 0
  'shield-bash': 4, 'frost-nova': 5, 'cheap-shot': 4, 'trap': 4, // stuns stay high
  'evade': 5, 'camouflage': 5, 'blink': 5, 'smoke-bomb': 5, // dodge buffs stay high
  'mana-surge': 5, 'bless': 5, 'resurrection': 6, 'meteor': 6, // big abilities stay high
};
const PVP_COOLDOWNS = (() => {
  const pveCooldowns = GAME_CONFIG.pveCooldowns || {};
  const result = {};
  // Start with PvE cooldowns scaled up ~1.3x for PvP
  for (const [slug, cd] of Object.entries(pveCooldowns)) {
    result[slug] = cd === 0 ? 0 : Math.ceil(cd * 1.3);
  }
  // Apply manual overrides
  Object.assign(result, PVP_COOLDOWN_OVERRIDES);
  return result;
})();

// ── PVP MOMENTUM ──
const PVP_MOMENTUM_MAX = 10;
const PVP_MOMENTUM_THRESHOLDS = [
  { min: 0, name: null, dmgBonus: 0, critBonus: 0, mpDiscount: 0 },
  { min: 3, name: 'Warmed Up', dmgBonus: 0.05, critBonus: 0, mpDiscount: 0 },
  { min: 5, name: 'In The Zone', dmgBonus: 0.10, critBonus: 5, mpDiscount: 0 },
  { min: 7, name: 'Battle Focus', dmgBonus: 0.15, critBonus: 10, mpDiscount: 0.10 },
  { min: 9, name: 'Unstoppable', dmgBonus: 0.25, critBonus: 15, mpDiscount: 0.25 },
];
function pvpGetMomentumTier(m) {
  for (let i = PVP_MOMENTUM_THRESHOLDS.length - 1; i >= 0; i--) {
    if (m >= PVP_MOMENTUM_THRESHOLDS[i].min) return PVP_MOMENTUM_THRESHOLDS[i];
  }
  return PVP_MOMENTUM_THRESHOLDS[0];
}
function pvpAdjustMomentum(actor, delta, log) {
  const old = actor.momentum || 0;
  actor.momentum = Math.max(0, Math.min(PVP_MOMENTUM_MAX, old + delta));
  const oldTier = pvpGetMomentumTier(old);
  const newTier = pvpGetMomentumTier(actor.momentum);
  if (newTier.name && newTier.name !== oldTier.name) {
    log.push(`⚡ ${actor.name}: ${newTier.name}! (Momentum ${actor.momentum}/${PVP_MOMENTUM_MAX})`);
  }
}

// ── PVP COMBOS ──
const PVP_COMBOS = GAME_CONFIG.combos || [];

function pvpProcessAction(duelData, actorKey, action, abilitySlug) {
  const defenderKey = actorKey === 'challenger' ? 'defender' : 'challenger';
  const actor = duelData[actorKey];
  const defender = duelData[defenderKey];
  const cls = CLASSES.find(c => c.slug === actor.class);
  const log = [];

  actor.effects = actor.effects || [];
  defender.effects = defender.effects || [];
  actor.buffs = actor.buffs || [];

  // Compute effective stats with effects
  const actorEffectMods = pvpGetEffectStatMods(actor.effects);
  const effectiveStats = { ...actor.stats };
  for (const [k, v] of Object.entries(actorEffectMods)) {
    if (effectiveStats[k] !== undefined) effectiveStats[k] = Math.max(0, effectiveStats[k] + v);
  }
  // Recompute attack/defense with mods
  const primaryStat = effectiveStats[cls?.primaryStat || 'str'];
  effectiveStats.attack = Math.floor(primaryStat * 1.18) + (actor.bonusAttack || 0) + Math.floor(actor.level * 0.35) + (actorEffectMods.attack || 0);
  effectiveStats.defense = Math.floor((effectiveStats.con * 0.6) + (effectiveStats.dex * 0.35)) + (actor.bonusDefense || 0) + (actorEffectMods.defense || 0);

  const defenderEffectMods = pvpGetEffectStatMods(defender.effects);
  const defenderCls = CLASSES.find(c => c.slug === defender.class);
  const defPrimaryStat = Math.max(0, (defender.stats[defenderCls?.primaryStat || 'str'] || 8) + (defenderEffectMods[defenderCls?.primaryStat || 'str'] || 0));
  const effectiveDefenderDefense = Math.max(0,
    Math.floor(((defender.stats.con + (defenderEffectMods.con || 0)) * 0.6) + ((defender.stats.dex + (defenderEffectMods.dex || 0)) * 0.35))
    + (defender.bonusDefense || 0) + (defenderEffectMods.defense || 0)
  );

  let totalDamage = 0;

  // Compute defender's passive dodge chance from dex
  const defenderDex = Math.max(0, (defender.stats.dex || 8) + (defenderEffectMods.dex || 0));
  const defenderDodgeChance = pvpCalcDodgeChance(defenderDex);
  // Compute attacker's crit chance from cha
  const actorCha = Math.max(0, (actor.stats.cha || 8) + (actorEffectMods.cha || 0));
  const actorCritChance = pvpCalcCritChance(actorCha);

  // Check stun
  // Clear defend flag from previous turn
  actor.defending = false;

  if (pvpIsStunned(actor.effects) && action !== 'forfeit') {
    log.push(`💫 ${actor.name} is stunned and cannot act!`);
  } else {

    // ── Apply buff bonuses to actor ──
    let buffBonusStr = 0, buffBonusDef = 0;
    for (const b of actor.buffs) {
      if (b.stat === 'str') buffBonusStr += b.amount;
      if (b.stat === 'defense') buffBonusDef += b.amount;
      if (b.stat === 'all') { buffBonusStr += b.amount; buffBonusDef += b.amount; }
    }

    if (action === 'attack') {
      const atkMTier = pvpGetMomentumTier(actor.momentum || 0);
      if (rand(1, 100) <= defenderDodgeChance) {
        log.push(`${defender.name} dodges ${actor.name}'s attack!`);
      } else {
        const totalDef = effectiveDefenderDefense + getDefenderBuffDef(defender);
        const rawDmg = Math.max(1, pvpApplyDefenseReduction(Math.floor((effectiveStats.attack + buffBonusStr) * 0.92) + rand(0, 3), totalDef));
        const isCrit = rand(1, 100) <= (actorCritChance + atkMTier.critBonus);
        let dmg = Math.max(1, Math.floor(rawDmg * PVP_DAMAGE_SCALE * (isCrit ? 1.5 : 1)));
        if (atkMTier.dmgBonus > 0) dmg = Math.floor(dmg * (1 + atkMTier.dmgBonus));
        if (defender.defending) dmg = Math.max(1, Math.floor(dmg * 0.5));
        defender.hp -= dmg;
        totalDamage += dmg;
        log.push(isCrit ? `⚡ Critical hit! ${actor.name} strikes ${defender.name} for ${dmg} damage!` : `⚔ ${actor.name} strikes ${defender.name} for ${dmg} damage.`);
      }

    } else if (action === 'ability') {
      const ability = cls?.abilities.find(a => a.slug === abilitySlug);
      if (!ability) return { error: 'Unknown ability.' };
      // Cooldown check
      actor.cooldowns = actor.cooldowns || {};
      if (actor.cooldowns[ability.slug] > 0) return { error: `${ability.name} is on cooldown (${actor.cooldowns[ability.slug]} turns).` };

      // Ability rank scaling
      const abilityRank = (actor.abilityRanks || {})[ability.slug] || 1;
      const rankData = ability.ranks?.[abilityRank - 1] || {};
      const rankedDamage = rankData.damage || ability.damage || 0;
      const rankedHealPct = rankData.healPct || ability.healPct || 0;
      const rankBonusCrit = rankData.bonusCritChance || 0;
      const rankBonusDmgFlat = rankData.bonusDamageFlat || 0;

      // Momentum MP discount
      const mTier = pvpGetMomentumTier(actor.momentum || 0);
      let effectiveCost = ability.cost;
      if (mTier.mpDiscount > 0) effectiveCost = Math.floor(effectiveCost * (1 - mTier.mpDiscount));
      if (actor.mp < effectiveCost) return { error: 'Not enough MP.' };
      actor.mp -= effectiveCost;

      // Combo detection
      const activeCombo = PVP_COMBOS.find(c => c.class === actor.class && c.first === actor.lastAbilitySlug && c.second === abilitySlug) || null;
      if (activeCombo) log.push(`⚡ COMBO: ${activeCombo.name}!`);

      // Set cooldown
      const cd = PVP_COOLDOWNS[ability.slug] || 0;
      if (cd > 0) actor.cooldowns[ability.slug] = cd;

      if (ability.type === 'physical' || ability.type === 'magic') {
        // Self-damage always applies regardless of dodge (combo can suppress)
        if (ability.selfDamagePct && !activeCombo?.effect?.noSelfDamage) {
          const selfDmg = Math.max(1, Math.floor(actor.maxHp * ability.selfDamagePct / 100));
          actor.hp -= selfDmg;
          log.push(`💢 The reckless strike costs ${actor.name} ${selfDmg} HP!`);
        }
        // Self-heal always applies regardless of dodge
        if (ability.healPct) {
          const healAmt = Math.max(1, Math.floor(actor.maxHp * ability.healPct / 100 * PVP_HEAL_SCALE));
          const healed = Math.min(healAmt, actor.maxHp - actor.hp);
          actor.hp += healed;
          if (healed > 0) log.push(`💚 ${ability.name} restores ${healed} HP to ${actor.name}.`);
        }
        // Dodge check
        if (rand(1, 100) <= defenderDodgeChance) {
          log.push(`${defender.name} dodges ${actor.name}'s ${ability.name}!`);
        } else {
          const baseDmg = ability.type === 'magic'
            ? Math.floor(((effectiveStats.int + buffBonusStr) * 1.08) + (actor.level * 0.4))
            : Math.floor((effectiveStats.attack + buffBonusStr) * 0.95);
          const hits = ability.hits || 1;
          const isCrit = activeCombo?.effect?.guaranteedCrit ? true : (rand(1, 100) <= (actorCritChance + rankBonusCrit + mTier.critBonus));
          let abilityTotalDmg = 0;
          for (let i = 0; i < hits; i++) {
            const rawHit = Math.max(1, pvpApplyDefenseReduction(Math.floor(baseDmg * rankedDamage) + rand(0, 2) + rankBonusDmgFlat, effectiveDefenderDefense + getDefenderBuffDef(defender)));
            abilityTotalDmg += Math.max(1, Math.floor(rawHit * PVP_DAMAGE_SCALE));
          }
          if (isCrit) abilityTotalDmg = Math.floor(abilityTotalDmg * 1.5);
          // Momentum damage bonus
          if (mTier.dmgBonus > 0) abilityTotalDmg = Math.floor(abilityTotalDmg * (1 + mTier.dmgBonus));
          // Combo damage bonus
          if (activeCombo?.effect?.damageMult) abilityTotalDmg = Math.floor(abilityTotalDmg * activeCombo.effect.damageMult);
          if (defender.defending) abilityTotalDmg = Math.max(1, Math.floor(abilityTotalDmg * 0.5));
          defender.hp -= abilityTotalDmg;
          totalDamage += abilityTotalDmg;
          log.push(isCrit ? `⚡ Critical hit! ${actor.name} uses ${ability.name} for ${abilityTotalDmg} damage!` : `✦ ${actor.name} uses ${ability.name} for ${abilityTotalDmg} damage!`);
          if (ability.stun) {
            const eff = pvpApplyEffect(defender.effects, 'stun', 1, ability.name);
            if (eff) log.push(`💫 ${defender.name} is stunned!`);
          }
          if (ability.slow) {
            const eff = pvpApplyEffect(defender.effects, 'slow', 3, ability.name);
            if (eff) log.push(`🐌 ${defender.name} is slowed!`);
          }
          if (ability.dot) {
            const dotSlug = ability.dot.type || 'poison';
            const eff = pvpApplyEffect(defender.effects, dotSlug, ability.dot.turns || 3, ability.name);
            if (eff) {
              eff.damagePerTurn = ability.dot.damage || STATUS_EFFECTS[dotSlug]?.damagePerTurn || 3;
              log.push(`${STATUS_EFFECTS[dotSlug]?.icon || '🧪'} ${ability.name} applies ${STATUS_EFFECTS[dotSlug]?.name || dotSlug}!`);
            }
          }
          if (ability.statusEffect) {
            const se = ability.statusEffect;
            const eff = pvpApplyEffect(defender.effects, se.slug, se.turns || 3, ability.name);
            if (eff) log.push(`${STATUS_EFFECTS[se.slug]?.icon || '✦'} ${ability.name} applies ${STATUS_EFFECTS[se.slug]?.name || se.slug}!`);
          }
        }

      } else if (ability.type === 'buff') {
        const buffDurBonus = rankData.durationBonus || 0;
        const buffStrBonus = rankData.buffBonus || 0;
        const scaledBuff = { ...ability.buff, name: ability.name, turnsLeft: (ability.buff.turns || 3) + buffDurBonus };
        if (buffStrBonus > 0) {
          for (const k of Object.keys(scaledBuff)) {
            if (typeof scaledBuff[k] === 'number' && !['turns', 'turnsLeft'].includes(k)) {
              scaledBuff[k] = Math.floor(scaledBuff[k] * (1 + buffStrBonus));
            }
          }
        }
        actor.buffs.push(scaledBuff);
        if (ability.secondaryBuff) {
          actor.buffs.push({ ...ability.secondaryBuff, name: ability.name + ' (2)', turnsLeft: ability.secondaryBuff.turns });
        }
        if (ability.restoreMp) {
          const restored = Math.min(ability.restoreMp, actor.maxMp - actor.mp);
          actor.mp += restored;
          if (restored > 0) log.push(`✨ ${actor.name} recovers ${restored} MP.`);
        }
        log.push(`${actor.name} uses ${ability.name}.`);

      } else if (ability.type === 'heal') {
        let healAmount = rankedHealPct
          ? Math.max(1, Math.floor(actor.maxHp * rankedHealPct / 100 * PVP_HEAL_SCALE))
          : Math.floor((ability.heal || 0) * PVP_HEAL_SCALE);
        if (activeCombo?.effect?.healBonus) healAmount = Math.floor(healAmount * activeCombo.effect.healBonus);
        const healed = Math.min(healAmount, actor.maxHp - actor.hp);
        actor.hp += healed;
        log.push(`${actor.name} uses ${ability.name} and recovers ${healed} HP.`);

      } else if (ability.type === 'restore') {
        const restored = Math.min(ability.restore, actor.maxMp - actor.mp);
        actor.mp += restored;
        log.push(`${actor.name} uses ${ability.name} and recovers ${restored} MP.`);

      } else if (ability.type === 'purify') {
        const removable = (actor.effects || []).filter(e => {
          const def = STATUS_EFFECTS[e.slug];
          return def && (def.type === 'dot' || def.type === 'debuff' || def.type === 'cc');
        });
        if (removable.length > 0) {
          for (const eff of removable) pvpRemoveEffect(actor.effects, eff.slug);
          log.push(`✨ ${ability.name} cleanses ${removable.map(e => e.name).join(', ')}!`);
        } else {
          log.push(`${actor.name} uses ${ability.name}, but there was nothing to cleanse.`);
        }
        if (ability.healPct) {
          const healAmount = Math.max(1, Math.floor(actor.maxHp * ability.healPct / 100 * PVP_HEAL_SCALE));
          const healed = Math.min(healAmount, actor.maxHp - actor.hp);
          actor.hp += healed;
          if (healed > 0) log.push(`💚 ${ability.name} restores ${healed} HP to ${actor.name}.`);
        }
      }

    } else if (action === 'defend') {
      actor.defending = true;
      log.push(`🛡 ${actor.name} braces for impact, reducing incoming damage.`);

    } else if (action === 'forfeit') {
      actor.hp = 0;
      log.push(`🏳 ${actor.name} forfeits the duel!`);
    } else {
      return { error: 'Invalid action.' };
    }
  } // end stun check

  // ── Momentum tracking ──
  actor.momentum = actor.momentum || 0;
  if (action === 'attack' || action === 'ability') {
    pvpAdjustMomentum(actor, 1, log);
  } else if (action === 'defend') {
    pvpAdjustMomentum(actor, 2, log);
  }
  // Track last ability for combos
  if (action === 'ability' && abilitySlug) {
    actor.lastAbilitySlug = abilitySlug;
  } else if (action !== 'ability') {
    actor.lastAbilitySlug = null;
  }

  // Momentum loss when taking damage (applied to defender)
  if (totalDamage > 0) {
    pvpAdjustMomentum(defender, -1, log);
  }

  // Apply damage passives (lifesteal, on-hit effects)
  if (totalDamage > 0) {
    pvpApplyDamagePassives(actor, defender.name, totalDamage, actor.passives || [], defender.effects, log);
  }

  // Tick defender effects (DoTs)
  if (defender.effects.length > 0) {
    const defHpDelta = pvpTickEffects(defender.effects, defender.name, defender.hp, defender.maxHp, log);
    defender.hp += defHpDelta;
  }

  // Tick actor effects
  if (actor.effects.length > 0) {
    const actHpDelta = pvpTickEffects(actor.effects, actor.name, actor.hp, actor.maxHp, log);
    actor.hp += actHpDelta;
    actor.hp = Math.min(actor.hp, actor.maxHp);
  }

  // Regen passives for actor
  pvpApplyTurnRegenPassives(actor, actor.passives || [], log);

  // Tick buffs
  for (const b of actor.buffs) b.turnsLeft--;
  actor.buffs = actor.buffs.filter(b => b.turnsLeft > 0);

  // Tick cooldowns
  actor.cooldowns = actor.cooldowns || {};
  for (const slug of Object.keys(actor.cooldowns)) {
    actor.cooldowns[slug]--;
    if (actor.cooldowns[slug] <= 0) delete actor.cooldowns[slug];
  }

  // Cap HP
  defender.hp = Math.max(0, Math.min(defender.hp, defender.maxHp));
  actor.hp = Math.max(0, Math.min(actor.hp, actor.maxHp));

  // Advance turn
  duelData.turnNumber = (duelData.turnNumber || 1) + 1;
  duelData.log = duelData.log || [];
  duelData.log.push(...log);

  // Check victory
  let winner = null;
  if (defender.hp <= 0 && actor.hp <= 0) {
    // Both die → attacker wins (they acted last)
    winner = actorKey;
    duelData.log.push(`☠ Both fighters fall — ${actor.name} claims victory by striking the final blow!`);
  } else if (defender.hp <= 0) {
    winner = actorKey;
    duelData.log.push(`☠ ${defender.name} falls! ${actor.name} wins the duel!`);
  } else if (actor.hp <= 0) {
    winner = defenderKey;
    duelData.log.push(`☠ ${actor.name} collapses! ${defender.name} wins the duel!`);
  }

  return { log, winner, duelData };
}

function getDefenderBuffDef(defender) {
  let bonus = 0;
  for (const b of (defender.buffs || [])) {
    if (b.stat === 'defense') bonus += b.amount;
    if (b.stat === 'all') bonus += b.amount;
  }
  return bonus;
}


// ═══════════════════════════════════════════════════════════════════
// DATABASE + ROUTES
// ═══════════════════════════════════════════════════════════════════

async function initDuelDb(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS fantasy_duel_lobby (
      char_id INTEGER PRIMARY KEY REFERENCES fantasy_characters(id) ON DELETE CASCADE,
      char_name TEXT NOT NULL,
      char_level INTEGER NOT NULL,
      char_class TEXT NOT NULL,
      char_race TEXT NOT NULL,
      last_seen TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS fantasy_duels (
      id SERIAL PRIMARY KEY,
      challenger_id INTEGER NOT NULL REFERENCES fantasy_characters(id) ON DELETE CASCADE,
      defender_id INTEGER NOT NULL REFERENCES fantasy_characters(id) ON DELETE CASCADE,
      state TEXT NOT NULL DEFAULT 'pending',
      turn_char_id INTEGER,
      wager INTEGER NOT NULL DEFAULT 0,
      combat_data JSONB,
      winner_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS fantasy_duel_history (
      id SERIAL PRIMARY KEY,
      challenger_id INTEGER NOT NULL REFERENCES fantasy_characters(id) ON DELETE CASCADE,
      defender_id INTEGER NOT NULL REFERENCES fantasy_characters(id) ON DELETE CASCADE,
      challenger_name TEXT NOT NULL,
      defender_name TEXT NOT NULL,
      challenger_class TEXT NOT NULL,
      defender_class TEXT NOT NULL,
      challenger_level INTEGER NOT NULL,
      defender_level INTEGER NOT NULL,
      winner_id INTEGER,
      winner_name TEXT NOT NULL,
      wager INTEGER NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      finished_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Clean up any stale state on startup
  await db.query(`DELETE FROM fantasy_duel_lobby`);
  await db.query(`UPDATE fantasy_duels SET state = 'expired' WHERE state IN ('pending', 'active')`);
}


function registerDuelRoutes(app, db, requireAuth) {

  // Helper: get character for this user
  async function getChar(userId, activeCharId) {
    if (activeCharId) {
      const res = await db.query('SELECT * FROM fantasy_characters WHERE id = $1 AND user_id = $2', [activeCharId, userId]);
      return res.rows[0] || null;
    }
    const res = await db.query('SELECT * FROM fantasy_characters WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
    return res.rows[0] || null;
  }

  // Helper: get equipment map
  async function getEquipment(charId) {
    const rows = (await db.query('SELECT * FROM fantasy_equipment WHERE char_id = $1', [charId])).rows;
    const itemsContent = require('./fantasy-rpg').getContent?.() || {};
    const items = itemsContent.items || {};
    const map = {};
    for (const row of rows) {
      const item = items[row.item_slug] || {};
      map[row.slot] = { slug: row.item_slug, name: item.name || row.item_slug, stats: item.stats || {}, rarity: item.rarity || 'common', passive: item.passive || null, slot: row.slot };
    }
    return map;
  }

  // Helper: snapshot a character for duel combat_data
  async function snapshotFighter(charId) {
    const char = (await db.query('SELECT * FROM fantasy_characters WHERE id = $1', [charId])).rows[0];
    if (!char) return null;
    const equipment = await getEquipment(charId);
    const stats = pvpComputeStats(char, equipment);
    const cls = CLASSES.find(c => c.slug === char.class);
    const passives = pvpGetEquipmentPassives(equipment);

    // Compute bonus attack/defense from equipment for later buff calc
    let bonusAttack = 0, bonusDefense = 0;
    for (const eq of Object.values(equipment)) {
      if (eq?.stats) {
        bonusAttack += (eq.stats.attack || 0);
        bonusDefense += (eq.stats.defense || 0);
      }
    }

    return {
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
      bonusAttack,
      bonusDefense,
      abilityRanks: char.ability_ranks || {},
      momentum: 0,
      lastAbilitySlug: null,
      abilities: (() => {
        // Use character's PvP loadout (falls back to PvE loadout, then starters)
        const racialAbility = GAME_CONFIG.racialAbilities?.[char.race] || null;
        const allClassAbils = cls?.abilities || [];
        const pvpRaw = char.active_abilities_pvp ? (typeof char.active_abilities_pvp === 'string' ? JSON.parse(char.active_abilities_pvp) : char.active_abilities_pvp) : null;
        const pveRaw = char.active_abilities ? (typeof char.active_abilities === 'string' ? JSON.parse(char.active_abilities) : char.active_abilities) : null;
        const activeSlugs = pvpRaw || pveRaw || null;
        let abilList;
        if (activeSlugs) {
          abilList = activeSlugs.filter(s => s !== racialAbility?.slug).map(s => allClassAbils.find(a => a.slug === s)).filter(Boolean);
        } else {
          abilList = allClassAbils.filter(a => a.starter !== false);
        }
        // Append racial at the end — always present, outside loadout count
        if (racialAbility) abilList.push(racialAbility);
        return abilList;
      })(),
      equipment,
      passives,
      effects: [],
      buffs: [],
      cooldowns: {},
    };
  }

  // ─── Serve duel page ──────────────────────────────────────────

  app.get('/duel', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.sendFile(path.join(__dirname, 'public', 'duel.html'));
  });

  // ─── HEARTBEAT — lobby presence + return lobby + pending duels ─

  app.post('/api/duel/heartbeat', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      // Upsert lobby presence
      await db.query(`
        INSERT INTO fantasy_duel_lobby (char_id, char_name, char_level, char_class, char_race, last_seen)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (char_id) DO UPDATE SET last_seen = NOW(), char_level = $3, char_class = $4, char_name = $2
      `, [char.id, char.name, char.level, char.class, char.race]);

      // Get lobby (exclude self, only recent)
      const lobby = (await db.query(`
        SELECT char_id, char_name, char_level, char_class, char_race
        FROM fantasy_duel_lobby
        WHERE last_seen > NOW() - INTERVAL '${LOBBY_STALE_SEC} seconds'
        AND char_id != $1
        ORDER BY char_level DESC, char_name ASC
      `, [char.id])).rows;

      // Get pending challenges (incoming)
      const incoming = (await db.query(`
        SELECT d.id, d.challenger_id, d.wager, d.created_at,
               l.char_name, l.char_level, l.char_class, l.char_race
        FROM fantasy_duels d
        JOIN fantasy_duel_lobby l ON l.char_id = d.challenger_id
        WHERE d.defender_id = $1 AND d.state = 'pending'
        ORDER BY d.created_at DESC
      `, [char.id])).rows;

      // Get outgoing challenges
      const outgoing = (await db.query(`
        SELECT d.id, d.defender_id, d.wager, d.created_at,
               l.char_name, l.char_level, l.char_class
        FROM fantasy_duels d
        JOIN fantasy_duel_lobby l ON l.char_id = d.defender_id
        WHERE d.challenger_id = $1 AND d.state = 'pending'
        ORDER BY d.created_at DESC
      `, [char.id])).rows;

      // Check if in active duel
      const activeDuel = (await db.query(`
        SELECT id FROM fantasy_duels
        WHERE state = 'active' AND (challenger_id = $1 OR defender_id = $1)
        LIMIT 1
      `, [char.id])).rows[0];

      // Auto-expire stale pending challenges (older than 30s)
      await db.query(`
        UPDATE fantasy_duels SET state = 'expired'
        WHERE state = 'pending' AND created_at < NOW() - INTERVAL '30 seconds'
      `);

      res.json({
        ok: true,
        charId: char.id,
        charName: char.name,
        charLevel: char.level,
        charClass: char.class,
        charGold: char.gold,
        lobby,
        incoming,
        outgoing,
        activeDuelId: activeDuel?.id || null,
      });
    } catch (e) { console.error('Duel heartbeat error:', e); res.status(500).json({ error: 'Heartbeat failed.' }); }
  });

  // ─── CHALLENGE — send a duel request ──────────────────────────

  app.post('/api/duel/challenge', requireAuth, validate(schemas.duelChallenge), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { targetCharId, wager = 0 } = req.body;
      if (!targetCharId || targetCharId === char.id) return res.status(400).json({ error: 'Invalid target.' });

      const wagerAmount = Math.max(0, Math.min(Math.floor(Number(wager) || 0), char.gold));

      // Check target exists and is in lobby
      const target = (await db.query(`
        SELECT char_id FROM fantasy_duel_lobby
        WHERE char_id = $1 AND last_seen > NOW() - INTERVAL '${LOBBY_STALE_SEC} seconds'
      `, [targetCharId])).rows[0];
      if (!target) return res.status(400).json({ error: 'Player is not in the duel lobby.' });

      // Check not already in a duel
      const existingDuel = (await db.query(`
        SELECT id FROM fantasy_duels
        WHERE state IN ('pending', 'active') AND (challenger_id = $1 OR defender_id = $1)
        LIMIT 1
      `, [char.id])).rows[0];
      if (existingDuel) return res.status(400).json({ error: 'You already have an active challenge or duel.' });

      // Check target not already in a duel
      const targetDuel = (await db.query(`
        SELECT id FROM fantasy_duels
        WHERE state IN ('pending', 'active') AND (challenger_id = $1 OR defender_id = $1)
        LIMIT 1
      `, [targetCharId])).rows[0];
      if (targetDuel) return res.status(400).json({ error: 'That player already has an active challenge or duel.' });

      await db.query(`
        INSERT INTO fantasy_duels (challenger_id, defender_id, state, wager, created_at, updated_at)
        VALUES ($1, $2, 'pending', $3, NOW(), NOW())
      `, [char.id, targetCharId, wagerAmount]);

      res.json({ ok: true });
    } catch (e) { console.error('Duel challenge error:', e); res.status(500).json({ error: 'Challenge failed.' }); }
  });

  // ─── ACCEPT — accept a pending duel ───────────────────────────

  app.post('/api/duel/accept', requireAuth, validate(schemas.duelAccept), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { duelId } = req.body;

      const duel = (await db.query(`
        SELECT * FROM fantasy_duels WHERE id = $1 AND state = 'pending' AND defender_id = $2
      `, [duelId, char.id])).rows[0];
      if (!duel) return res.status(400).json({ error: 'Challenge not found or already accepted.' });

      // Validate wager for both sides
      const challenger = (await db.query('SELECT * FROM fantasy_characters WHERE id = $1', [duel.challenger_id])).rows[0];
      if (!challenger) return res.status(400).json({ error: 'Challenger no longer exists.' });

      const effectiveWager = Math.min(duel.wager, char.gold, challenger.gold);

      // Snapshot both fighters
      const challengerSnap = await snapshotFighter(duel.challenger_id);
      const defenderSnap = await snapshotFighter(duel.defender_id);
      if (!challengerSnap || !defenderSnap) return res.status(400).json({ error: 'Could not load fighter data.' });

      const combatData = {
        challenger: challengerSnap,
        defender: defenderSnap,
        log: [`⚔ DUEL: ${challengerSnap.name} vs ${defenderSnap.name}!${effectiveWager > 0 ? ` Wager: ${effectiveWager} gold.` : ' Friendly duel — no wager.'}`],
        turnNumber: 1,
      };

      // Coin flip for who goes first
      const firstKey = rand(0, 1) === 0 ? 'challenger' : 'defender';
      const firstCharId = firstKey === 'challenger' ? duel.challenger_id : duel.defender_id;
      combatData.log.push(`🪙 ${combatData[firstKey].name} wins the coin toss and strikes first!`);

      await db.query(`
        UPDATE fantasy_duels
        SET state = 'active', turn_char_id = $1, combat_data = $2, wager = $3, updated_at = NOW()
        WHERE id = $4
      `, [firstCharId, JSON.stringify(combatData), effectiveWager, duelId]);

      res.json({ ok: true, duelId });
    } catch (e) { console.error('Duel accept error:', e); res.status(500).json({ error: 'Accept failed.' }); }
  });

  // ─── DECLINE — decline/cancel a pending duel ──────────────────

  app.post('/api/duel/decline', requireAuth, validate(schemas.duelDecline), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { duelId } = req.body;

      const result = await db.query(`
        UPDATE fantasy_duels SET state = 'expired', updated_at = NOW()
        WHERE id = $1 AND state = 'pending' AND (defender_id = $2 OR challenger_id = $2)
      `, [duelId, char.id]);

      if (result.rowCount === 0) return res.status(400).json({ error: 'Challenge not found.' });
      res.json({ ok: true });
    } catch (e) { console.error('Duel decline error:', e); res.status(500).json({ error: 'Decline failed.' }); }
  });

  // ─── STATE — poll current duel state ──────────────────────────

  app.get('/api/duel/state', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const duelId = req.query.duelId;

      const duel = (await db.query(`
        SELECT * FROM fantasy_duels WHERE id = $1 AND (challenger_id = $2 OR defender_id = $2)
      `, [duelId, char.id])).rows[0];
      if (!duel) return res.status(404).json({ error: 'Duel not found.' });

      // Auto-forfeit on timeout
      if (duel.state === 'active') {
        const timeSinceUpdate = Date.now() - new Date(duel.updated_at).getTime();
        if (timeSinceUpdate > DUEL_TIMEOUT_MS) {
          // The player whose turn it is forfeits
          const combatData = duel.combat_data;
          const forfeitKey = duel.turn_char_id === duel.challenger_id ? 'challenger' : 'defender';
          const winnerKey = forfeitKey === 'challenger' ? 'defender' : 'challenger';
          combatData.log.push(`⏰ ${combatData[forfeitKey].name} timed out! ${combatData[winnerKey].name} wins by default.`);
          combatData[forfeitKey].hp = 0;

          const winnerId = winnerKey === 'challenger' ? duel.challenger_id : duel.defender_id;
          await finishDuel(db, duel.id, combatData, winnerId, duel.wager);

          const updatedDuel = (await db.query('SELECT * FROM fantasy_duels WHERE id = $1', [duelId])).rows[0];
          return res.json({ ok: true, duel: sanitizeDuelState(updatedDuel, char.id) });
        }
      }

      res.json({ ok: true, duel: sanitizeDuelState(duel, char.id) });
    } catch (e) { console.error('Duel state error:', e); res.status(500).json({ error: 'State fetch failed.' }); }
  });

  // ─── ACTION — submit a combat turn ────────────────────────────

  app.post('/api/duel/action', requireAuth, validate(schemas.duelAction), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { duelId, action, abilitySlug } = req.body;

      // Optimistic lock: only the player whose turn it is can act
      const duel = (await db.query(`
        SELECT * FROM fantasy_duels
        WHERE id = $1 AND state = 'active' AND turn_char_id = $2
      `, [duelId, char.id])).rows[0];
      if (!duel) return res.status(400).json({ error: 'Not your turn or duel not found.' });

      const combatData = duel.combat_data;
      const actorKey = char.id === duel.challenger_id ? 'challenger' : 'defender';

      const result = pvpProcessAction(combatData, actorKey, action, abilitySlug);
      if (result.error) return res.status(400).json({ error: result.error });

      if (result.winner) {
        const winnerId = result.winner === 'challenger' ? duel.challenger_id : duel.defender_id;
        await finishDuel(db, duel.id, combatData, winnerId, duel.wager);
      } else {
        // Switch turns
        const nextTurnId = char.id === duel.challenger_id ? duel.defender_id : duel.challenger_id;
        await db.query(`
          UPDATE fantasy_duels SET combat_data = $1, turn_char_id = $2, updated_at = NOW()
          WHERE id = $3
        `, [JSON.stringify(combatData), nextTurnId, duel.id]);
      }

      const updatedDuel = (await db.query('SELECT * FROM fantasy_duels WHERE id = $1', [duelId])).rows[0];
      res.json({ ok: true, duel: sanitizeDuelState(updatedDuel, char.id) });
    } catch (e) { console.error('Duel action error:', e); res.status(500).json({ error: 'Action failed.' }); }
  });

  // ─── FORFEIT — surrender ──────────────────────────────────────

  app.post('/api/duel/forfeit', requireAuth, validate(schemas.duelForfeit), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { duelId } = req.body;

      const duel = (await db.query(`
        SELECT * FROM fantasy_duels
        WHERE id = $1 AND state = 'active' AND (challenger_id = $2 OR defender_id = $2)
      `, [duelId, char.id])).rows[0];
      if (!duel) return res.status(400).json({ error: 'Active duel not found.' });

      const combatData = duel.combat_data;
      const forfeitKey = char.id === duel.challenger_id ? 'challenger' : 'defender';
      const winnerKey = forfeitKey === 'challenger' ? 'defender' : 'challenger';
      combatData.log.push(`🏳 ${combatData[forfeitKey].name} forfeits! ${combatData[winnerKey].name} wins!`);
      combatData[forfeitKey].hp = 0;

      const winnerId = winnerKey === 'challenger' ? duel.challenger_id : duel.defender_id;
      await finishDuel(db, duel.id, combatData, winnerId, duel.wager);

      const updatedDuel = (await db.query('SELECT * FROM fantasy_duels WHERE id = $1', [duelId])).rows[0];
      res.json({ ok: true, duel: sanitizeDuelState(updatedDuel, char.id) });
    } catch (e) { console.error('Duel forfeit error:', e); res.status(500).json({ error: 'Forfeit failed.' }); }
  });

  // ─── LEAVE LOBBY — clean presence ─────────────────────────────

  app.post('/api/duel/leave', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.json({ ok: true });

      // Cancel any pending challenges
      await db.query(`
        UPDATE fantasy_duels SET state = 'expired', updated_at = NOW()
        WHERE state = 'pending' AND (challenger_id = $1 OR defender_id = $1)
      `, [char.id]);

      await db.query('DELETE FROM fantasy_duel_lobby WHERE char_id = $1', [char.id]);
      res.json({ ok: true });
    } catch (e) { console.error('Duel leave error:', e); res.status(500).json({ error: 'Leave failed.' }); }
  });

  // ─── HISTORY — duel record for current character ──────────────

  app.get('/api/duel/history', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      const history = (await db.query(`
        SELECT * FROM fantasy_duel_history
        WHERE challenger_id = $1 OR defender_id = $1
        ORDER BY finished_at DESC
        LIMIT 50
      `, [char.id])).rows;

      const wins = history.filter(h => h.winner_id === char.id).length;
      const losses = history.length - wins;

      res.json({ ok: true, history, wins, losses, charId: char.id });
    } catch (e) { console.error('Duel history error:', e); res.status(500).json({ error: 'History failed.' }); }
  });
}


// ── Finish a duel: record history, transfer wager, set state ──

async function finishDuel(db, duelId, combatData, winnerId, wager) {
  const cd = combatData;
  const loserId = winnerId === cd.challenger.charId ? cd.defender.charId : cd.challenger.charId;
  const winnerName = winnerId === cd.challenger.charId ? cd.challenger.name : cd.defender.name;

  // Record history
  await db.query(`
    INSERT INTO fantasy_duel_history
      (challenger_id, defender_id, challenger_name, defender_name, challenger_class, defender_class,
       challenger_level, defender_level, winner_id, winner_name, wager, turns, finished_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
  `, [
    cd.challenger.charId, cd.defender.charId,
    cd.challenger.name, cd.defender.name,
    cd.challenger.class, cd.defender.class,
    cd.challenger.level, cd.defender.level,
    winnerId, winnerName,
    wager || 0,
    cd.turnNumber || 0,
  ]);

  // Transfer wager gold (on actual character rows, not snapshot)
  if (wager > 0) {
    // Deduct from loser (floor at 0)
    await db.query(`UPDATE fantasy_characters SET gold = GREATEST(0, gold - $1) WHERE id = $2`, [wager, loserId]);
    // Award to winner
    await db.query(`UPDATE fantasy_characters SET gold = gold + $1 WHERE id = $2`, [wager, winnerId]);
    combatData.log.push(`💰 ${winnerName} wins ${wager} gold from the wager!`);
  }

  // Update duel record
  await db.query(`
    UPDATE fantasy_duels
    SET state = 'finished', winner_id = $1, combat_data = $2, updated_at = NOW()
    WHERE id = $3
  `, [winnerId, JSON.stringify(combatData), duelId]);
}


// ── Sanitize duel state for client (include everything needed for UI) ──

function sanitizeDuelState(duel, myCharId) {
  const cd = duel.combat_data || {};
  const myKey = myCharId === duel.challenger_id ? 'challenger' : 'defender';
  const opponentKey = myKey === 'challenger' ? 'defender' : 'challenger';

  return {
    id: duel.id,
    state: duel.state,
    wager: duel.wager,
    isMyTurn: duel.state === 'active' && duel.turn_char_id === myCharId,
    turnCharId: duel.turn_char_id,
    myKey,
    winnerId: duel.winner_id,
    iWon: duel.winner_id === myCharId,
    turnNumber: cd.turnNumber || 1,
    me: cd[myKey] ? {
      ...cd[myKey],
      // Don't leak equipment passive internals to opponent
    } : null,
    opponent: cd[opponentKey] ? {
      name: cd[opponentKey].name,
      race: cd[opponentKey].race,
      class: cd[opponentKey].class,
      level: cd[opponentKey].level,
      hp: cd[opponentKey].hp,
      maxHp: cd[opponentKey].maxHp,
      mp: cd[opponentKey].mp,
      maxMp: cd[opponentKey].maxMp,
      stats: cd[opponentKey].stats,
      effects: cd[opponentKey].effects || [],
      buffs: cd[opponentKey].buffs || [],
      equipment: cd[opponentKey].equipment,
    } : null,
    log: cd.log || [],
    updatedAt: duel.updated_at,
  };
}


module.exports = { initDuelDb, registerDuelRoutes };
