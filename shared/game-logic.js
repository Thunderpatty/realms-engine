'use strict';
// ═══════════════════════════════════════════════════════════════════
// SHARED GAME LOGIC — Pure functions extracted for testability
// Used by fantasy-rpg.js (PvE), fantasy-duel.js (PvP), and tests.
// No DB, no Express, no side effects.
// ═══════════════════════════════════════════════════════════════════

const GAME_CONFIG = require('./game-config');

const RACES = GAME_CONFIG.races;
const CLASSES = GAME_CONFIG.classes;
const STATUS_EFFECTS = GAME_CONFIG.statusEffects;
const RACIAL_PASSIVES = GAME_CONFIG.racialPassives;
const PERK_POOLS = GAME_CONFIG.perkPools;
const PERK_PREFIXES = GAME_CONFIG.perkPrefixes;
const DURABILITY_BY_RARITY = GAME_CONFIG.durabilityByRarity;
const EQUIPMENT_SLOTS = GAME_CONFIG.equipmentSlots;

// ─── RNG ─────────────────────────────────────────────────────────

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── XP & LEVELING ──────────────────────────────────────────────

function xpForLevel(level) {
  return Math.floor(120 * Math.pow(level, 1.8));
}

// ─── STAT COMPUTATION ────────────────────────────────────────────

function computeStats(char, equipment) {
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
      // Apply perk stat bonuses
      if (eq && eq.perks) {
        for (const perk of eq.perks) {
          if (perk.type === 'stat' && stats[perk.stat] !== undefined) {
            stats[perk.stat] += perk.value;
          }
        }
      }
    }
  }

  const primaryStat = stats[cls?.primaryStat || 'str'];
  let attack = Math.floor(primaryStat * 1.18) + bonusAttack + Math.floor(char.level * 0.35);
  let defense = Math.floor((stats.con * 0.6) + (stats.dex * 0.35)) + bonusDefense;

  // Apply socket percentage bonuses after flat calc
  let socketAtkPct = 0, socketDefPct = 0;
  if (equipment) {
    for (const eq of Object.values(equipment)) {
      if (eq?.sockets) {
        for (const sock of eq.sockets) {
          if (!sock) continue;
          if (sock.bonus?.attackPct) socketAtkPct += sock.bonus.attackPct;
          if (sock.bonus?.defensePct) socketDefPct += sock.bonus.defensePct;
        }
      }
    }
  }
  if (socketAtkPct) attack = Math.floor(attack * (1 + socketAtkPct / 100));
  if (socketDefPct) defense = Math.floor(defense * (1 + socketDefPct / 100));

  // Apply racial passives (percentage bonuses to defense)
  const rp = RACIAL_PASSIVES[char.race];
  if (rp) {
    if (rp.defensePct) defense = Math.floor(defense * (1 + rp.defensePct / 100));
  }

  return { ...stats, attack, defense };
}

// ─── RACIAL PASSIVES ─────────────────────────────────────────────

function getRacialPassive(race) {
  return RACIAL_PASSIVES[race] || null;
}

function applyRacialDamageBonus(damage, race, abilityType) {
  const rp = RACIAL_PASSIVES[race];
  if (!rp) return damage;
  if ((abilityType === 'physical' || abilityType === 'attack') && rp.physicalDamagePct) {
    return Math.floor(damage * (1 + rp.physicalDamagePct / 100));
  }
  if (abilityType === 'magic' && rp.magicDamagePct) {
    return Math.floor(damage * (1 + rp.magicDamagePct / 100));
  }
  return damage;
}

// ─── COMBAT FORMULAS ─────────────────────────────────────────────

function calcDodgeChance(dex) {
  return Math.min(18, Math.floor((dex || 0) * 0.6) + 2);
}

function calcEnemyDodgeChance(defense) {
  return Math.min(12, Math.floor((defense || 0) * 0.5) + 2);
}

function calcCritChance(cha) {
  return Math.min(18, Math.floor((cha || 0) * 0.6) + 2);
}

function calcEnemyCritChance(attack) {
  return Math.min(10, Math.floor((attack || 0) * 0.3) + 1);
}

function applyDefenseReduction(rawDmg, defense) {
  const reduction = defense / (defense + 50);
  return Math.max(1, Math.floor(rawDmg * (1 - reduction)));
}

// ─── EQUIPMENT HELPERS ───────────────────────────────────────────

function getEquipmentPassives(equipment) {
  const passives = [];
  for (const eq of Object.values(equipment || {})) {
    if (!eq) continue;
    if (eq.passive && Object.keys(eq.passive).length) {
      passives.push({ source: eq.name || eq.slug, slot: eq.slot, ...eq.passive });
    }
    if (eq.sockets) {
      for (const sock of eq.sockets) {
        if (!sock) continue;
        if (sock.bonus?.hpRegenPct) passives.push({ source: (eq.name || eq.slug) + ' [gem]', slot: eq.slot, hpRegenPct: sock.bonus.hpRegenPct });
        if (sock.bonus?.mpRegenPct) passives.push({ source: (eq.name || eq.slug) + ' [gem]', slot: eq.slot, mpRegenPct: sock.bonus.mpRegenPct });
      }
    }
    if (eq.perks) {
      for (const perk of eq.perks) {
        if (perk.type === 'lifesteal') {
          passives.push({ source: eq.name || eq.slug, slot: eq.slot, lifestealPct: perk.value });
        } else if (perk.type === 'hpRegen') {
          passives.push({ source: eq.name || eq.slug, slot: eq.slot, hpRegen: perk.value });
        } else if (perk.type === 'manaRegen') {
          passives.push({ source: eq.name || eq.slug, slot: eq.slot, manaRegen: perk.value });
        } else if (perk.type === 'onHitStatus') {
          passives.push({ source: eq.name || eq.slug, slot: eq.slot, onHitStatus: { slug: perk.slug, chance: perk.chance, turns: perk.turns } });
        }
      }
    }
  }
  return passives;
}

function getEquipmentPerkBonuses(equipment) {
  let critBonus = 0, dodgeBonus = 0;
  for (const eq of Object.values(equipment || {})) {
    if (eq?.perks) {
      for (const perk of eq.perks) {
        if (perk.type === 'critBonus') critBonus += perk.value;
        if (perk.type === 'dodgeBonus') dodgeBonus += perk.value;
      }
    }
    if (eq?.sockets) {
      for (const sock of eq.sockets) {
        if (!sock) continue;
        if (sock.bonus?.critPct) critBonus += sock.bonus.critPct;
        if (sock.bonus?.dodgePct) dodgeBonus += sock.bonus.dodgePct;
      }
    }
  }
  return { critBonus, dodgeBonus };
}

function getCombatPassives(equipment, tempPassives = []) {
  return [
    ...getEquipmentPassives(equipment),
    ...(tempPassives || []).map(passive => ({ ...passive })),
  ];
}

// ─── STATUS EFFECTS ──────────────────────────────────────────────

function applyEffect(effectsArray, effectSlug, turns, source) {
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

function removeEffect(effectsArray, effectSlug) {
  const idx = effectsArray.findIndex(e => e.slug === effectSlug);
  if (idx !== -1) return effectsArray.splice(idx, 1)[0];
  return null;
}

function getEffectStatMods(effectsArray) {
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

function tickEffects(effectsArray, targetName, targetHp, targetMaxHp, log) {
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
    const idx = effectsArray.indexOf(e);
    effectsArray.splice(idx, 1);
    log.push(`${e.icon} ${e.name} wears off on ${targetName}.`);
  }
  return hpChange;
}

function isStunned(effectsArray) {
  return effectsArray.some(e => e.slug === 'stun' && e.turnsLeft > 0);
}

// ─── PASSIVE APPLICATION ─────────────────────────────────────────

function applyDamagePassives(char, enemy, damageDealt, passives, enemyEffects, log) {
  if (!damageDealt || damageDealt <= 0) return;
  for (const passive of (passives || [])) {
    if (passive.lifestealPct) {
      const healed = Math.min(char.max_hp - char.hp, Math.max(0, Math.floor(damageDealt * (passive.lifestealPct / 100))));
      if (healed > 0) {
        char.hp += healed;
        log.push(`🩸 ${passive.source} restores ${healed} HP through lifesteal.`);
      }
    }
    if (passive.onHitStatus && rand(1, 100) <= (passive.onHitStatus.chance || 100)) {
      const status = passive.onHitStatus;
      const eff = applyEffect(enemyEffects, status.slug, status.turns || 1, passive.source);
      if (eff) {
        log.push(`${eff.icon} ${passive.source} inflicts ${eff.name} on the ${enemy.name}!`);
      }
    }
  }
}

function applyTurnRegenPassives(char, passives, log) {
  for (const passive of (passives || [])) {
    if (passive.manaRegen) {
      const restored = Math.min(passive.manaRegen, char.max_mp - char.mp);
      if (restored > 0) {
        char.mp += restored;
        log.push(`✨ ${passive.source} restores ${restored} MP.`);
      }
    }
    if (passive.mpRegenPct) {
      const restored = Math.min(Math.floor(char.max_mp * passive.mpRegenPct / 100), char.max_mp - char.mp);
      if (restored > 0) {
        char.mp += restored;
        log.push(`✨ ${passive.source} restores ${restored} MP (${passive.mpRegenPct}%).`);
      }
    }
    if (passive.hpRegen) {
      const healed = Math.min(passive.hpRegen, char.max_hp - char.hp);
      if (healed > 0) {
        char.hp += healed;
        log.push(`💚 ${passive.source} restores ${healed} HP.`);
      }
    }
    if (passive.hpRegenPct) {
      const healed = Math.min(Math.floor(char.max_hp * passive.hpRegenPct / 100), char.max_hp - char.hp);
      if (healed > 0) {
        char.hp += healed;
        log.push(`💚 ${passive.source} restores ${healed} HP (${passive.hpRegenPct}%).`);
      }
    }
  }
}

// ─── CONSUMABLE USE ──────────────────────────────────────────────

function addTempPassive(tempPassives, passive = {}, source = 'Consumable') {
  const turns = Math.max(1, Number(passive.turns) || 1);
  tempPassives.push({
    ...passive,
    source,
    turnsLeft: turns,
  });
}

function applyConsumableUse(item, char, options = {}) {
  const effects = options.effectsArray || null;
  const tempPassives = options.tempPassives || null;
  const log = options.log || [];
  const use = item?.use || {};

  if (use.heal) {
    const healed = Math.min(use.heal, char.max_hp - char.hp);
    char.hp += healed;
    log.push(`You use ${item.name} and recover ${healed} HP.`);
  }
  if (use.mana) {
    const restored = Math.min(use.mana, char.max_mp - char.mp);
    char.mp += restored;
    log.push(`You use ${item.name} and recover ${restored} MP.`);
  }
  if (use.cure && effects) {
    const cured = removeEffect(effects, use.cure);
    if (cured) log.push(`${cured.icon} ${item.name} cures ${cured.name}!`);
    else log.push(`You use ${item.name}, but you weren't affected by ${use.cure}.`);
  }
  if (effects && Array.isArray(use.effects)) {
    for (const effect of use.effects) {
      const applied = applyEffect(effects, effect.slug, effect.turns || 1, item.name);
      if (applied) log.push(`${applied.icon} ${item.name} grants ${applied.name} for ${applied.turnsLeft} turns.`);
    }
  }
  if (tempPassives && Array.isArray(use.tempPassives)) {
    for (const passive of use.tempPassives) {
      addTempPassive(tempPassives, passive, item.name);
      log.push(`✨ ${item.name} empowers you for ${Math.max(1, Number(passive.turns) || 1)} turns.`);
    }
  }
}

// ─── PERK GENERATION ─────────────────────────────────────────────

function rollPerks(rarity, itemDef) {
  const pool = PERK_POOLS[rarity];
  if (!pool) return null;
  if (rand(1, 100) > pool.rollChance) return null;

  const perks = [];
  const usedTypes = new Set();
  const totalPerks = pool.maxPerks + (rand(1, 100) <= pool.bonusPerkChance ? 1 : 0);

  const itemStats = Object.keys(itemDef?.stats || {}).filter(k => ['str','dex','int','wis','con','cha'].includes(k));
  const allStats = ['str','dex','int','wis','con','cha'];

  for (let i = 0; i < totalPerks; i++) {
    const available = pool.perks.filter(p => !usedTypes.has(p.type));
    if (!available.length) break;

    const totalWeight = available.reduce((sum, p) => sum + p.weight, 0);
    let roll = rand(1, totalWeight);
    let chosen = available[0];
    for (const p of available) {
      roll -= p.weight;
      if (roll <= 0) { chosen = p; break; }
    }
    usedTypes.add(chosen.type);

    const value = rand(chosen.min, chosen.max);
    if (chosen.type === 'stat') {
      const statPool = itemStats.length ? (rand(1, 100) <= 70 ? itemStats : allStats) : allStats;
      const stat = statPool[rand(0, statPool.length - 1)];
      perks.push({ type: 'stat', stat, value });
    } else if (chosen.type === 'onHitBurn') {
      perks.push({ type: 'onHitStatus', slug: 'burn', chance: value, turns: 2 });
    } else if (chosen.type === 'onHitPoison') {
      perks.push({ type: 'onHitStatus', slug: 'poison', chance: value, turns: 3 });
    } else if (chosen.type === 'onHitStun') {
      perks.push({ type: 'onHitStatus', slug: 'stun', chance: value, turns: 1 });
    } else {
      perks.push({ type: chosen.type, value });
    }
  }
  return perks.length ? perks : null;
}

function getPerkPrefix(perks) {
  if (!perks || !perks.length) return '';
  const best = perks[0];
  if (best.type === 'stat') return PERK_PREFIXES.stat[best.stat] || 'Enhanced';
  // Deterministic index from perk data so prefix stays stable across re-renders
  const perkHash = JSON.stringify(perks).split('').reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  const pick = (arr) => arr[Math.abs(perkHash) % arr.length];
  if (best.type === 'onHitStatus') {
    const key = 'onHit' + best.slug.charAt(0).toUpperCase() + best.slug.slice(1);
    const arr = PERK_PREFIXES[key];
    return arr ? pick(arr) : 'Enchanted';
  }
  const arr = PERK_PREFIXES[best.type];
  return arr ? pick(arr) : 'Enhanced';
}

// ─── DURABILITY ──────────────────────────────────────────────────

function getMaxDurability(itemSlug, itemsLookup) {
  const item = typeof itemsLookup === 'function' ? itemsLookup(itemSlug) : (itemsLookup || {})[itemSlug];
  if (!item) return 20;
  return DURABILITY_BY_RARITY[item.rarity] || 20;
}

// ─── ENEMY SCALING ───────────────────────────────────────────────

function buildScaledEnemy(enemy, charLevel, zoneThreat) {
  // No level-gap scaling — enemies use base stats from zone files.
  return {
    ...enemy,
    hp: enemy.hp,
    maxHp: enemy.hp,
    attack: enemy.attack,
    defense: enemy.defense,
    buffs: [],
    dots: [],
    stunned: false,
    statusEffects: [],
    abilities: enemy.abilities || [],
  };
}

// ─── EXPORTS ─────────────────────────────────────────────────────

// Ability rank cost scaling: higher ranks cost more MP
const RANK_COST_MULTIPLIERS = [1.0, 1.1, 1.2, 1.4, 1.7];
const RANK_COST_FLOOR_ADDS  = [0,   1,    1,    3,   4];

function getAbilityRankCost(baseCost, rank) {
  const idx = Math.max(0, Math.min(4, rank - 1));
  return Math.max(
    Math.floor(baseCost * RANK_COST_MULTIPLIERS[idx]),
    baseCost + RANK_COST_FLOOR_ADDS[idx]
  );
}

module.exports = {
  // Config data
  RACES,
  CLASSES,
  STATUS_EFFECTS,
  PERK_POOLS,
  PERK_PREFIXES,
  DURABILITY_BY_RARITY,
  EQUIPMENT_SLOTS,
  GAME_CONFIG,

  // Core formulas
  rand,
  xpForLevel,
  computeStats,
  calcDodgeChance,
  calcEnemyDodgeChance,
  calcCritChance,
  calcEnemyCritChance,
  applyDefenseReduction,
  buildScaledEnemy,

  // Equipment
  getEquipmentPassives,
  getEquipmentPerkBonuses,
  getCombatPassives,
  getMaxDurability,

  // Status effects
  applyEffect,
  removeEffect,
  getEffectStatMods,
  tickEffects,
  isStunned,

  // Passives & combat helpers
  applyDamagePassives,
  applyTurnRegenPassives,
  addTempPassive,
  applyConsumableUse,

  // Perks
  rollPerks,
  getPerkPrefix,
  getAbilityRankCost,

  // Racial passives
  getRacialPassive,
  applyRacialDamageBonus,
  RACIAL_PASSIVES,
};
