// ═══════════════════════════════════════════════════════════════
// COMBAT — PvE combat action handler (multi-entity)
// Supports enemies[], allies[], targetId, batch-resolve turns
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');
const SPECS = require('../shared/class-specs');
const GAME_CONFIG = require('../shared/game-config');

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, withTransaction, getChar, getEquipment, addLog, addItem, removeItem,
    buildState, buildPatch, getContent, gameEvents, CLASSES, EQUIPMENT_SLOTS, rand,
    getCharAbilities, computeStats, getPerkPrefix, getMaxDurability, rollPerks,
    checkLevelUp, awardExploreMaterials, awardBossRecipe, recordBountyKill,
    applyEffect, removeEffect, getEffectStatMods, tickEffects, isStunned,
    applyDefenseReduction, applyDamagePassives, applyTurnRegenPassives,
    addTempPassive, applyConsumableUse, cureEffect,
    calcDodgeChance, calcEnemyDodgeChance, calcCritChance, calcEnemyCritChance,
    getCombatPassives, getEquipmentPerkBonuses,
    STATUS_EFFECTS, ENEMY_ABILITIES, xpForLevel,
    applyRacialDamageBonus, getRacialPassive, getRespawnLocation, getAbilityRankCost,
  } = ctx;

  // ── Migration shim: convert legacy single-enemy → enemies[] ──
  function migrateCombatState(cs) {
    if (cs.enemies) return; // already migrated
    if (!cs.enemy) return;
    const enemy = cs.enemy;
    enemy.id = enemy.id || 'e0';
    enemy.effects = enemy.statusEffects || cs.enemyEffects || [];
    delete enemy.statusEffects;
    cs.enemies = [enemy];
    cs.allies = cs.allies || [];
    delete cs.enemy;
    delete cs.enemyEffects;
  }

  // ── MOMENTUM SYSTEM ──
  const MOMENTUM_MAX = 10;
  const MOMENTUM_THRESHOLDS = [
    { min: 0, name: null, dmgBonus: 0, critBonus: 0, mpDiscount: 0 },
    { min: 3, name: 'Warmed Up', dmgBonus: 0.05, critBonus: 0, mpDiscount: 0 },
    { min: 5, name: 'In The Zone', dmgBonus: 0.10, critBonus: 5, mpDiscount: 0 },
    { min: 7, name: 'Battle Focus', dmgBonus: 0.15, critBonus: 10, mpDiscount: 0.10 },
    { min: 9, name: 'Unstoppable', dmgBonus: 0.25, critBonus: 15, mpDiscount: 0.25 },
  ];
  function getMomentumTier(momentum) {
    for (let i = MOMENTUM_THRESHOLDS.length - 1; i >= 0; i--) {
      if (momentum >= MOMENTUM_THRESHOLDS[i].min) return MOMENTUM_THRESHOLDS[i];
    }
    return MOMENTUM_THRESHOLDS[0];
  }
  function adjustMomentum(cs, delta) {
    const old = cs.momentum || 0;
    cs.momentum = Math.max(0, Math.min(MOMENTUM_MAX, old + delta));
    const oldTier = getMomentumTier(old);
    const newTier = getMomentumTier(cs.momentum);
    if (newTier.name && newTier.name !== oldTier.name) {
      return `⚡ ${newTier.name}! (Momentum ${cs.momentum}/${MOMENTUM_MAX})`;
    }
    return null;
  }

  // ── COMBO SYSTEM ──
  const COMBOS = GAME_CONFIG.combos || [];
  function checkCombo(cs, char, abilitySlug) {
    if (!cs.lastAbilitySlug) return null;
    return COMBOS.find(c => c.class === char.class && c.first === cs.lastAbilitySlug && c.second === abilitySlug) || null;
  }

  // ── Helper: get first living enemy ──
  function firstLivingEnemy(enemies) {
    return enemies.find(e => e.hp > 0) || null;
  }

  // ── Helper: resolve ally turn using active ability ──
  function resolveAllyTurn(ally, cs, log, playerTargetId) {
    if (ally.hp <= 0) return;
    if (ally.duration !== undefined) {
      ally.duration--;
      if (ally.duration <= 0) {
        ally.hp = 0;
        log.push(`💨 ${ally.name} fades away.`);
        return;
      }
    }
    const livingEnemies = cs.enemies.filter(e => e.hp > 0);
    if (!livingEnemies.length) return;

    // Find ability definition
    const compDef = ally.companionData ? GAME_CONFIG.companions[ally.type] : null;
    const abilSlug = ally.activeAbility;
    const abilDef = compDef?.abilities.find(a => a.slug === abilSlug);

    // Tick cooldowns
    ally.cooldowns = ally.cooldowns || {};
    for (const slug of Object.keys(ally.cooldowns)) {
      ally.cooldowns[slug]--;
      if (ally.cooldowns[slug] <= 0) delete ally.cooldowns[slug];
    }

    // Check cooldown — fall back to basic attack
    const onCooldown = abilDef && ally.cooldowns[abilSlug] > 0;
    const useAbility = abilDef && !onCooldown;

    // Target selection
    let target;
    if (useAbility && abilDef.requireSameTarget) {
      target = livingEnemies.find(e => e.id === playerTargetId) || livingEnemies[0];
    } else {
      target = livingEnemies.reduce((a, b) => a.hp < b.hp ? a : b);
    }

    const allyAtk = ally.attack || 5;
    const icon = ally.icon || '🐾';

    if (useAbility && abilDef.type === 'buff') {
      // Buff player
      cs.playerBuffs = cs.playerBuffs || [];
      const buff = abilDef.buff;
      if (buff.target === 'player') {
        const amount = Math.floor(allyAtk * buff.amount / 100) || buff.amount;
        cs.playerBuffs.push({ stat: buff.stat, amount, name: abilDef.name, turnsLeft: buff.turns });
        log.push(`${icon} ${ally.name} uses ${abilDef.name}! (+${amount} ${buff.stat.toUpperCase()} for ${buff.turns} turns)`);
      }
      if (abilDef.cooldown) ally.cooldowns[abilSlug] = abilDef.cooldown;
      return;
    }

    if (useAbility && abilDef.type === 'taunt') {
      cs.tauntTarget = ally.id;
      cs.tauntTurns = abilDef.turns || 2;
      log.push(`${icon} ${ally.name} uses ${abilDef.name}! Enemies focus the ${ally.name} for ${abilDef.turns} turns.`);
      if (abilDef.cooldown) ally.cooldowns[abilSlug] = abilDef.cooldown;
      return;
    }

    if (useAbility && abilDef.type === 'debuff') {
      const targets = abilDef.aoe ? livingEnemies : [target];
      for (const t of targets) {
        const eff = applyEffect(t.effects, abilDef.effect.slug, abilDef.effect.turns || 2, abilDef.name);
        if (eff) log.push(`${icon} ${ally.name} uses ${abilDef.name} on ${t.name}!`);
      }
      if (abilDef.cooldown) ally.cooldowns[abilSlug] = abilDef.cooldown;
      return;
    }

    // Attack type (default or ability)
    const dmgMul = useAbility ? (abilDef.damage || 1.0) : 1.0;
    const isAoe = useAbility && abilDef.aoe;
    const targets = isAoe ? livingEnemies : [target];

    for (const t of targets) {
      const tDef = t.defense || 0;
      const rawDmg = Math.floor(allyAtk * dmgMul * 0.9) + rand(0, 2);
      const dmg = Math.max(1, applyDefenseReduction(rawDmg, tDef));
      const aoeMul = isAoe && t.id !== target.id ? 0.7 : 1;
      const finalDmg = Math.max(1, Math.floor(dmg * aoeMul));
      t.hp -= finalDmg;
      const label = useAbility ? abilDef.name : 'attacks';
      log.push(`${icon} ${ally.name} ${useAbility ? 'uses ' + abilDef.name + ' on' : 'attacks'} ${t.name} for ${finalDmg} damage.`);

      // DoT from ability
      if (useAbility && abilDef.dot) {
        const eff = applyEffect(t.effects, abilDef.dot.type, abilDef.dot.turns || 3, abilDef.name);
        if (eff) {
          eff.damagePerTurn = abilDef.dot.damage || 3;
          log.push(`🩸 ${abilDef.name} causes ${t.name} to ${abilDef.dot.type}!`);
        }
      }
      // Stun from ability
      if (useAbility && abilDef.stun) {
        if (rand(1, 100) <= 30) {
          const eff = applyEffect(t.effects, 'stun', 1, abilDef.name);
          if (eff) log.push(`💫 ${abilDef.name} stuns ${t.name}!`);
        }
      }
      // Slow from ability
      if (useAbility && abilDef.slow) {
        const eff = applyEffect(t.effects, 'slow', 3, abilDef.name);
        if (eff) log.push(`🐌 ${abilDef.name} slows ${t.name}!`);
      }
    }

    if (useAbility && abilDef.cooldown) ally.cooldowns[abilSlug] = abilDef.cooldown;

    // Companion tier bonus effects
    const tb = ally.tierBonuses || {};
    if (tb.slowOnHit && !isAoe) {
      const eff = applyEffect(target.effects, 'slow', 2, ally.name);
      if (eff) log.push(`${icon} ${ally.name}'s frost fangs slow ${target.name}!`);
    }
    if (tb.stunChance && rand(1, 100) <= tb.stunChance && !isAoe) {
      const eff = applyEffect(target.effects, 'stun', 1, ally.name);
      if (eff) log.push(`${icon} ${ally.name}'s paralyzing bite stuns ${target.name}!`);
    }
    if (tb.aoePoison) {
      for (const en of livingEnemies) {
        const eff = applyEffect(en.effects, 'poison', 3, ally.name);
        if (eff) eff.damagePerTurn = Math.floor(ally.attack * 0.15);
      }
    }
    if (tb.permanentTaunt) {
      cs.tauntTarget = ally.id;
      cs.tauntTurns = 99;
    }
    if (tb.markOnHit && target && rand(1, 100) <= (tb.markOnHit || 25)) {
      target.marked = true;
      target.markedTurns = 2;
      log.push(`${icon} ${ally.name} marks ${target.name}! Your attacks deal +25% damage to marked targets.`);
    }
    // Double attack for hawk tier 3
    if (tb.doubleAttack && !isAoe && target && target.hp > 0) {
      const rawDmg2 = Math.floor(allyAtk * 0.8) + rand(0, 2);
      const dmg2 = Math.max(1, applyDefenseReduction(rawDmg2, target.defense || 0));
      target.hp -= dmg2;
      log.push(`${icon} ${ally.name} strikes again for ${dmg2} damage!`);
    }
  }

  app.post('/api/fantasy/combat/action', requireAuth, validate(schemas.combatAction), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.in_combat || !char.combat_state) return res.status(400).json({ error: 'Not in combat.' });
      const equipment = await getEquipment(char.id);
      const stats = computeStats(char, equipment);
      const { action, abilitySlug, itemSlug, targetId, petAbility } = req.body;
      const cs = char.combat_state;
      const cls = CLASSES.find(c => c.slug === char.class);
      const log = [];

      // ── Migrate legacy combat state ──
      migrateCombatState(cs);
      cs.allies = cs.allies || [];

      // ── Resolve target ──
      const livingEnemies = cs.enemies.filter(e => e.hp > 0);
      const target = targetId
        ? livingEnemies.find(e => e.id === targetId)
        : firstLivingEnemy(cs.enemies);
      if (!target && ['attack', 'ability'].includes(action)) {
        return res.status(400).json({ error: 'No valid target.' });
      }

      let playerDamage = 0;
      let playerDamageTarget = target; // track which enemy took damage (for passives)
      let fled = false;

      // Ensure status effect arrays exist
      cs.playerEffects = cs.playerEffects || [];
      cs.playerTempPassives = cs.playerTempPassives || [];
      cs.specState = cs.specState || {};
      for (const en of cs.enemies) {
        en.effects = en.effects || [];
        if (en.stunned && !en.effects.some(e => e.slug === 'stun')) {
          applyEffect(en.effects, 'stun', 1, 'Legacy');
          en.stunned = false;
        }
      }

      const playerEffectMods = getEffectStatMods(cs.playerEffects);
      const effectiveStats = { ...stats };
      for (const [k, v] of Object.entries(playerEffectMods)) {
        if (effectiveStats[k] !== undefined) effectiveStats[k] = Math.max(0, effectiveStats[k] + v);
      }
      // Apply active player buffs to stats. Defense/dodge/damage are consumed
      // separately in the damage-taken path; everything else (str/int/wis/dex/
      // cha/attack and 'all') was previously pushed onto playerBuffs but never
      // read, making every stat-boosting ability cosmetic. Scaled by level so
      // flat values remain relevant at high level: effective = amount + level*0.15
      if (cs.playerBuffs) {
        for (const b of cs.playerBuffs) {
          if (b.stat === 'defense' || b.stat === 'dodge' || b.stat === 'damage') continue;
          const scaled = Math.max(1, Math.floor((b.amount || 0) + (char.level || 1) * 0.15));
          if (b.stat === 'all') {
            for (const s of ['str', 'int', 'wis', 'dex', 'cha', 'attack']) {
              if (effectiveStats[s] !== undefined) effectiveStats[s] = Math.max(0, effectiveStats[s] + scaled);
            }
          } else if (effectiveStats[b.stat] !== undefined) {
            effectiveStats[b.stat] = Math.max(0, effectiveStats[b.stat] + scaled);
          }
        }
      }
      const perkBonuses = getEquipmentPerkBonuses(equipment);

      // ── Class bonus setup (tier-aware) ──
      const classBonus = char.companion?.classBonus ? (GAME_CONFIG.classBonuses[char.companion.classBonus] || null) : null;
      const specTier = char.companion?.specTier || 1;
      const cbTierData = classBonus?.tiers?.[specTier - 1] || {};
      const cbPassive = cbTierData.passive || classBonus?.passive || {};
      // Damage multiplier from class bonus (berserker +20%, judgment +15%, warlord +10%)
      const cbDamageMul = cbPassive.damageMul || 1;
      // Damage taken multiplier (berserker +10%, guardian -15%)
      const cbDamageTakenMul = cbPassive.damageTakenMul || 1;
      // Extra dodge from shadowstep
      if (cbPassive.dodgeBonus) perkBonuses.dodgeBonus = (perkBonuses.dodgeBonus || 0) + cbPassive.dodgeBonus;
      // Companion tier bonuses that affect the player
      const compAlly = cs.allies?.find(a => a.companionData);
      const compTB = compAlly?.tierBonuses || {};
      if (compTB.rangerCritBonus) perkBonuses.critBonus = (perkBonuses.critBonus || 0) + compTB.rangerCritBonus;
      if (compTB.rangerDmgReduction) {
        // Reduce damage taken by ranger while companion lives
        if (compAlly && compAlly.hp > 0) {
          // Applied via a modifier on cbDamageTakenMul-like variable
          // We'll apply it when taking damage below
        }
      }
      const rangerDmgReduction = (compTB.rangerDmgReduction && compAlly?.hp > 0) ? (1 - compTB.rangerDmgReduction / 100) : 1;
      // Track arcane surge charges
      cs.specState.arcaneSurgeCharges = cs.specState.arcaneSurgeCharges || 0;
      // Track vanish state
      cs.specState.vanishActive = cs.specState.vanishActive || false;
      // Track bloodrage state (berserker: next attack 2× after kill)
      cs.specState.bloodrageActive = cs.specState.bloodrageActive || false;
      // Track divine shield
      cs.divineShield = cs.divineShield || 0;

      // Build spec context for class-specs hook calls this turn.
      // All hooks read/write state via ctx.state (= cs.specState).
      const specCtx = {
        player: char,
        target: null,  // set before each damage calc
        attacker: null,
        passive: cbPassive,
        spec: classBonus,
        specSlug: classBonus?.slug || null,
        specTier,
        special: cbTierData.special ? { ...(classBonus?.special || {}), ...cbTierData.special } : classBonus?.special,
        allEnemies: cs.enemies || [],
        allAllies: cs.allies || [],
        log,
        toast: null,
        rand,
        applyEffect,
        STATUS_EFFECTS,
        state: cs.specState,
        combatState: cs,
        abilityType: null,
        abilitySlug: null,
      };
      // Fire combat-start hook (idempotent — won't re-fire once combatStartFired)
      SPECS.specCombatStart(specCtx);
      // Per-turn ticks (hp regen, tick bloodrage/deathlessRage timers, party regen)
      SPECS.specTurnStart(specCtx);

      // Clear defend flag from previous turn
      cs.defending = false;
      // Clear vanish after one round
      if (cs.specState.vanishActive && cs.specState.vanishUsedTurn && cs.specState.vanishUsedTurn < cs.turn) {
        cs.specState.vanishActive = false;
      }

      // Dungeon mechanic: scorching heat DoT
      if (cs.dungeonMechanic === 'scorching-heat') {
        const heatDmg = Math.max(1, Math.floor(char.max_hp * 0.01));
        char.hp -= heatDmg;
        log.push(`🔥 Scorching heat sears you for ${heatDmg} damage.`);
      }

      // Dungeon mechanic: darkness accuracy penalty
      const darknessPenalty = cs.dungeonMechanic === 'darkness' ? 15 : 0;

      // Racial passive (needed both inside and outside stun block)
      const rp = getRacialPassive(char.race);

      if (isStunned(cs.playerEffects) && action !== 'flee') {
        log.push(`💫 You are stunned and cannot act!`);
      } else {

      // Target-specific stats
      const targetEffectMods = target ? getEffectStatMods(target.effects) : {};
      const effectiveTargetAttack = target ? Math.max(1, target.attack + (targetEffectMods.attack || 0)) : 0;
      const effectiveTargetDefense = target ? Math.max(0, target.defense + (targetEffectMods.defense || 0)) : 0;
      const enemyDodgeChance = target ? calcEnemyDodgeChance(target.defense) + darknessPenalty : 0;
      const momentumTier = getMomentumTier(cs.momentum || 0);
      // Rogue's primary stat is DEX — let it contribute to crit on top of CHA.
      // Without this, rogue crit scales only from CHA (a secondary stat) and the
      // 18% CHA cap makes crit builds non-viable. +1% per 4 DEX, capped at +15%.
      const rogueCritBonus = (char.class === 'rogue') ? Math.min(15, Math.floor((effectiveStats.dex || 0) / 4)) : 0;
      const playerCritChance = Math.min(40, calcCritChance(effectiveStats.cha) + rogueCritBonus + perkBonuses.critBonus + momentumTier.critBonus + (rp?.critBonusPct || 0));

      if (action === 'attack') {
        if (rand(1, 100) <= enemyDodgeChance) {
          log.push(`The ${target.name} dodges your attack!`);
        } else {
          let rawDmg = Math.floor(effectiveStats.attack * 0.92) + rand(0, 3);
          let dmg = applyDefenseReduction(rawDmg, effectiveTargetDefense);
          const isCrit = cs.specState.vanishActive ? true : (rand(1, 100) <= playerCritChance);
          if (isCrit) dmg = Math.floor(dmg * 2.0);
          dmg = Math.floor(dmg * cbDamageMul);
          if (cs.specState.bloodrageActive) { dmg = Math.floor(dmg * 2); cs.specState.bloodrageActive = false; log.push(`🔥 Bloodrage! Double damage!`); }
          // Cryomancy T3+: frozen/slowed enemies take +15% damage
          if (cbPassive.frozenVulnerability && (target.effects || []).some(e => e.slug === 'slow' || e.slug === 'stun')) {
            dmg = Math.floor(dmg * (1 + cbPassive.frozenVulnerability / 100));
          }
          dmg = applyRacialDamageBonus(dmg, char.race, 'attack');
          if (target.marked) dmg = Math.floor(dmg * 1.25); // hawk mark bonus
          target.hp -= dmg;
          playerDamage += dmg;
          log.push(isCrit ? `⚡ Critical hit! You strike the ${target.name} for ${dmg} damage.` : `You strike the ${target.name} for ${dmg} damage.`);
          // Absolute Zero: Cryomancy T4 execute non-boss ≤15% HP once per combat
          if (target.hp > 0 && cbPassive.absoluteZero && !cs.specState.absoluteZeroUsed && !target.boss && target.hp <= Math.floor((target.maxHp || target.hp) * 0.15)) {
            target.hp = 0;
            cs.specState.absoluteZeroUsed = true;
            log.push(`❄ Absolute Zero! The ${target.name} shatters to frozen dust!`);
          }
          // On-hit passives from class bonus
          if (cbPassive.onHitBurnChance && rand(1, 100) <= cbPassive.onHitBurnChance) {
            const eff = applyEffect(target.effects, 'burn', 3, 'Pyromancy');
            if (eff) log.push(`🔥 Your attack ignites ${target.name}!`);
          }
          if (cbPassive.onHitSlowChance && rand(1, 100) <= cbPassive.onHitSlowChance) {
            const eff = applyEffect(target.effects, 'slow', 2, 'Cryomancy');
            if (eff) log.push(`❄ Your attack chills ${target.name}!`);
          }
          if (cbPassive.onHitPoisonChance && rand(1, 100) <= cbPassive.onHitPoisonChance) {
            const eff = applyEffect(target.effects, 'poison', 3, 'Poison Mastery');
            if (eff) log.push(`🧪 Your attack poisons ${target.name}!`);
          }
        }
      } else if (action === 'ability') {
        const charAbils = getCharAbilities(char);
        const ability = charAbils.activeAbilities.find(a => a.slug === abilitySlug);
        if (!ability) return res.status(400).json({ error: 'Unknown ability.' });
        cs.cooldowns = cs.cooldowns || {};
        if (cs.cooldowns[ability.slug] > 0) return res.status(400).json({ error: `${ability.name} is on cooldown (${cs.cooldowns[ability.slug]} turns).` });

        // ── Ability rank scaling ──
        const abilityRank = (char.ability_ranks || {})[ability.slug] || 1;
        const rankData = ability.ranks?.[abilityRank - 1] || {};
        const rankedDamage = rankData.damage || ability.damage || 0;
        const rankBonusCrit = rankData.bonusCritChance || 0;
        const rankBonusDmgFlat = rankData.bonusDamageFlat || 0;

        let effectiveCost = getAbilityRankCost(ability.cost, abilityRank);
        const mTier = getMomentumTier(cs.momentum || 0);
        if (mTier.mpDiscount > 0) effectiveCost = Math.floor(effectiveCost * (1 - mTier.mpDiscount));
        if (cbPassive.mpCostReduction) effectiveCost = Math.floor(effectiveCost * (1 - cbPassive.mpCostReduction / 100));
        if (cs.dungeonMechanic === 'arcane-disruption') effectiveCost = Math.ceil(effectiveCost * 1.25);
        if (cs.specState.arcaneSurgeCharges > 0) { effectiveCost = 0; cs.specState.arcaneSurgeCharges--; }
        if (char.mp < effectiveCost) return res.status(400).json({ error: `Not enough MP.${cs.dungeonMechanic === 'arcane-disruption' ? ' (Arcane Disruption: costs +25%)' : ''}` });
        char.mp -= effectiveCost;

        // ── Combo detection ──
        const activeCombo = checkCombo(cs, char, abilitySlug);
        if (activeCombo) {
          log.push(`⚡ COMBO: ${activeCombo.name}!`);
          // Record combo discovery in codex
          if (gameEvents) gameEvents.emit('combo-discovered', { charId: char.id, comboSlug: activeCombo.slug }).catch(() => {});
        }

        const pveCd = ability.pveCooldown ?? (GAME_CONFIG.pveCooldowns[ability.slug]) ?? 0;
        if (pveCd > 0) cs.cooldowns[ability.slug] = pveCd;

        if (ability.type === 'physical' || ability.type === 'magic') {
          if (ability.selfDamagePct && !activeCombo?.effect?.noSelfDamage) {
            const selfDmg = Math.max(1, Math.floor(char.max_hp * ability.selfDamagePct / 100));
            char.hp -= selfDmg;
            log.push(`💢 The reckless strike costs you ${selfDmg} HP!`);
          }
          if (ability.healPct) {
            const healAmt = Math.max(1, Math.floor(char.max_hp * ability.healPct / 100));
            const healed = Math.min(healAmt, char.max_hp - char.hp);
            char.hp += healed;
            if (healed > 0) log.push(`💚 ${ability.name} restores ${healed} HP.`);
          }

          // AoE abilities hit all living enemies; single-target hits the selected target
          const isAoe = ability.aoe || false;
          const targets = isAoe ? livingEnemies : [target];

          for (const t of targets) {
            const tEffMods = getEffectStatMods(t.effects);
            const tDef = Math.max(0, t.defense + (tEffMods.defense || 0));
            const tDodge = calcEnemyDodgeChance(t.defense) + darknessPenalty;

            if (rand(1, 100) <= tDodge) {
              log.push(`The ${t.name} dodges your ${ability.name}!`);
              continue;
            }

            const baseDmg = ability.type === 'magic'
              ? Math.floor((effectiveStats.int * 1.08) + (char.level * 0.4))
              : Math.floor(effectiveStats.attack * 0.95);
            const hits = (ability.hits || 1) + (rankData.bonusHits || 0);
            const isCrit = activeCombo?.effect?.guaranteedCrit ? true : (rand(1, 100) <= (playerCritChance + rankBonusCrit));
            let totalDmg = 0;
            for (let i = 0; i < hits; i++) {
              const rawHit = Math.floor(baseDmg * rankedDamage) + rand(0, 2) + rankBonusDmgFlat;
              const dmg = applyDefenseReduction(rawHit, tDef);
              totalDmg += dmg;
            }
            if (isCrit) totalDmg = Math.floor(totalDmg * 2.0);
            // AoE deals 70% damage to non-primary targets
            if (isAoe && t.id !== target.id) totalDmg = Math.floor(totalDmg * 0.7);
            totalDmg = Math.floor(totalDmg * cbDamageMul);
            // Momentum damage bonus
            if (mTier.dmgBonus > 0) totalDmg = Math.floor(totalDmg * (1 + mTier.dmgBonus));
            // Combo damage bonus
            if (activeCombo?.effect?.damageMult) totalDmg = Math.floor(totalDmg * activeCombo.effect.damageMult);
            // Blade Dance bonus hits
            if (cbPassive.bonusHits && ability.hits > 1) {
              const bonusDmg = Math.floor(totalDmg / ability.hits);
              totalDmg += bonusDmg;
            }
            // Cryomancy T3+: frozen/slowed enemies take bonus damage
            if (cbPassive.frozenVulnerability && (t.effects || []).some(e => e.slug === 'slow' || e.slug === 'stun')) {
              totalDmg = Math.floor(totalDmg * (1 + cbPassive.frozenVulnerability / 100));
            }
            totalDmg = applyRacialDamageBonus(totalDmg, char.race, ability.type);
            if (t.marked) totalDmg = Math.floor(totalDmg * 1.25); // hawk mark bonus
            t.hp -= totalDmg;
            playerDamage += totalDmg;
            playerDamageTarget = t;
            const targetLabel = targets.length > 1 ? ` the ${t.name}` : '';
            log.push(isCrit ? `⚡ Critical! ${ability.name} hits${targetLabel} for ${totalDmg}!` : `You use ${ability.name}${targetLabel} for ${totalDmg} damage.`);
            // Absolute Zero exec (ability)
            if (t.hp > 0 && cbPassive.absoluteZero && !cs.specState.absoluteZeroUsed && !t.boss && t.hp <= Math.floor((t.maxHp || t.hp) * 0.15)) {
              t.hp = 0;
              cs.specState.absoluteZeroUsed = true;
              log.push(`❄ Absolute Zero! The ${t.name} shatters to frozen dust!`);
            }
            // On-hit passives from class bonus on abilities
            if (cbPassive.onHitBurnChance && rand(1, 100) <= cbPassive.onHitBurnChance) {
              const eff = applyEffect(t.effects, 'burn', 3, 'Pyromancy');
              if (eff) log.push(`🔥 ${ability.name} ignites ${t.name}!`);
            }
            if (cbPassive.onHitSlowChance && rand(1, 100) <= cbPassive.onHitSlowChance) {
              const eff = applyEffect(t.effects, 'slow', 2, 'Cryomancy');
              if (eff) log.push(`❄ ${ability.name} chills ${t.name}!`);
            }
            if (cbPassive.onHitPoisonChance && rand(1, 100) <= cbPassive.onHitPoisonChance) {
              const eff = applyEffect(t.effects, 'poison', 3, 'Poison Mastery');
              if (eff) log.push(`🧪 ${ability.name} poisons ${t.name}!`);
            }

            // Status effects on target (stun/slow duration scales with rank)
            if (ability.stun) {
              const stunTurns = 1 + (rankData.durationBonus || 0);
              const eff = applyEffect(t.effects, 'stun', stunTurns, ability.name);
              if (eff) log.push(`💫 The ${t.name} is stunned${stunTurns > 1 ? ` for ${stunTurns} turns` : ''}!`);
            }
            if (ability.slow) {
              const slowTurns = 3 + (rankData.durationBonus || 0);
              const eff = applyEffect(t.effects, 'slow', slowTurns, ability.name);
              if (eff) log.push(`🐌 The ${t.name} is slowed!`);
            }
            if (ability.dot) {
              const dotSlug = ability.dot.type || 'poison';
              const eff = applyEffect(t.effects, dotSlug, ability.dot.turns || 3, ability.name);
              if (eff) {
                eff.damagePerTurn = ability.dot.damage || STATUS_EFFECTS[dotSlug]?.damagePerTurn || 3;
                log.push(`${STATUS_EFFECTS[dotSlug]?.icon || '🧪'} ${ability.name} applies ${STATUS_EFFECTS[dotSlug]?.name || dotSlug} to ${t.name}!`);
              }
            }
            if (ability.statusEffect) {
              const se = ability.statusEffect;
              const eff = applyEffect(t.effects, se.slug, se.turns || 3, ability.name);
              if (eff) {
                if (se.damagePerTurn) eff.damagePerTurn = se.damagePerTurn;
                log.push(`${STATUS_EFFECTS[se.slug]?.icon || '✦'} ${ability.name} applies ${STATUS_EFFECTS[se.slug]?.name || se.slug} to ${t.name}!`);
              }
            }
          }
        } else if (ability.type === 'buff') {
          cs.playerBuffs = cs.playerBuffs || [];
          const buffDurBonus = rankData.durationBonus || 0;
          const buffStrBonus = rankData.buffBonus || 0;
          const scaledBuff = { ...ability.buff, name: ability.name, turnsLeft: (ability.buff.turns || 3) + buffDurBonus };
          // Apply strength bonus to numeric buff values
          if (buffStrBonus > 0) {
            for (const k of Object.keys(scaledBuff)) {
              if (typeof scaledBuff[k] === 'number' && !['turns', 'turnsLeft'].includes(k)) {
                scaledBuff[k] = Math.floor(scaledBuff[k] * (1 + buffStrBonus));
              }
            }
          }
          cs.playerBuffs.push(scaledBuff);
          if (ability.secondaryBuff) {
            cs.playerBuffs.push({ ...ability.secondaryBuff, name: ability.name + ' (2)', turnsLeft: ability.secondaryBuff.turns });
          }
          if (ability.restoreMp) {
            const restored = Math.min(ability.restoreMp, char.max_mp - char.mp);
            char.mp += restored;
            if (restored > 0) log.push(`✨ You recover ${restored} MP.`);
          }
          log.push(`You use ${ability.name}. ${ability.description}`);
        } else if (ability.type === 'heal') {
          const rankedHealPct = rankData.healPct || ability.healPct || 0;
          let healAmount = rankedHealPct
            ? Math.max(1, Math.floor(char.max_hp * rankedHealPct / 100))
            : (ability.heal || 0);
          if (activeCombo?.effect?.healBonus) healAmount = Math.floor(healAmount * activeCombo.effect.healBonus);
          const healed = Math.min(healAmount, char.max_hp - char.hp);
          char.hp += healed;
          log.push(`You use ${ability.name} and recover ${healed} HP.`);
          // Rank cleanse bonus
          if (rankData.cleanse && (cs.playerEffects || []).length > 0) {
            const debuffs = (cs.playerEffects || []).filter(e => { const d = STATUS_EFFECTS[e.slug]; return d && (d.type === 'dot' || d.type === 'debuff' || d.type === 'cc'); });
            if (debuffs.length > 0) {
              const toCleanse = rankData.cleanse === 'all' ? debuffs : debuffs.slice(0, rankData.cleanse);
              for (const eff of toCleanse) removeEffect(cs.playerEffects, eff.slug);
              log.push(`✨ ${ability.name} also cleanses ${toCleanse.map(e => e.name).join(', ')}!`);
            }
          }
        } else if (ability.type === 'restore') {
          // Rank scaling: restoreBonus multiplier (e.g. 0.15 = +15% MP restore)
          const restoreMultiplier = 1 + (rankData.restoreBonus || 0);
          const baseRestore = ability.restore || 0;
          const scaledRestore = Math.floor(baseRestore * restoreMultiplier);
          const restored = Math.min(scaledRestore, char.max_mp - char.mp);
          char.mp += restored;
          log.push(`You use ${ability.name} and recover ${restored} MP.`);
        } else if (ability.type === 'purify') {
          // Rank scaling: cleanse at R3+, bonusHealPct stacks with base healPct
          const removable = (cs.playerEffects || []).filter(e => {
            const def = STATUS_EFFECTS[e.slug];
            return def && (def.type === 'dot' || def.type === 'debuff' || def.type === 'cc');
          });
          if (rankData.cleanse && removable.length > 0) {
            const toCleanse = rankData.cleanse === 'all' ? removable : removable.slice(0, rankData.cleanse);
            for (const eff of toCleanse) removeEffect(cs.playerEffects, eff.slug);
            log.push(`✨ ${ability.name} cleanses ${toCleanse.map(e => e.name).join(', ')}!`);
          } else if (removable.length > 0) {
            // Base purify (no rank cleanse): still cleanses all
            for (const eff of removable) removeEffect(cs.playerEffects, eff.slug);
            log.push(`✨ ${ability.name} cleanses ${removable.map(e => e.name).join(', ')}!`);
          } else {
            log.push(`You use ${ability.name}, but there was nothing to cleanse.`);
          }
          const totalHealPct = (ability.healPct || 0) + (rankData.bonusHealPct || 0);
          if (totalHealPct > 0) {
            const healAmount = Math.max(1, Math.floor(char.max_hp * totalHealPct / 100));
            const healed = Math.min(healAmount, char.max_hp - char.hp);
            char.hp += healed;
            if (healed > 0) log.push(`💚 ${ability.name} restores ${healed} HP.`);
          }
          // Rank shield bonus (R4+): temporary damage absorption
          if (rankData.shield) {
            const shieldAmt = Math.floor(char.max_hp * rankData.shield / 100);
            cs.divineShield = (cs.divineShield || 0) + shieldAmt;
            log.push(`🛡 ${ability.name} grants a ${shieldAmt} HP shield!`);
          }
        } else if (ability.type === 'party-buff') {
          // Solo: buff self
          const durBonus = rankData.durationBonus || 0;
          const buffAmt = rankData.buffAmount || ability.partyBuff?.amount || 3;
          const buffTurns = (ability.partyBuff?.turns || 3) + durBonus;
          cs.playerBuffs = cs.playerBuffs || [];
          cs.playerBuffs.push({ stat: ability.partyBuff?.stat || 'defense', amount: buffAmt, name: ability.name, turnsLeft: buffTurns });
          if (ability.partyBuff2) cs.playerBuffs.push({ stat: ability.partyBuff2.stat, amount: ability.partyBuff2.amount, name: ability.name, turnsLeft: (ability.partyBuff2.turns || 3) + durBonus });
          log.push(`✨ You use ${ability.name}. +${buffAmt} ${(ability.partyBuff?.stat || 'DEF').toUpperCase()} for ${buffTurns} turns.`);
        } else if (ability.type === 'ally-heal' || ability.type === 'party-heal') {
          // Solo: heal self
          const rankedHealPct = rankData.healPct || ability.allyHealPct || ability.partyHealPct || ability.healPct || 20;
          const healAmt = Math.max(1, Math.floor(char.max_hp * rankedHealPct / 100));
          const healed = Math.min(healAmt, char.max_hp - char.hp);
          char.hp += healed;
          log.push(`💚 You use ${ability.name} and recover ${healed} HP.`);
        } else if (ability.type === 'ally-restore') {
          // Solo: restore own MP (with optional HP cost for Life Tap)
          const hpCostPct = rankData.hpCostPct || ability.hpCostPct || 0;
          if (hpCostPct > 0) {
            const hpCost = Math.max(1, Math.floor(char.max_hp * hpCostPct / 100));
            char.hp -= hpCost;
            log.push(`💔 You sacrifice ${hpCost} HP.`);
          }
          const restorePct = rankData.restorePct || ability.allyRestorePct || 0;
          if (restorePct > 0) {
            const restoreAmt = Math.max(1, Math.floor(char.max_mp * restorePct / 100));
            const restored = Math.min(restoreAmt, char.max_mp - char.mp);
            char.mp += restored;
            log.push(`💜 You use ${ability.name} and recover ${restored} MP.`);
          } else {
            const restoreAmt = rankData.restore || ability.allyRestore || 15;
            const restored = Math.min(restoreAmt, char.max_mp - char.mp);
            char.mp += restored;
            log.push(`💜 You use ${ability.name} and recover ${restored} MP.`);
          }
        } else if (ability.type === 'party-debuff') {
          // Solo: debuff enemy + deal damage
          if (target) {
            const debuffTurns = (ability.enemyDebuff?.turns || 3) + (rankData.durationBonus || 0);
            const eff = applyEffect(target.effects, ability.enemyDebuff?.slug || 'weaken', debuffTurns, ability.name);
            if (eff) log.push(`🎯 ${ability.name} weakens ${target.name} for ${debuffTurns} turns!`);
            if (rankData.damage) {
              const baseDmg = Math.floor(effectiveStats.attack * 0.95);
              let dmg = applyDefenseReduction(Math.floor(baseDmg * rankData.damage) + rand(0, 2), effectiveTargetDefense);
              dmg = applyRacialDamageBonus(dmg, char.race, 'physical');
              target.hp -= dmg;
              log.push(`${ability.name} hits ${target.name} for ${dmg}.`);
            }
          }
        } else if (ability.type === 'taunt') {
          // Solo: taunt enemies to target you (useful with companions)
          const tauntTurns = rankData.tauntTurns || ability.tauntTurns || 2;
          cs.playerTaunting = tauntTurns;
          if (rankData.bonusDefense) {
            cs.playerBuffs = cs.playerBuffs || [];
            cs.playerBuffs.push({ stat: 'defense', amount: rankData.bonusDefense, name: ability.name, turnsLeft: tauntTurns });
          }
          log.push(`🛡 You taunt the enemies for ${tauntTurns} turns!`);
        } else if (ability.type === 'ally-revive') {
          // Solo: no allies to revive — heal self instead
          const healAmt = Math.max(1, Math.floor(char.max_hp * 0.15));
          const healed = Math.min(healAmt, char.max_hp - char.hp);
          char.hp += healed;
          log.push(`🌟 No allies to revive. ${ability.name} restores ${healed} HP instead.`);
        }
      } else if (action === 'item') {
        if (cs.arenaRun) return res.status(400).json({ error: 'Consumables are not allowed in the arena!' });
        if (cs.raidRun) return res.status(400).json({ error: 'Consumables are not allowed in raids!' });
        const item = getContent().items[itemSlug];
        if (!item || item.type !== 'consumable') return res.status(400).json({ error: 'Invalid item.' });
        const removed = await removeItem(char.id, itemSlug);
        if (!removed) return res.status(400).json({ error: "You don't have that item." });
        applyConsumableUse(item, char, { effectsArray: cs.playerEffects, tempPassives: cs.playerTempPassives, log });
      } else if (action === 'classAbility') {
        if (!classBonus?.special) return res.status(400).json({ error: 'No class ability available.' });
        cs.classCooldowns = cs.classCooldowns || {};
        const specAbilitySlug = classBonus.special.slug;
        if (cs.classCooldowns[specAbilitySlug] > 0) return res.status(400).json({ error: `${classBonus.special.name} has already been used this combat.` });
        cs.classCooldowns[specAbilitySlug] = classBonus.special.cooldown || 99;
        // Delegate to the shared spec engine — handles all 10 special.type variants
        // including redesigned Miracle (Radiance T4), Overchannel (Arcanistry T4),
        // and all T4 tier-aware behaviors.
        specCtx.target = target;
        SPECS.specClassAbility(specCtx);
        // Track damage dealt for post-combat accounting (aoe-damage + true-damage)
        // The hook mutates target.hp / enemy.hp directly, so playerDamage is updated
        // via the cs.enemies iteration after this block.
      } else if (action === 'defend') {
        cs.defending = true;
        log.push(`🛡 You brace yourself, reducing incoming damage this turn.`);
      } else if (action === 'flee') {
        if (cs.arenaRun) return res.status(400).json({ error: 'You cannot flee from the arena!' });
        if (cs.raidRun) return res.status(400).json({ error: 'You cannot flee from a raid! Fight or fall.' });
        const chance = 40 + effectiveStats.dex * 2;
        if (rand(1, 100) <= chance) {
          fled = true;
          log.push('You flee from combat!');
          if (cs.dungeonRun) {
            log.push('You retreat from the dungeon. Progress is lost.');
          }
        } else {
          log.push('You failed to flee!');
        }
      } else {
        return res.status(400).json({ error: 'Invalid action.' });
      }

      } // end stun check

      // ── Momentum tracking ──
      cs.momentum = cs.momentum || 0;
      if (action === 'attack' || action === 'ability') {
        const mMsg = adjustMomentum(cs, 1);
        if (mMsg) log.push(mMsg);
      } else if (action === 'defend') {
        const mMsg = adjustMomentum(cs, 2);
        if (mMsg) log.push(mMsg);
      } else if (action === 'flee') {
        cs.momentum = 0;
      }
      // Track last ability for combo system
      if (action === 'ability' && abilitySlug) {
        cs.lastAbilitySlug = abilitySlug;
      } else if (action !== 'ability') {
        cs.lastAbilitySlug = null;
      }

      // ── Apply player damage passives (lifesteal etc.) ──
      if (playerDamage > 0 && playerDamageTarget) {
        const currentPassives = getCombatPassives(equipment, cs.playerTempPassives);
        applyDamagePassives(char, playerDamageTarget, playerDamage, currentPassives, playerDamageTarget.effects, log);
      }
      // Racial passive: lifesteal (orc)
      if (playerDamage > 0 && rp?.lifestealPct) {
        const racialHeal = Math.min(char.max_hp - char.hp, Math.max(0, Math.floor(playerDamage * rp.lifestealPct / 100)));
        if (racialHeal > 0) { char.hp += racialHeal; log.push(`🔥 ${rp.name} restores ${racialHeal} HP through lifesteal.`); }
      }

      // ── Tick effects on ALL enemies ──
      for (const en of cs.enemies) {
        if (en.hp <= 0) continue;
        if (en.effects.length > 0) {
          const hpDelta = tickEffects(en.effects, `The ${en.name}`, en.hp, en.maxHp, log);
          en.hp += hpDelta;
        }
      }

      // Legacy playerDots support
      if (cs.playerDots && cs.playerDots.length > 0) {
        const dotTarget = firstLivingEnemy(cs.enemies);
        if (dotTarget) {
          for (const dot of cs.playerDots) {
            if (dot.turns > 0) {
              dotTarget.hp -= dot.damage;
              dot.turns--;
              log.push(`${dot.name} deals ${dot.damage} poison damage to ${dotTarget.name}.`);
            }
          }
          cs.playerDots = cs.playerDots.filter(d => d.turns > 0);
        }
      }

      // ── Ally turns (batch-resolve) ──
      for (const ally of cs.allies) {
        // If player sent a petAbility override, set it on the companion
        if (petAbility && ally.companionData) {
          ally.activeAbility = petAbility;
        }
        resolveAllyTurn(ally, cs, log, targetId || target?.id);
      }
      // Remove dead allies (immortal companions respawn after 2 turns)
      for (const ally of cs.allies) {
        if (ally.hp <= 0 && ally.immortal) {
          ally.respawnTimer = (ally.respawnTimer || 0) + 1;
          if (ally.respawnTimer >= 2) {
            ally.hp = Math.floor(ally.maxHp * 0.5);
            ally.respawnTimer = 0;
            log.push(`${ally.icon || '🐾'} ${ally.name} returns to the fight!`);
          }
        }
      }
      cs.allies = cs.allies.filter(a => a.hp > 0 || a.immortal);

      // ── Spec onKill hooks: bloodrage (berserker), inferno (pyromancy T4),
      //     plague vector (poison-mastery T4). Fires for each newly-dead enemy. ──
      for (const en of cs.enemies) {
        if (en.hp <= 0 && !en._deathHookFired) {
          en._deathHookFired = true;
          specCtx.target = en;
          SPECS.specOnKill(specCtx);
        }
      }

      // ── Companion tier: packAlpha (wolf kill → ranger +20% dmg 2 turns) ──
      if (compTB.packAlpha) {
        for (const en of cs.enemies) {
          if (en.hp <= 0 && !en._packAlphaChecked) {
            en._packAlphaChecked = true;
            cs.playerBuffs = cs.playerBuffs || [];
            cs.playerBuffs.push({ stat: 'damage', amount: 20, name: 'Pack Alpha', turnsLeft: 2 });
            log.push(`🐺 Pack Alpha! ${compAlly?.name || 'Your companion'}'s kill empowers you! +20% damage for 2 turns.`);
          }
        }
      }

      // ── Check ALL enemies dead (victory) ──
      const allEnemiesDead = cs.enemies.every(e => e.hp <= 0) && !fled;

      if (allEnemiesDead) {
        // Aggregate rewards from all enemies
        const isArena = cs.arenaRun && char.arena_state;
        let totalXp = 0, totalGold = 0;
        const killedEnemies = cs.enemies.filter(e => e.hp <= 0);

        for (const en of killedEnemies) {
          const eliteMul = en.elite ? 1.5 : 1;
          const xpGain = isArena ? 0 : Math.floor(en.xp * eliteMul);
          const goldGain = isArena ? 0 : Math.floor((en.gold + rand(0, Math.floor(en.gold / 3))) * eliteMul);
          totalXp += xpGain;
          totalGold += goldGain;
          log.push(isArena
            ? `☠ The ${en.name} is slain!`
            : `☠ The ${en.name} is slain! +${xpGain} XP, +${goldGain} gold.`);
        }

        // Apply racial XP/gold bonuses
        const rpVictory = getRacialPassive(char.race);
        if (rpVictory?.xpBonusPct && !isArena) totalXp = Math.floor(totalXp * (1 + rpVictory.xpBonusPct / 100));
        if (rpVictory?.goldBonusPct && !isArena) totalGold = Math.floor(totalGold * (1 + rpVictory.goldBonusPct / 100));

        if (!isArena) {
          char.xp += totalXp;
          char.gold += totalGold;
        }

        // Use primary enemy (first) for boss checks, events, quests
        const primaryEnemy = cs.enemies[0];

        const victoryResult = await withTransaction(async (tx) => {

        // ── ARENA VICTORY BRANCH ──
        if (isArena) {
          const as = char.arena_state;
          const wave = as.wave || 1;
          const apBonus = as.apBonusActive ? 1.5 : 1.0;
          const baseAp = Math.floor(3 + (wave * 1.2) + (wave * wave * 0.05));
          const waveAp = Math.floor(baseAp * apBonus);
          as.ap = (as.ap || 0) + waveAp;
          as.wave = wave;
          as.betweenWaves = true;
          as.apBonusActive = false;
          as.lastWaveAp = waveAp;
          log.push(`🏟 Arena Wave ${wave} cleared! +${waveAp} AP${apBonus > 1 ? ' (bonus!)' : ''}`);

          if (cs.isBossRoom && wave >= 30) {
            const gemTypes = ['ruby', 'sapphire', 'emerald', 'amethyst', 'topaz', 'opal'];
            let gemTier, gemChance;
            if (wave >= 120) { gemTier = 'flawless'; gemChance = 10; }
            else if (wave >= 70) { gemTier = 'cut'; gemChance = 15; }
            else { gemTier = 'chipped'; gemChance = 20; }
            if (rand(1, 100) <= gemChance) {
              const gemType = gemTypes[rand(0, gemTypes.length - 1)];
              const gemSlug = `${gemTier}-${gemType}`;
              const gemItem = getContent().items[gemSlug];
              await addItem(char.id, gemSlug, 1, null, tx);
              log.push(`💎 Arena reward: ${gemItem?.name || gemSlug}!`);
            }
          }

          await tx.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, hp=$1, mp=$2, xp=$3, gold=$4, arena_state=$5 WHERE id=$6',
            [char.hp, char.mp, char.xp, char.gold, JSON.stringify(as), char.id]);
          const levelUp = await checkLevelUp(char, tx);
          if (levelUp.messages.length) log.push(...levelUp.messages);
          for (const l of log) await addLog(char.id, 'combat', l, tx);
          return { arenaWaveClear: true };
        }

        // ── PER-ENEMY REWARDS ──
        for (const en of killedEnemies) {
          await gameEvents.emit('enemy-killed', {
            charId: char.id, enemySlug: en.slug, enemyName: en.name,
            isBoss: !!en.boss, location: char.location,
            isDungeon: !!cs.dungeonRun, isQuestCombat: !!cs.questCombat,
            xpGain: Math.floor(en.xp * (en.elite ? 1.5 : 1)),
            goldGain: Math.floor(en.gold * (en.elite ? 1.5 : 1)), log,
          });

          if (en.boss) {
            const bossTokens = rand(1, 3);
            char.arcane_tokens = (char.arcane_tokens || 0) + bossTokens;
            await tx.query('UPDATE fantasy_characters SET arcane_tokens=$1 WHERE id=$2', [char.arcane_tokens, char.id]);
            log.push(`✦ Earned ${bossTokens} Arcane Token${bossTokens > 1 ? 's' : ''} from the boss!`);
            await gameEvents.emit('boss-killed', {
              charId: char.id, enemySlug: en.slug, enemyName: en.name,
              location: char.location, isDungeon: !!cs.dungeonRun, tokens: bossTokens,
            });
          }

          if (en.drops && en.drops.length > 0) {
            for (const drop of en.drops) {
              const item = getContent().items[drop];
              const rarity = item?.rarity || 'common';
              const chance = GAME_CONFIG.lootDropChance[rarity] ?? GAME_CONFIG.lootDropChance.common;
              if (rand(1, 100) <= chance) {
                const perks = rollPerks(rarity, item);
                await addItem(char.id, drop, 1, perks, tx);
                const displayName = perks ? (getPerkPrefix(perks) + ' ' + (item?.name || drop)) : (item?.name || drop);
                const perkText = perks ? ` [${perks.length} perk${perks.length > 1 ? 's' : ''}]` : '';
                log.push(`📦 Loot: ${displayName}${perkText}`);
                await gameEvents.emit('item-looted', { charId: char.id, itemSlug: drop, source: 'combat-drop', perks, enemySlug: en.slug });
              }
            }
          }

          if (en.boss && cs.dungeonRun) {
            const mythicChance = en.mythicDropChance || 2;
            if (rand(1, 100) <= mythicChance) {
              const allMythics = Object.entries(getContent().items).filter(([, it]) => it.rarity === 'mythic' && EQUIPMENT_SLOTS.includes(it.type));
              if (allMythics.length > 0) {
                const [mythicSlug, mythicBase] = allMythics[rand(0, allMythics.length - 1)];
                const perks = rollPerks('mythic', mythicBase);
                await addItem(char.id, mythicSlug, 1, perks, tx);
                const displayName = perks ? (getPerkPrefix(perks) + ' ' + (mythicBase.name || mythicSlug)) : (mythicBase.name || mythicSlug);
                log.push(`🔴 MYTHIC DROP: ${displayName}! [${perks?.length || 0} perks]`);
                await gameEvents.emit('item-looted', { charId: char.id, itemSlug: mythicSlug, source: 'mythic-drop', perks, enemySlug: en.slug });
              }
            }
          }

          // Elite bonus loot
          if (en.elite && en.drops && en.drops.length > 0) {
            const bonusDrop = en.drops[rand(0, en.drops.length - 1)];
            const bonusItem = getContent().items[bonusDrop];
            const bonusRarity = bonusItem?.rarity || 'uncommon';
            const perks = rollPerks(bonusRarity, bonusItem);
            await addItem(char.id, bonusDrop, 1, perks, tx);
            const displayName = perks ? (getPerkPrefix(perks) + ' ' + (bonusItem?.name || bonusDrop)) : (bonusItem?.name || bonusDrop);
            log.push(`⭐ Elite bonus loot: ${displayName}`);
          }

          await awardExploreMaterials(char.id, en, log, { isDungeon: !!cs.dungeonRun, questCombat: !!cs.questCombat }, tx);
          await awardBossRecipe(char.id, en, log, tx);
        }

        // ── DUNGEON PROGRESS ──
        if (cs.dungeonRun) {
          const ds = char.dungeon_state;
          if (ds) {
            if (cs.isBossRoom) {
              const cfg = getContent().dungeonConfig[ds.dungeon];
              log.push(`🏆 DUNGEON COMPLETE! You have conquered ${cfg?.name || 'the dungeon'}!`);
              const bonusGold = rand(15, 40) + (ds.totalRooms * 5);
              char.gold += bonusGold;
              log.push(`💰 Dungeon bonus: +${bonusGold} gold.`);
              await tx.query('UPDATE fantasy_characters SET dungeon_state=NULL WHERE id=$1', [char.id]);
              await gameEvents.emit('dungeon-cleared', { charId: char.id, dungeonSlug: ds.dungeon, dungeonName: cfg?.name, bonusGold });
            } else {
              ds.roomsCleared++;
              const remaining = ds.totalRooms - ds.roomsCleared;
              log.push(`🏰 Room cleared! ${remaining} room${remaining !== 1 ? 's' : ''} remaining.${remaining === 1 ? ' 🔥 The boss awaits in the final chamber!' : ''}`);
              // Hidden room: 10% chance, once per dungeon run
              if (!ds.hiddenRoomFound && rand(1, 100) <= 10) {
                ds.hiddenRoomFound = true;
                const hiddenRoll = rand(1, 100);
                if (hiddenRoll <= 50) {
                  const bonusGold = rand(20, 60);
                  char.gold += bonusGold;
                  log.push(`🗝 You discover a hidden chamber! A treasure chest glimmers in the darkness. +${bonusGold} gold!`);
                } else if (hiddenRoll <= 80) {
                  const buffAmount = rand(3, 6);
                  cs.playerBuffs = cs.playerBuffs || [];
                  cs.playerBuffs.push({ stat: 'all', amount: buffAmount, turns: 99 });
                  log.push(`🗝 You discover a hidden shrine! A warm glow washes over you. (+${buffAmount} all stats for this dungeon)`);
                } else {
                  const bonusXp = rand(15, 35);
                  char.xp += bonusXp;
                  log.push(`🗝 You discover a hidden chamber! Ancient inscriptions teach you forgotten knowledge. +${bonusXp} XP!`);
                }
              }
              await tx.query('UPDATE fantasy_characters SET dungeon_state=$1 WHERE id=$2', [JSON.stringify(ds), char.id]);
            }
          }
        }

        // ── QUEST COMBAT ──
        if (cs.questCombat) {
          const quest = getContent().quests.find(qq => qq.slug === cs.questCombat.questSlug);
          const questRow = await q1("SELECT * FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2 AND status='active'", [char.id, cs.questCombat.questSlug], tx);
          if (quest && questRow) {
            const nextStage = cs.questCombat.nextStage;
            const nextStageDef = quest.stages[nextStage];
            if (nextStageDef?.complete) {
              const totalGold = quest.rewards.gold + questRow.bonus_gold;
              const totalXp = quest.rewards.xp + questRow.bonus_xp;
              char.xp += totalXp;
              char.gold += totalGold;
              log.push(nextStageDef.text);
              log.push(`🏆 Quest complete: ${quest.title}! +${totalXp} XP, +${totalGold} gold.`);
              if (quest.rewards.item) {
                await addItem(char.id, quest.rewards.item, 1, null, tx);
                const rewardItem = getContent().items[quest.rewards.item];
                log.push(`📦 Received: ${rewardItem?.name || quest.rewards.item}`);
              }
              await tx.query("UPDATE fantasy_quests SET status='completed', stage=$1, completed_at=NOW() WHERE id=$2", [nextStage, questRow.id]);
              await gameEvents.emit('quest-completed', { charId: char.id, questSlug: quest.slug, questTitle: quest.title, xpGain: totalXp, goldGain: totalGold, rewardItem: quest.rewards.item });
            } else {
              await tx.query('UPDATE fantasy_quests SET stage=$1 WHERE id=$2', [nextStage, questRow.id]);
              if (nextStageDef?.text) {
                log.push(`📜 ${quest.title}: ${nextStageDef.text}`);
              }
            }
          }
        }

        // ── BOSS GEAR REPAIR ──
        if (primaryEnemy.boss) {
          const bossEq = await q('SELECT slot, item_slug, durability FROM fantasy_equipment WHERE char_id = $1', [char.id], tx);
          let repairedAny = false;
          for (const row of bossEq) {
            const maxDur = getMaxDurability(row.item_slug);
            if (row.durability < maxDur) {
              const restored = Math.max(1, Math.floor(maxDur * 0.2));
              const newDur = Math.min(maxDur, row.durability + restored);
              await tx.query('UPDATE fantasy_equipment SET durability=$1 WHERE char_id=$2 AND slot=$3', [newDur, char.id, row.slot]);
              repairedAny = true;
            }
          }
          if (repairedAny) log.push(`🔧 Boss victory! All gear repaired by 20%.`);
        }

        // ── COMPANION XP ──
        if (char.companion && cs.allies?.some(a => a.companionData && a.hp > 0)) {
          const compXp = Math.floor(totalXp * 0.5);
          if (compXp > 0) {
            char.companion.xp = (char.companion.xp || 0) + compXp;
            const compDef = GAME_CONFIG.companions[char.companion.type];
            if (compDef) {
              const currentLevel = char.companion.level || 1;
              const xpNeeded = compDef.xpCurve[currentLevel] || 999999;
              if (char.companion.xp >= xpNeeded && currentLevel < 5) {
                char.companion.level = currentLevel + 1;
                char.companion.xp -= xpNeeded;
                const newAbilities = compDef.abilities.filter(a => a.unlock === char.companion.level);
                log.push(`🎉 ${char.companion.name || compDef.name} reaches level ${char.companion.level}!`);
                for (const ab of newAbilities) log.push(`✨ New pet ability unlocked: ${ab.name}!`);
                // Achievement: companion-level
                if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'companion-level', char.companion.level);
              } else {
                log.push(`${compDef.icon} ${char.companion.name || compDef.name} +${compXp} XP`);
              }
            }
            await tx.query('UPDATE fantasy_characters SET companion=$1 WHERE id=$2', [JSON.stringify(char.companion), char.id]);
          }
        }

        // ── RAID COMBAT VICTORY ──
        if (cs.raidRun && char.raid_state && ctx.handleRaidCombatVictory) {
          await ctx.handleRaidCombatVictory(char, cs, log, tx);
        }

        const raidState = cs.raidRun ? char.raid_state : null;
        const raidComplete = raidState?.phase === 'complete';

        await tx.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, hp=$1, mp=$2, xp=$3, gold=$4, raid_state=$5 WHERE id=$6',
          [char.hp, char.mp, char.xp, char.gold, raidState ? JSON.stringify(raidState) : (cs.raidRun ? null : char.raid_state ? JSON.stringify(char.raid_state) : null), char.id]);
        for (const l of log) await addLog(char.id, 'combat', l, tx);
        const levelUp = await checkLevelUp(char, tx);
        if (levelUp.messages.length) log.push(...levelUp.messages);
        return { arenaWaveClear: false, raidAdvance: !!cs.raidRun, raidComplete };

        }); // end withTransaction

        // Achievement triggers on victory
        if (ctx.checkAndAwardAchievements) {
          // elite-killed: count elites in this fight
          const elitesKilled = killedEnemies.filter(e => e.elite).length;
          if (elitesKilled > 0) {
            if (ctx.recordCodex) await ctx.recordCodex(char.id, 'elite', 'elite-kill');
            const totalElites = await q1('SELECT COALESCE(SUM(count),0)::int as total FROM fantasy_codex WHERE char_id=$1 AND category=$2', [char.id, 'elite']);
            await ctx.checkAndAwardAchievements(char.id, 'elites-killed', totalElites?.total || 0);
          }
          // group-victory: won a fight against 3+ enemies
          if (killedEnemies.length >= 3) {
            await ctx.checkAndAwardAchievements(char.id, 'group-victory', killedEnemies.length);
          }
          // low-hp-victory: won with less than 10% HP
          if (char.hp > 0 && char.hp <= Math.floor(char.max_hp * 0.1)) {
            await ctx.checkAndAwardAchievements(char.id, 'low-hp-victory', 1);
          }
        }

        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({
          ok: true, state, combatLog: log, combatOver: true, victory: true,
          ...(victoryResult.arenaWaveClear ? { arenaWaveClear: true } : {}),
          ...(victoryResult.raidAdvance ? { raidAdvance: true } : {}),
          ...(victoryResult.raidComplete ? { raidComplete: true } : {}),
        });
      }

      // ── Enemy turns (all living enemies act) ──
      if (!fled) {
        for (const en of cs.enemies) {
          if (en.hp <= 0) continue;
          const enEffMods = getEffectStatMods(en.effects);
          const enAtk = Math.max(1, en.attack + (enEffMods.attack || 0));
          const enemyIsStunned = isStunned(en.effects);

          if (enemyIsStunned) {
            // Stun cancels active telegraph
            if (en.telegraphing) { log.push(`💫 The ${en.name} is stunned — ${en.telegraphing.name} interrupted!`); en.telegraphing = null; }
            else { log.push(`💫 The ${en.name} is stunned and cannot act!`); }
            continue;
          }

          // ── Enrage check ──
          if (!en.enraged && en.enrageThreshold && en.hp <= en.maxHp * en.enrageThreshold) {
            en.enraged = true;
            en.attack = Math.floor(en.attack * (1 + (GAME_CONFIG.enrage?.attackBonus || 0.3)));
            en.defense = Math.floor(en.defense * (1 + (GAME_CONFIG.enrage?.defenseBonus || 0.15)));
            log.push(`🔥 ${en.name} ENRAGES! Attack and defense increased!`);
          }

          // ── Telegraphing system ──
          const telegraphDefs = GAME_CONFIG.telegraphs || {};
          if (en.telegraphing) {
            en.telegraphing.turnsLeft--;
            if (en.telegraphing.turnsLeft <= 0) {
              // Resolve telegraph
              const tg = en.telegraphing;
              const tgDef = telegraphDefs[tg.slug] || {};
              if (tgDef.type === 'heavy') {
                const dmgMul = tgDef.damage || 2.0;
                const enAtkNow = Math.max(1, en.attack + (enEffMods.attack || 0));
                let tgDmg = Math.floor(enAtkNow * dmgMul);
                if (cs.defending) tgDmg = Math.max(1, Math.floor(tgDmg * 0.5));
                tgDmg = Math.max(1, Math.floor(tgDmg * cbDamageTakenMul));
                if (cs.divineShield > 0) { const ab = Math.min(cs.divineShield, tgDmg); cs.divineShield -= ab; tgDmg -= ab; if (ab > 0) log.push('🛡 Divine Shield absorbs ' + ab + '!'); }
                if (cs.specState.vanishActive) { log.push('🌑 ' + tg.name + ' passes through your shadow!'); }
                else { char.hp -= Math.max(0, tgDmg); log.push('${tg.icon} ${en.name} unleashes ${tg.name} for ${tgDmg} damage!'.replace(/\$\{tg\.icon\}/g, tgDef.icon||'💥').replace(/\$\{en\.name\}/g, en.name).replace(/\$\{tg\.name\}/g, tg.name).replace(/\$\{tgDmg\}/g, tgDmg)); }
              } else if (tgDef.type === 'aoe') {
                if (tgDef.damage) {
                  const enAtkNow = Math.max(1, en.attack + (enEffMods.attack || 0));
                  let tgDmg = Math.floor(enAtkNow * tgDef.damage);
                  tgDmg = Math.max(1, Math.floor(tgDmg * cbDamageTakenMul));
                  if (cs.defending) tgDmg = Math.max(1, Math.floor(tgDmg * 0.5));
                  if (!cs.specState.vanishActive) { char.hp -= tgDmg; log.push((tgDef.icon||'💥') + ' ' + en.name + ' unleashes ' + tg.name + ' for ' + tgDmg + ' damage!'); }
                  else { log.push('🌑 ' + tg.name + ' passes through your shadow!'); }
                  // Hit allies too
                  for (const ally of cs.allies) {
                    if (ally.hp <= 0) continue;
                    const allyDmg = Math.max(1, Math.floor(tgDmg * 0.7));
                    ally.hp -= allyDmg;
                    log.push((tgDef.icon||'💥') + ' ' + tg.name + ' hits ' + ally.name + ' for ' + allyDmg + '!');
                  }
                }
                if (tgDef.dot) {
                  const eff = applyEffect(cs.playerEffects, tgDef.dot.type, tgDef.dot.turns, tg.name);
                  if (eff) { eff.damagePerTurn = tgDef.dot.damage; log.push((tgDef.icon||'☁') + ' ' + tg.name + ' engulfs you in ' + tgDef.dot.type + '!'); }
                }
              } else if (tgDef.type === 'buff') {
                const buff = tgDef.buff;
                en[buff.stat] = (en[buff.stat] || en.attack) + buff.amount;
                log.push((tgDef.icon||'⬆') + ' ' + en.name + ' uses ' + tg.name + '! (+' + buff.amount + ' ' + buff.stat + ')');
              } else if (tgDef.type === 'heal') {
                const heal = Math.floor(en.maxHp * (tgDef.healPct || 20) / 100);
                en.hp = Math.min(en.maxHp, en.hp + heal);
                log.push((tgDef.icon||'💚') + ' ' + en.name + ' heals for ' + heal + ' HP!');
              } else if (tgDef.type === 'summon') {
                // Summon a weak add
                const addId = 'e' + (cs.enemies.length);
                const addHp = Math.floor(en.maxHp * 0.3);
                cs.enemies.push({ id: addId, name: en.name + ' Minion', slug: 'summoned-minion', hp: addHp, maxHp: addHp, attack: Math.floor(en.attack * 0.5), defense: Math.floor(en.defense * 0.3), effects: [], xp: Math.floor((en.xp||5) * 0.3), gold: 0, drops: [] });
                log.push((tgDef.icon||'👥') + ' ' + en.name + ' summons a minion!');
              }
              en.telegraphing = null;
              continue; // Telegraph replaces normal attack
            } else {
              log.push('⚠ ' + en.name + ' is ' + (en.telegraphing.description || 'preparing something!') + ' (' + en.telegraphing.turnsLeft + ' turn' + (en.telegraphing.turnsLeft > 1 ? 's' : '') + ')');
            }
          }

          // ── Start new telegraph? ──
          if (!en.telegraphing) {
            const availTelegraphs = en.enraged && en.enrageTelegraphs ? [...(en.telegraphs || []), ...en.enrageTelegraphs] : (en.telegraphs || []);
            if (availTelegraphs.length > 0) {
              const freq = en.enraged ? (GAME_CONFIG.enrage?.telegraphFrequency || { minTurns: 2, maxTurns: 3 })
                : en.boss ? (GAME_CONFIG.telegraphFrequency?.boss || { minTurns: 3, maxTurns: 4 })
                : en.elite ? (GAME_CONFIG.telegraphFrequency?.elite || { minTurns: 4, maxTurns: 5 })
                : (GAME_CONFIG.telegraphFrequency?.normal || { minTurns: 5, maxTurns: 7 });
              en.nextTelegraphTurn = en.nextTelegraphTurn || (cs.turn + rand(freq.minTurns, freq.maxTurns));
              if (cs.turn >= en.nextTelegraphTurn) {
                const tgSlug = availTelegraphs[rand(0, availTelegraphs.length - 1)];
                const tgDef = telegraphDefs[tgSlug];
                if (tgDef) {
                  en.telegraphing = { slug: tgSlug, name: tgDef.name, description: tgDef.description, icon: tgDef.icon, turnsLeft: tgDef.warmup || 1 };
                  en.nextTelegraphTurn = null;
                  log.push('⚠ ' + (tgDef.icon||'⚠') + ' ' + en.name + ' is ' + tgDef.description + ' (' + en.telegraphing.turnsLeft + ' turn' + (en.telegraphing.turnsLeft > 1 ? 's' : '') + ')');
                }
              }
            }
          }

          const playerPassiveDodge = Math.min(25, calcDodgeChance(effectiveStats.dex) + perkBonuses.dodgeBonus + (rp?.dodgeBonusPct || 0));

          // Enemy abilities
          const enemyAbilities = en.abilities || [];
          for (const abSlug of enemyAbilities) {
            const abDef = ENEMY_ABILITIES[abSlug];
            if (!abDef) continue;
            if (rand(1, 100) > abDef.chance) continue;
            const targetSelf = abDef.target === 'self';
            if (!targetSelf && rand(1, 100) <= playerPassiveDodge) {
              log.push(`You dodge the ${en.name}'s ${abDef.name}!`);
              continue;
            }
            const targetEffects = targetSelf ? en.effects : cs.playerEffects;
            const eff = applyEffect(targetEffects, abDef.effect, abDef.turns || 3, abDef.name);
            if (eff) {
              if (targetSelf) {
                log.push(`${eff.icon} The ${en.name} uses ${abDef.name}!`);
              } else {
                log.push(`${eff.icon} The ${en.name} uses ${abDef.name} on you! (${eff.name} for ${eff.turnsLeft} turns)`);
              }
            }
          }

          // Taunt: redirect attack to taunting ally
          if (cs.tauntTarget && cs.tauntTurns > 0) {
            const tauntAlly = cs.allies.find(a => a.id === cs.tauntTarget && a.hp > 0);
            if (tauntAlly) {
              const rawDmg = Math.floor(enAtk * 1.04) + rand(-1, 3);
              const dmg = Math.max(1, applyDefenseReduction(rawDmg, tauntAlly.defense || 0));
              tauntAlly.hp -= dmg;
              log.push(`🛡 The ${en.name} attacks ${tauntAlly.name} for ${dmg} damage! (taunted)`);
              continue; // skip normal attack
            }
          }

          // Enemy basic attack
          // Vanish: dodge everything
          if (cs.specState.vanishActive) {
            log.push(`🌑 The ${en.name}'s attack passes through your shadow!`);
            continue;
          }
          let dodged = false;
          if (rand(1, 100) <= playerPassiveDodge) {
            dodged = true;
            adjustMomentum(cs, 1);
            log.push(`You dodge the ${en.name}'s attack!`);
          }
          if (!dodged && cs.playerBuffs) {
            const dodgeBuff = cs.playerBuffs.find(b => b.stat === 'dodge');
            if (dodgeBuff && rand(1, 100) <= dodgeBuff.amount) {
              dodged = true;
              adjustMomentum(cs, 1);
              log.push(`You dodge the ${en.name}'s attack!`);
            }
          }
          if (!dodged) {
            let bonusDef = 0;
            if (cs.playerBuffs) {
              for (const b of cs.playerBuffs) {
                if (b.stat === 'defense') bonusDef += b.amount;
              }
            }
            const totalPlayerDef = effectiveStats.defense + bonusDef;
            let rawEnemyDmg = Math.floor(enAtk * 1.04) + rand(-1, 3);
            let enemyDmg = Math.max(2, applyDefenseReduction(rawEnemyDmg, totalPlayerDef));
            const enemyCritChance = calcEnemyCritChance(en.attack);
            const enemyCrit = rand(1, 100) <= enemyCritChance;
            if (enemyCrit) enemyDmg = Math.floor(enemyDmg * 1.5);
            if (cs.defending) enemyDmg = Math.max(1, Math.floor(enemyDmg * 0.5));
            enemyDmg = Math.max(1, Math.floor(enemyDmg * rangerDmgReduction));
            // Spec damage-taken hooks: damageTakenMul, Bulwark (cap at 20% maxHp),
            // tauntReflect, Deathless Rage (survive at 1 HP + 50% dmg 3 turns).
            specCtx.target = null;
            specCtx.attacker = en;
            enemyDmg = SPECS.specDmgTaken(enemyDmg, specCtx);
            // Divine Shield absorbs damage
            if (cs.divineShield > 0) {
              const absorbed = Math.min(cs.divineShield, enemyDmg);
              cs.divineShield -= absorbed;
              enemyDmg -= absorbed;
              if (absorbed > 0) log.push(`🛡 Divine Shield absorbs ${absorbed} damage!${cs.divineShield <= 0 ? ' The shield shatters!' : ''}`);
              if (enemyDmg <= 0) { continue; }
            }
            char.hp -= enemyDmg;
            cs.lastAttackerId = en.id;
            // Momentum loss on taking damage
            adjustMomentum(cs, enemyCrit ? -2 : -1);
            log.push(enemyCrit ? `⚡ Critical! The ${en.name} strikes you for ${enemyDmg}!` : `The ${en.name} attacks you for ${enemyDmg} damage.`);
          }
        }

        // Durability degradation (once per round, not per enemy)
        const eqRows = await q('SELECT * FROM fantasy_equipment WHERE char_id = $1', [char.id]);
        const skipDurabilityLoss = rp?.durabilityReductionPct && rand(1, 100) <= rp.durabilityReductionPct;
        if (eqRows.length > 0 && !skipDurabilityLoss) {
          const degradeRow = eqRows[rand(0, eqRows.length - 1)];
          const newDur = degradeRow.durability - 1;
          if (newDur <= 0) {
            await db.query('DELETE FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [char.id, degradeRow.slot]);
            const brokenItem = getContent().items[degradeRow.item_slug];
            log.push(`💥 Your ${brokenItem?.name || degradeRow.item_slug} broke from wear!`);
            log.push(`🤡 Don't suck — check your gear, noob! Your ${brokenItem?.name || degradeRow.item_slug} broke because you didn't repair it!`);
          } else {
            await db.query('UPDATE fantasy_equipment SET durability=$1 WHERE char_id=$2 AND slot=$3', [newDur, char.id, degradeRow.slot]);
            if (newDur === 10) {
              const wornItem = getContent().items[degradeRow.item_slug];
              log.push(`🚨 WARNING: Your ${wornItem?.name || degradeRow.item_slug} is at 10 durability! Repair it before it breaks!`);
            } else if (newDur <= 5) {
              const wornItem = getContent().items[degradeRow.item_slug];
              log.push(`⚠ Your ${wornItem?.name || degradeRow.item_slug} is nearly broken! (${newDur} durability)`);
            }
          }
        }
      }

      // ── Tick player effects ──
      if (cs.playerEffects.length > 0) {
        const playerHpDelta = tickEffects(cs.playerEffects, 'You', char.hp, char.max_hp, log);
        char.hp += playerHpDelta;
        char.hp = Math.min(char.hp, char.max_hp);
      }

      applyTurnRegenPassives(char, getCombatPassives(equipment, cs.playerTempPassives), log);

      // Racial passive: elf MP regen per turn
      if (rp?.mpRegenFlat && char.hp > 0) {
        const mpGain = Math.min(rp.mpRegenFlat, char.max_mp - char.mp);
        if (mpGain > 0) { char.mp += mpGain; log.push(`✨ ${rp.name} restores ${mpGain} MP.`); }
      }

      // Class bonus: Radiance HP regen (now handled by SPECS.specTurnStart at top of action)

      if (cs.playerTempPassives?.length) {
        for (const passive of cs.playerTempPassives) passive.turnsLeft--;
        cs.playerTempPassives = cs.playerTempPassives.filter(passive => passive.turnsLeft > 0);
      }

      if (cs.playerBuffs) {
        for (const b of cs.playerBuffs) b.turnsLeft--;
        cs.playerBuffs = cs.playerBuffs.filter(b => b.turnsLeft > 0);
      }
      // Tick mark duration on enemies
      for (const en of cs.enemies) {
        if (en.marked) {
          en.markedTurns = (en.markedTurns || 0) - 1;
          if (en.markedTurns <= 0) { en.marked = false; delete en.markedTurns; }
        }
      }

      cs.turn++;
      if (cs.tauntTurns > 0) { cs.tauntTurns--; if (cs.tauntTurns <= 0) cs.tauntTarget = null; }

      // ── Check player death ──
      if (char.hp <= 0 && !fled) {
        const primaryEnemy = cs.enemies[0];
        if (cs.arenaRun && char.arena_state) {
          const as = char.arena_state;
          const totalAp = as.ap || 0;
          char.arena_points = (char.arena_points || 0) + totalAp;
          char.hp = char.max_hp;
          char.mp = char.max_mp;
          log.push(`🏟 Arena run ends at Wave ${as.wave}! Earned ${totalAp} Arena Points.`);
          await db.query('INSERT INTO fantasy_arena_runs (char_id, wave_reached, ap_earned, location_slug, ended_at) VALUES ($1,$2,$3,$4,NOW())',
            [char.id, as.wave, totalAp, as.location]);
          await db.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, arena_state=NULL, arena_points=$1, hp=$2, mp=$3 WHERE id=$4',
            [char.arena_points, char.hp, char.mp, char.id]);
          for (const l of log) await addLog(char.id, 'combat', l);
          // Achievement: arena-best-wave
          if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'arena-best-wave', as.wave);
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state, combatLog: log, combatOver: true, victory: false, arenaDefeat: true, arenaWave: as.wave, arenaAp: totalAp });
        }

        // Raid death — special handling
        if (cs.raidRun && char.raid_state && ctx.handleRaidCombatDeath) {
          await ctx.handleRaidCombatDeath(char, cs, log);
          await db.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, raid_state=NULL, hp=$1, mp=$2, gold=$3, location=$4 WHERE id=$5',
            [char.hp, char.mp, char.gold, char.location, char.id]);
          for (const l of log) await addLog(char.id, 'combat', l);
          await gameEvents.emit('player-died', { charId: char.id, goldLost: Math.floor(char.gold * 0.1), location: char.location, enemySlug: primaryEnemy.slug, enemyName: primaryEnemy.name });
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state, combatLog: log, combatOver: true, victory: false, raidDefeat: true });
        }

        const goldLost = Math.floor(char.gold * 0.1);
        char.hp = char.max_hp;
        char.mp = char.max_mp;
        char.gold = Math.max(0, char.gold - goldLost);
        const respawnLoc = getRespawnLocation(char.location);
        const respawnName = getContent().locations.find(l => l.slug === respawnLoc)?.name || 'town';
        char.location = respawnLoc;
        log.push(`💀 You have been defeated! You lose ${goldLost} gold and wake in ${respawnName}.`);
        if (cs.dungeonRun) log.push('The dungeon resets behind you...');
        await db.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, dungeon_state=NULL, hp=$1, mp=$2, gold=$3, location=$4 WHERE id=$5',
          [char.hp, char.mp, char.gold, char.location, char.id]);
        for (const l of log) await addLog(char.id, 'combat', l);
        await gameEvents.emit('player-died', { charId: char.id, goldLost, location: char.location, enemySlug: primaryEnemy.slug, enemyName: primaryEnemy.name });
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state, combatLog: log, combatOver: true, victory: false });
      }

      // ── Fled ──
      if (fled) {
        const primaryEnemy = cs.enemies[0];
        if (cs.dungeonRun) {
          await db.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, dungeon_state=NULL, hp=$1, mp=$2 WHERE id=$3',
            [char.hp, char.mp, char.id]);
        } else {
          await db.query('UPDATE fantasy_characters SET in_combat=FALSE, combat_state=NULL, hp=$1, mp=$2 WHERE id=$3',
            [char.hp, char.mp, char.id]);
        }
        for (const l of log) await addLog(char.id, 'combat', l);
        await gameEvents.emit('player-fled', { charId: char.id, location: char.location, isDungeon: !!cs.dungeonRun, enemySlug: primaryEnemy.slug });
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state, combatLog: log, combatOver: true, victory: false, fled: true });
      }

      // ── Tick PvE cooldowns ──
      cs.cooldowns = cs.cooldowns || {};
      for (const slug of Object.keys(cs.cooldowns)) {
        cs.cooldowns[slug]--;
        if (cs.cooldowns[slug] <= 0) delete cs.cooldowns[slug];
      }

      // ── Save combat state ──
      cs.log = [...(cs.log || []), ...log];
      await db.query('UPDATE fantasy_characters SET combat_state=$1, hp=$2, mp=$3 WHERE id=$4',
        [JSON.stringify(cs), char.hp, char.mp, char.id]);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
      res.json({ ok: true, patch, combatLog: log, combatOver: false });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Combat action failed.' }); }
  });
}

module.exports = { register };
