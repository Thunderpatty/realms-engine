'use strict';
// ═══════════════════════════════════════════════════════════════
// CLASS-SPECS — single source of truth for specialization mechanics
//
// Both combat engines (systems/combat.js, systems/party-combat.js)
// call into this module at well-defined hook points. Adding a new
// spec flag means adding one entry here; both engines pick it up.
//
// Hook point reference:
//   buildSpecContext(player, opts)  → context object to pass into hooks
//   specCombatStart(ctx)            → reset/init per-combat state
//   specTurnStart(ctx)              → regen, tick buff timers
//   specMpCost(cost, ctx)           → reduce ability cost (mpCostReduction, arcane surge)
//   specCritChance(base, ctx)       → bloodrage crit bonus, phase strike forced crit
//   specDmgDealt(dmg, ctx)          → outgoing damage modifiers (damageMul, bloodrage, vulnerabilities)
//   specOnHit(ctx)                  → proc effects (burn/slow/poison/smite/stun)
//   specOnKill(ctx)                 → bloodrage trigger, inferno, plague vector
//   specDmgTaken(dmg, ctx)          → incoming damage modifiers (dr, bulwark, reflect, deathless rage)
//   specEnemyAtkMod(enemy, ctx)     → slowAtkReduction
//   specDotTickMod(dmg, type, ctx)  → burnDamageBonus, poison bonuses on DoT ticks
//   specClassAbility(ctx, special)  → execute the active class ability (Flash Freeze etc.)
//
// State lives on player.specState (per-combat, reset each combat).
// Persistent lifetime counters go on the DB column fantasy_characters.spec_state
// for future codex/statistics use.
// ═══════════════════════════════════════════════════════════════

const GAME_CONFIG = require('./game-config');

// ─── Helpers ─────────────────────────────────────────────────────

function resolveSpec(player) {
  const slug = player?.classBonusSlug || player?.companion?.classBonus || null;
  if (!slug) return { slug: null, tier: 1, spec: null, passive: {}, special: null };
  const spec = GAME_CONFIG.classBonuses?.[slug];
  if (!spec) return { slug, tier: 1, spec: null, passive: {}, special: null };
  const tier = Math.max(1, Math.min(4, player.specTier || player?.companion?.specTier || 1));
  const tierData = spec.tiers?.[tier - 1] || {};
  const passive = tierData.passive || spec.passive || {};
  const special = tierData.special
    ? { ...(spec.special || {}), ...tierData.special }
    : spec.special;
  return { slug, tier, spec, passive, special };
}

function buildSpecContext(player, opts = {}) {
  const resolved = opts.resolved || resolveSpec(player);
  player.specState = player.specState || {};
  return {
    player,
    target: opts.target || null,
    attacker: opts.attacker || null,
    spec: resolved.spec,
    specSlug: resolved.slug,
    specTier: resolved.tier,
    passive: resolved.passive,
    special: resolved.special,
    allEnemies: opts.allEnemies || [],
    allAllies: opts.allAllies || [],
    log: opts.log || [],
    toast: opts.toast || null,
    rand: opts.rand,
    applyEffect: opts.applyEffect,
    STATUS_EFFECTS: opts.STATUS_EFFECTS || {},
    state: player.specState,
    abilityType: opts.abilityType || null, // 'attack' | 'magic' | 'physical'
    abilitySlug: opts.abilitySlug || null,
  };
}

// ─── onCombatStart ───────────────────────────────────────────────

function specCombatStart(ctx) {
  // Idempotent init: set defaults only for missing keys so we don't wipe
  // existing state if called again mid-combat.
  const defaults = {
    bloodrageActive: false,
    bloodrageCritTurns: 0,
    bloodrageCritBonus: 0,
    absoluteZeroUsed: false,
    deathlessRageUsed: false,
    deathlessRageTurns: 0,
    infernoUsed: false,
    miracleUsed: false,
    wrathOfHeavenCount: 0,
    arcaneSurgeCharges: 0,
    overchannelActive: false,
    phaseStrikeCharges: 0,
    vanishActive: false,
    combatStartFired: false,
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (ctx.state[k] === undefined) ctx.state[k] = v;
  }

  // One-shot combat-start effects
  if (!ctx.state.combatStartFired) {
    ctx.state.combatStartFired = true;
    const p = ctx.passive || {};
    // Sanctum (Aegis T4) — all allies gain 12% max HP shield at combat start
    if (p.aegisSanctum && ctx.allAllies.length > 0) {
      for (const ally of ctx.allAllies) {
        const shield = Math.floor((ally.maxHp || ally.max_hp || 100) * 0.12);
        ally.divineShield = Math.max(ally.divineShield || 0, shield);
      }
      ctx.log.push(`🛡 Sanctum! The party is shielded by the light.`);
      if (ctx.toast) ctx.toast('achievement', '🛡 Sanctum', 'The party begins protected.');
    }
  }
}

// ─── onTurnStart ─────────────────────────────────────────────────

function specTurnStart(ctx) {
  const p = ctx.passive || {};

  // hpRegenPct (Radiance T1+)
  if (p.hpRegenPct && ctx.player.hp > 0) {
    const max = ctx.player.maxHp || ctx.player.max_hp || 100;
    const regen = Math.max(1, Math.floor(max * p.hpRegenPct / 100));
    const restored = Math.min(regen, max - ctx.player.hp);
    if (restored > 0) {
      ctx.player.hp += restored;
      ctx.log.push(`💛 Radiance restores ${restored} HP to ${ctx.player.name}.`);
    }
  }

  // partyRegen (Radiance T2+) — heal all living allies X% per turn
  if (p.partyRegen && ctx.allAllies.length > 0) {
    for (const ally of ctx.allAllies) {
      if (ally.hp <= 0) continue;
      const max = ally.maxHp || ally.max_hp || 100;
      if (ally.hp >= max) continue;
      const regen = Math.max(1, Math.floor(max * p.partyRegen / 100));
      const restored = Math.min(regen, max - ally.hp);
      if (restored > 0) {
        ally.hp += restored;
        ctx.log.push(`💚 ${ally.name} regenerates ${restored} HP.`);
      }
    }
  }

  // Tauntreflect requires ongoing tracking — handled in specDmgTaken
  // tauntHpRegen (Guardian T3+) — heal while taunting
  if (p.tauntHpRegen && ctx.player.hp > 0 && ctx.combatState?.tauntPlayerId === ctx.player.charId) {
    const max = ctx.player.maxHp || ctx.player.max_hp || 100;
    const regen = Math.max(1, Math.floor(max * p.tauntHpRegen / 100));
    const restored = Math.min(regen, max - ctx.player.hp);
    if (restored > 0) {
      ctx.player.hp += restored;
      ctx.log.push(`🛡 Guardian's Resolve restores ${restored} HP.`);
    }
  }

  // Tick transient state counters
  if (ctx.state.bloodrageCritTurns > 0) {
    ctx.state.bloodrageCritTurns--;
    if (ctx.state.bloodrageCritTurns === 0) ctx.state.bloodrageCritBonus = 0;
  }
  if (ctx.state.deathlessRageTurns > 0) {
    ctx.state.deathlessRageTurns--;
  }
}

// ─── MP cost adjustments ─────────────────────────────────────────

function specMpCost(cost, ctx) {
  const p = ctx.passive || {};

  // Arcane Surge free-cast charges
  if (ctx.state.arcaneSurgeCharges > 0) {
    // Overchannel (Arcanistry T4) — flag the FIRST free cast for +50% effect
    if (p.mpCostReduction >= 25 && !ctx.state.overchannelConsumed) {
      ctx.state.overchannelActive = true;
      ctx.state.overchannelConsumed = true;
    }
    ctx.state.arcaneSurgeCharges--;
    return 0;
  }

  // Arcanistry mpCostReduction
  if (p.mpCostReduction) cost = Math.floor(cost * (1 - p.mpCostReduction / 100));
  return Math.max(0, cost);
}

// ─── Crit chance adjustment ──────────────────────────────────────

function specCritChance(base, ctx) {
  let crit = base;
  // Berserker T2+: bloodrageCritBonus during bloodrage turns
  if (ctx.state.bloodrageCritTurns > 0) crit += ctx.state.bloodrageCritBonus || 0;
  // Phase Strike charges → forced 100% crit
  if (ctx.state.phaseStrikeCharges > 0) crit = Math.max(crit, 100);
  // Blade Dance T2+: extraHitCrit (applied only on multi-hit abilities — flag in ctx)
  if (ctx.passive?.extraHitCrit && ctx.isMultiHit) crit += ctx.passive.extraHitCrit;
  return crit;
}

// ─── Outgoing damage modifiers ───────────────────────────────────

function specDmgDealt(dmg, ctx) {
  const p = ctx.passive || {};

  // damageMul (Berserker, Warlord, Judgment base)
  if (p.damageMul && p.damageMul !== 1) dmg = Math.floor(dmg * p.damageMul);

  // Bloodrage (Berserker): consumed here on next hit after kill
  if (ctx.state.bloodrageActive) {
    dmg = Math.floor(dmg * 2);
    ctx.state.bloodrageActive = false;
    ctx.log.push(`🔥 Bloodrage! Double damage!`);
  }

  // Deathless Rage active buff (+50% dmg for 3 turns)
  if (ctx.state.deathlessRageTurns > 0) {
    dmg = Math.floor(dmg * 1.5);
  }

  // Overchannel (Arcanistry T4): first free cast under Arcane Surge = +50%
  if (ctx.state.overchannelActive) {
    dmg = Math.floor(dmg * 1.5);
    ctx.state.overchannelActive = false;
    ctx.log.push(`✨ Overchannel! +50% effect.`);
  }

  // frozenVulnerability (Cryomancy T3+) — +X% on slowed/stunned
  if (p.frozenVulnerability && ctx.target?.effects?.some(e => e.slug === 'slow' || e.slug === 'stun' || e.slug === 'freeze')) {
    dmg = Math.floor(dmg * (1 + p.frozenVulnerability / 100));
  }

  // burnVulnerability (Pyromancy T3+) — +X% on burning
  if (p.burnVulnerability && ctx.target?.effects?.some(e => e.slug === 'burn')) {
    dmg = Math.floor(dmg * (1 + p.burnVulnerability / 100));
  }

  // envenomDamageBonus (Poison Mastery T3) — +X% on poisoned
  if (p.envenomDamageBonus && ctx.target?.effects?.some(e => e.slug === 'poison')) {
    dmg = Math.floor(dmg * (1 + p.envenomDamageBonus / 100));
  }

  // Phase Strike damage bonus (consumed in specOnHit via phaseStrikeCharges)
  if (ctx.state.phaseStrikeCharges > 0) {
    dmg = Math.floor(dmg * 1.5);
  }

  return dmg;
}

// ─── On-hit side effects ────────────────────────────────────────

function specOnHit(ctx) {
  const p = ctx.passive || {};
  const target = ctx.target;
  if (!target || target.hp <= 0 || !ctx.applyEffect || !ctx.rand) return;

  // Pyromancy: chance to apply burn on hit
  if (p.onHitBurnChance && ctx.rand(1, 100) <= p.onHitBurnChance) {
    const eff = ctx.applyEffect(target.effects, 'burn', 3, 'Pyromancy');
    if (eff) ctx.log.push(`🔥 ${target.name} is burning!`);
  }
  // Cryomancy: chance to slow
  if (p.onHitSlowChance && ctx.rand(1, 100) <= p.onHitSlowChance) {
    ctx.applyEffect(target.effects, 'slow', 3, 'Cryomancy');
  }
  // Poison Mastery: chance to poison (T2+ doubles stacks)
  if (p.onHitPoisonChance && ctx.rand(1, 100) <= p.onHitPoisonChance) {
    const eff = ctx.applyEffect(target.effects, 'poison', 3, 'Poison Mastery');
    if (eff && p.poisonStacks) {
      eff.damagePerTurn = (eff.damagePerTurn || 3) * 2;
    }
  }
  // Judgment: smiteBurn on magic hits
  if (p.smiteBurn && ctx.abilityType === 'magic' && ctx.rand(1, 100) <= (typeof p.smiteBurn === 'number' ? p.smiteBurn : 25)) {
    const eff = ctx.applyEffect(target.effects, 'burn', 3, 'Judgment');
    if (eff) ctx.log.push(`✨ Divine flame ignites ${target.name}!`);
  }
  // Judgment: offensiveStun on magic hits
  if (p.offensiveStun && ctx.abilityType === 'magic' && ctx.rand(1, 100) <= (typeof p.offensiveStun === 'number' ? p.offensiveStun : 15)) {
    ctx.applyEffect(target.effects, 'stun', 1, 'Judgment');
    ctx.log.push(`✨ Judgment stuns ${target.name}!`);
  }
  // Poison Mastery T3: poisonDefReduction — slowed poisoned targets lose defense
  // Implemented during damage calc via passive checks; nothing to do here.

  // Phase Strike charge consumption (guaranteed crit + dmg were applied upstream)
  if (ctx.state.phaseStrikeCharges > 0) {
    ctx.state.phaseStrikeCharges--;
    if (ctx.state.phaseStrikeCharges === 0) ctx.log.push(`🌑 Phase Strike fades.`);
  }

  // Absolute Zero exec (Cryomancy T4) — non-boss at ≤15% HP, once per combat
  if (target.hp > 0 && p.absoluteZero && !ctx.state.absoluteZeroUsed && !target.boss) {
    const maxHp = target.maxHp || target.max_hp || target.hp;
    if (target.hp <= Math.floor(maxHp * 0.15)) {
      target.hp = 0;
      ctx.state.absoluteZeroUsed = true;
      ctx.log.push(`❄ Absolute Zero! ${target.name} shatters to frozen dust!`);
      if (ctx.toast) ctx.toast('mythic', '❄ Absolute Zero', `${target.name} frozen solid!`);
    }
  }

  // Wrath of Heaven counter (Judgment T4) — every 5th magic cast is a free bonus smite
  if (p.wrathOfHeaven && ctx.abilityType === 'magic') {
    ctx.state.wrathOfHeavenCount = (ctx.state.wrathOfHeavenCount || 0) + 1;
    if (ctx.state.wrathOfHeavenCount >= 5) {
      ctx.state.wrathOfHeavenCount = 0;
      // Fire a bonus true-damage hit
      const bonusDmg = Math.floor((ctx.player.stats?.wis || 10) * 2);
      target.hp -= bonusDmg;
      ctx.log.push(`⚡ Wrath of Heaven! ${bonusDmg} divine damage to ${target.name}!`);
      if (ctx.toast) ctx.toast('achievement', '⚡ Wrath of Heaven', `${bonusDmg} bonus divine damage!`);
    }
  }
}

// ─── On-kill triggers ────────────────────────────────────────────

function specOnKill(ctx) {
  const p = ctx.passive || {};
  const target = ctx.target;

  // Berserker: bloodrage triggers on kill
  if (ctx.specSlug === 'berserker') {
    ctx.state.bloodrageActive = true;
    if (p.bloodrageCritBonus) {
      ctx.state.bloodrageCritTurns = 2;
      ctx.state.bloodrageCritBonus = p.bloodrageCritBonus;
    }
    // bloodrageChains (T3+) handled implicitly: bloodrageActive stays true until consumed
    if (p.bloodrageChains) {
      // Also refresh crit turns if already in them
      if (p.bloodrageCritBonus) ctx.state.bloodrageCritTurns = Math.max(ctx.state.bloodrageCritTurns, 2);
    }
    ctx.log.push(`🔥 Bloodrage ignites — next hit doubles.`);
  }

  // Inferno (Pyromancy T4) — burning enemy dies, spreads remaining burn
  if (p.inferno && !ctx.state.infernoUsed && target?.effects) {
    const burnEff = target.effects.find(e => e.slug === 'burn');
    if (burnEff && ctx.allEnemies.length > 1) {
      const ticksLeft = burnEff.turnsLeft || 1;
      const remainingDmg = (burnEff.damagePerTurn || 4) * ticksLeft;
      const livingOthers = ctx.allEnemies.filter(e => e.id !== target.id && e.hp > 0);
      if (livingOthers.length > 0) {
        const splitDmg = Math.floor(remainingDmg / livingOthers.length);
        for (const en of livingOthers) {
          en.hp -= splitDmg;
          ctx.log.push(`💥 Inferno! ${en.name} takes ${splitDmg} explosive burn damage!`);
        }
        ctx.state.infernoUsed = true;
        if (ctx.toast) ctx.toast('mythic', '💥 Inferno', 'The flames erupt!');
      }
    }
  }

  // Plague Vector (Poison Mastery T4) — poisoned enemy dies, spread to 2 nearest
  if (p.plagueVector && target?.effects) {
    const poisonEff = target.effects.find(e => e.slug === 'poison');
    if (poisonEff) {
      const livingOthers = ctx.allEnemies.filter(e => e.id !== target.id && e.hp > 0).slice(0, 2);
      for (const en of livingOthers) {
        const eff = ctx.applyEffect(en.effects, 'poison', poisonEff.turnsLeft || 3, 'Plague Vector');
        if (eff) {
          eff.damagePerTurn = poisonEff.damagePerTurn || 4;
          ctx.log.push(`🧪 Plague spreads to ${en.name}!`);
        }
      }
      if (livingOthers.length > 0 && ctx.toast) {
        ctx.toast('mythic', '🧪 Plague Vector', 'The poison spreads!');
      }
    }
  }
}

// ─── Incoming damage modifiers ───────────────────────────────────

function specDmgTaken(dmg, ctx) {
  const p = ctx.passive || {};

  // damageTakenMul (Guardian -15%, Berserker +10%, etc.)
  if (p.damageTakenMul && p.damageTakenMul !== 1) {
    dmg = Math.max(1, Math.floor(dmg * p.damageTakenMul));
  }

  // Aegis — allyDamageTakenMul applies when YOU are the ally taking damage,
  // and an aegis cleric is in the party. Check allAllies for aegis presence.
  for (const ally of ctx.allAllies || []) {
    if (ally === ctx.player) continue;
    if (ally.hp <= 0) continue;
    const allyPassive = ally.cbPassive;
    if (allyPassive?.allyDamageTakenMul) {
      dmg = Math.max(1, Math.floor(dmg * allyPassive.allyDamageTakenMul));
    }
  }

  // Bulwark / unbreakable (Guardian T4) — cap single hit at 20% maxHp
  if (p.unbreakable) {
    const max = ctx.player.maxHp || ctx.player.max_hp || 100;
    const cap = Math.floor(max * 0.2);
    if (dmg > cap) {
      const saved = dmg - cap;
      dmg = cap;
      ctx.log.push(`🛡 Bulwark absorbs ${saved} damage!`);
    }
  }

  // Taunt reflect (Guardian T2+) — reflect X% to attacker
  if (p.tauntReflect && ctx.attacker) {
    const reflected = Math.floor(dmg * (p.tauntReflect / 100));
    if (reflected > 0 && ctx.attacker.hp !== undefined) {
      ctx.attacker.hp -= reflected;
      ctx.log.push(`🛡 ${reflected} damage reflected onto ${ctx.attacker.name || 'attacker'}!`);
    }
  }

  // Deathless Rage (Berserker T4) — survive killing blow at 1 HP + 50% dmg for 3 turns
  if (p.deathlessRage && !ctx.state.deathlessRageUsed && dmg >= ctx.player.hp) {
    dmg = Math.max(0, ctx.player.hp - 1);
    ctx.state.deathlessRageUsed = true;
    ctx.state.deathlessRageTurns = 3;
    ctx.log.push(`💀 Deathless Rage! ${ctx.player.name} survives the killing blow and burns with fury!`);
    if (ctx.toast) ctx.toast('death', '💀 Deathless Rage', 'You refuse to fall!');
  }

  return dmg;
}

// ─── Enemy ATK modifier (applied when resolving an enemy's turn) ──

function specEnemyAtkMod(enemy, ctx) {
  const p = ctx.passive || {};
  if (!enemy) return (enemy && enemy.attack) || 10;
  let atk = enemy.attack || 10;
  // slowAtkReduction (Cryomancy T2+) — slowed enemies attack for X% less
  if (p.slowAtkReduction && (enemy.effects || []).some(e => e.slug === 'slow')) {
    atk = Math.max(1, Math.floor(atk * (1 - p.slowAtkReduction / 100)));
  }
  return atk;
}

// ─── DoT tick modifier (when a status effect ticks its damage) ────

function specDotTickMod(baseDmg, dotType, ctx) {
  const p = ctx.passive || {};
  if (dotType === 'burn' && p.burnDamageBonus) {
    return Math.floor(baseDmg * (1 + p.burnDamageBonus / 100));
  }
  return baseDmg;
}

// ─── Class ability dispatch ──────────────────────────────────────
// Returns true if handled, false if unrecognized type

function specClassAbility(ctx, opts = {}) {
  const sp = ctx.special;
  if (!sp) return false;
  const p = ctx.passive || {};
  const icon = ctx.spec?.icon || '✨';

  if (sp.type === 'aoe-stun') {
    // Flash Freeze (Cryomancy) — T3+ may extend duration
    const turns = sp.duration || sp.turns || 1;
    for (const en of ctx.allEnemies) {
      if (en.hp <= 0) continue;
      const eff = ctx.applyEffect(en.effects, 'stun', turns, sp.name);
      if (eff) ctx.log.push(`❄ ${sp.name} freezes ${en.name}${turns > 1 ? ` for ${turns} turns` : ''}!`);
    }
    if (ctx.toast) ctx.toast('mythic', '❄ ' + sp.name, 'All enemies frozen!');
    return true;
  }

  if (sp.type === 'aoe-damage') {
    // Pyromancy Meteor / Blade Dance Flurry
    const baseDmg = Math.floor((ctx.player.stats?.attack || ctx.player.stats?.int || 20) * (sp.damageMul || 2));
    for (const en of ctx.allEnemies) {
      if (en.hp <= 0) continue;
      const dmg = Math.max(1, baseDmg + ctx.rand(0, 5));
      en.hp -= dmg;
      ctx.log.push(`${icon} ${sp.name} hits ${en.name} for ${dmg}!`);
    }
    return true;
  }

  if (sp.type === 'true-damage') {
    // Judgment Holy Smite
    const stat = ctx.player.stats?.[sp.stat || 'wis'] || 10;
    const dmg = Math.floor(stat * (sp.statMul || 3));
    if (ctx.target) {
      ctx.target.hp -= dmg;
      ctx.log.push(`⚡ ${sp.name}! ${dmg} true damage to ${ctx.target.name}.`);
    }
    return true;
  }

  if (sp.type === 'full-restore') {
    // Radiance — Divine Restoration
    // Miracle (Radiance T4) — if an ally is dead, revive them instead of healing self
    if (p.miracle && !ctx.state.miracleUsed) {
      const deadAlly = (ctx.allAllies || []).find(a => a !== ctx.player && a.hp <= 0);
      if (deadAlly) {
        const max = deadAlly.maxHp || deadAlly.max_hp || 100;
        deadAlly.hp = Math.max(1, Math.floor(max * 0.5));
        deadAlly.mp = deadAlly.maxMp || deadAlly.max_mp || deadAlly.mp;
        ctx.state.miracleUsed = true;
        ctx.log.push(`✨ Miracle! ${deadAlly.name} is resurrected at ${deadAlly.hp} HP!`);
        if (ctx.toast) ctx.toast('mythic', '✨ Miracle', `${deadAlly.name} lives again!`);
        return true;
      }
    }
    ctx.player.hp = ctx.player.maxHp || ctx.player.max_hp;
    ctx.player.mp = ctx.player.maxMp || ctx.player.max_mp;
    ctx.log.push(`💛 ${sp.name}! ${ctx.player.name} is fully restored.`);
    return true;
  }

  if (sp.type === 'shield') {
    // Aegis Divine Shield
    const pct = sp.hpPct || 20;
    ctx.player.divineShield = Math.floor((ctx.player.maxHp || ctx.player.max_hp || 100) * pct / 100);
    ctx.log.push(`🛡 ${sp.name}! ${ctx.player.name} absorbs up to ${ctx.player.divineShield} damage.`);
    return true;
  }

  if (sp.type === 'free-cast') {
    // Arcanistry Arcane Surge
    const charges = sp.charges || 3;
    ctx.state.arcaneSurgeCharges = charges;
    ctx.state.arcaneSurgeChargesMax = charges;
    ctx.state.overchannelConsumed = false;
    ctx.log.push(`✨ ${sp.name}! Next ${charges} abilities cost 0 MP.`);
    return true;
  }

  if (sp.type === 'taunt') {
    // Guardian taunt
    const turns = sp.turns || 2;
    if (ctx.combatState) {
      ctx.combatState.tauntPlayerId = ctx.player.charId;
      ctx.combatState.tauntTurnsLeft = turns;
    }
    ctx.log.push(`🛡 ${sp.name}! Enemies focus on ${ctx.player.name} for ${turns} turns.`);
    return true;
  }

  if (sp.type === 'party-buff') {
    // Warlord Battle Cry — T4 Rally enhances to all-party + damage bonus
    const amt = sp.amount || 4;
    const turns = sp.turns || 3;
    const targets = ctx.allAllies.length ? ctx.allAllies : [ctx.player];
    for (const t of targets) {
      if (t.hp <= 0) continue;
      t.buffs = t.buffs || [];
      t.buffs.push({ stat: sp.stat || 'all', amount: amt, name: sp.name, turnsLeft: turns });
      // Warlord T4 Rally: also +15% damage buff
      if (p.rallyBonusDamage) {
        t.buffs.push({ stat: 'damage', amount: p.rallyBonusDamage, name: sp.name + ' (rally)', turnsLeft: turns });
      }
    }
    ctx.log.push(`⚔ ${sp.name}! Party rallies.`);
    return true;
  }

  if (sp.type === 'aoe-dot') {
    // Poison Mastery Envenom
    for (const en of ctx.allEnemies) {
      if (en.hp <= 0) continue;
      const eff = ctx.applyEffect(en.effects, sp.dotType || 'poison', sp.turns || 5, sp.name);
      if (eff) {
        eff.damagePerTurn = sp.damage || 5;
        ctx.log.push(`🧪 ${sp.name} poisons ${en.name}!`);
      }
    }
    return true;
  }

  if (sp.type === 'vanish') {
    // Shadowstep — immune + guaranteed crit on next hit
    ctx.state.vanishActive = true;
    // Shadowstep T2+: vanishCritMul — handled in damage calc
    // Shadowstep T3+: vanishBonusCrits — set charges for 2 crit hits instead of 1
    const charges = p.vanishBonusCrits || 1;
    ctx.state.phaseStrikeCharges = charges;
    ctx.log.push(`🌑 ${sp.name}! ${ctx.player.name} vanishes into shadow.`);
    return true;
  }

  return false;
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
  resolveSpec,
  buildSpecContext,
  specCombatStart,
  specTurnStart,
  specMpCost,
  specCritChance,
  specDmgDealt,
  specOnHit,
  specOnKill,
  specDmgTaken,
  specEnemyAtkMod,
  specDotTickMod,
  specClassAbility,
};
