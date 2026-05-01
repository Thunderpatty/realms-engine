'use strict';
// Unit tests for shared/class-specs.js hook module. Pure functions given
// a context → assert state + return values.
// Run with: npx vitest run tests/class-specs.test.js

const SPECS = require('../shared/class-specs');

function fakeApplyEffect(effectsArray, slug, turns, source) {
  const existing = effectsArray.find(e => e.slug === slug);
  if (existing) { existing.turnsLeft = Math.max(existing.turnsLeft, turns); return existing; }
  const eff = { slug, name: slug, turnsLeft: turns, source };
  effectsArray.push(eff);
  return eff;
}

function seqRand(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

function baseCtx(overrides = {}) {
  const player = overrides.player || { charId: 1, name: 'Hero', hp: 100, maxHp: 100, mp: 50, maxMp: 50, stats: { attack: 20, int: 10, wis: 10, str: 10, dex: 10, cha: 10 }, specState: {}, buffs: [] };
  return {
    player,
    target: overrides.target || null,
    attacker: overrides.attacker || null,
    passive: overrides.passive || {},
    spec: overrides.spec || null,
    specSlug: overrides.specSlug || null,
    specTier: overrides.specTier || 1,
    special: overrides.special || null,
    allEnemies: overrides.allEnemies || [],
    allAllies: overrides.allAllies || [],
    log: [],
    toast: null,
    rand: overrides.rand || (() => 1),
    applyEffect: fakeApplyEffect,
    STATUS_EFFECTS: {},
    state: player.specState,
    combatState: overrides.combatState || null,
    abilityType: overrides.abilityType || null,
  };
}

describe('specCombatStart', () => {
  it('initializes state with defaults', () => {
    const ctx = baseCtx();
    SPECS.specCombatStart(ctx);
    expect(ctx.state.bloodrageActive).toBe(false);
    expect(ctx.state.absoluteZeroUsed).toBe(false);
    expect(ctx.state.combatStartFired).toBe(true);
  });

  it('applies Aegis Sanctum shield to all allies on first fire only', () => {
    const ally1 = { name: 'A', hp: 100, maxHp: 100 };
    const ally2 = { name: 'B', hp: 100, maxHp: 100, divineShield: 5 };
    const ctx = baseCtx({ passive: { aegisSanctum: true }, allAllies: [ally1, ally2] });
    SPECS.specCombatStart(ctx);
    expect(ally1.divineShield).toBe(12); // 12% of 100
    expect(ally2.divineShield).toBe(12); // max of existing 5 and new 12

    // Calling again should not reapply
    ally1.divineShield = 3;
    SPECS.specCombatStart(ctx);
    expect(ally1.divineShield).toBe(3);
  });
});

describe('specDmgDealt', () => {
  it('applies damageMul', () => {
    const ctx = baseCtx({ passive: { damageMul: 1.2 } });
    expect(SPECS.specDmgDealt(100, ctx)).toBe(120);
  });

  it('consumes bloodrage on next hit (double damage)', () => {
    const ctx = baseCtx();
    ctx.state.bloodrageActive = true;
    const dmg = SPECS.specDmgDealt(50, ctx);
    expect(dmg).toBe(100);
    expect(ctx.state.bloodrageActive).toBe(false);
  });

  it('applies frozenVulnerability to slowed targets', () => {
    const ctx = baseCtx({ passive: { frozenVulnerability: 15 }, target: { effects: [{ slug: 'slow' }] } });
    // 100 * 1.15 → 114.99… → floor → 114 (matches inline combat floor semantics)
    expect(SPECS.specDmgDealt(100, ctx)).toBe(114);
  });

  it('applies burnVulnerability to burning targets', () => {
    const ctx = baseCtx({ passive: { burnVulnerability: 20 }, target: { effects: [{ slug: 'burn' }] } });
    expect(SPECS.specDmgDealt(100, ctx)).toBe(120);
  });

  it('envenomDamageBonus boosts damage to poisoned targets', () => {
    const ctx = baseCtx({ passive: { envenomDamageBonus: 25 }, target: { effects: [{ slug: 'poison' }] } });
    expect(SPECS.specDmgDealt(100, ctx)).toBe(125);
  });

  it('deathlessRageTurns grants +50% damage', () => {
    const ctx = baseCtx();
    ctx.state.deathlessRageTurns = 2;
    expect(SPECS.specDmgDealt(100, ctx)).toBe(150);
  });
});

describe('specDmgTaken', () => {
  it('applies damageTakenMul reduction', () => {
    const ctx = baseCtx({ passive: { damageTakenMul: 0.85 } });
    expect(SPECS.specDmgTaken(100, ctx)).toBe(85);
  });

  it('Bulwark caps single hit at 20% maxHp', () => {
    const ctx = baseCtx({ passive: { unbreakable: true } });
    ctx.player.maxHp = 200;
    // 100 damage vs 200 maxHp cap (40) — should cap to 40
    expect(SPECS.specDmgTaken(100, ctx)).toBe(40);
  });

  it('Deathless Rage survives killing blow at 1 HP', () => {
    const ctx = baseCtx({ passive: { deathlessRage: true } });
    ctx.player.hp = 50;
    const dmg = SPECS.specDmgTaken(999, ctx);
    expect(dmg).toBe(49); // 50 - 1 = 49
    expect(ctx.state.deathlessRageUsed).toBe(true);
    expect(ctx.state.deathlessRageTurns).toBe(3);
    // +50% damage for 3 turns is applied via state.deathlessRageTurns in specDmgDealt
  });

  it('Deathless Rage only fires once per combat', () => {
    const ctx = baseCtx({ passive: { deathlessRage: true } });
    ctx.player.hp = 50;
    SPECS.specDmgTaken(999, ctx);
    ctx.player.hp = 30;
    const dmg = SPECS.specDmgTaken(999, ctx);
    expect(dmg).toBe(999); // no longer mitigated
  });

  it('Taunt Reflect damages attacker', () => {
    const attacker = { name: 'Orc', hp: 100 };
    const ctx = baseCtx({ passive: { tauntReflect: 20 }, attacker });
    SPECS.specDmgTaken(50, ctx);
    expect(attacker.hp).toBe(90); // 20% of 50 = 10 reflected
  });
});

describe('specOnKill', () => {
  it('Berserker: kill triggers bloodrageActive', () => {
    const ctx = baseCtx({ specSlug: 'berserker', target: { hp: 0, effects: [] } });
    SPECS.specOnKill(ctx);
    expect(ctx.state.bloodrageActive).toBe(true);
  });

  it('Berserker T2+: also sets bloodrageCritTurns', () => {
    const ctx = baseCtx({ specSlug: 'berserker', passive: { bloodrageCritBonus: 15 }, target: { hp: 0, effects: [] } });
    SPECS.specOnKill(ctx);
    expect(ctx.state.bloodrageCritTurns).toBe(2);
    expect(ctx.state.bloodrageCritBonus).toBe(15);
  });

  it('Inferno spreads remaining burn to other enemies', () => {
    const target = { id: 1, effects: [{ slug: 'burn', damagePerTurn: 5, turnsLeft: 3 }] };
    const other1 = { id: 2, hp: 100, effects: [] };
    const other2 = { id: 3, hp: 100, effects: [] };
    const ctx = baseCtx({ passive: { inferno: true }, target, allEnemies: [target, other1, other2] });
    SPECS.specOnKill(ctx);
    // 5 * 3 = 15 total, split between 2 others = 7 each
    expect(other1.hp).toBe(93);
    expect(other2.hp).toBe(93);
    expect(ctx.state.infernoUsed).toBe(true);
  });

  it('Plague Vector spreads poison to 2 nearest enemies', () => {
    const target = { id: 1, effects: [{ slug: 'poison', damagePerTurn: 4, turnsLeft: 3 }] };
    const other1 = { id: 2, hp: 100, effects: [] };
    const other2 = { id: 3, hp: 100, effects: [] };
    const other3 = { id: 4, hp: 100, effects: [] };
    const ctx = baseCtx({ passive: { plagueVector: true }, target, allEnemies: [target, other1, other2, other3] });
    SPECS.specOnKill(ctx);
    expect(other1.effects.some(e => e.slug === 'poison')).toBe(true);
    expect(other2.effects.some(e => e.slug === 'poison')).toBe(true);
    expect(other3.effects.some(e => e.slug === 'poison')).toBe(false); // only 2
  });
});

describe('specOnHit', () => {
  it('Absolute Zero executes non-boss ≤15% HP', () => {
    const target = { name: 'Goblin', hp: 10, maxHp: 100, effects: [], boss: false };
    const ctx = baseCtx({ passive: { absoluteZero: true }, target });
    SPECS.specOnHit(ctx);
    expect(target.hp).toBe(0);
    expect(ctx.state.absoluteZeroUsed).toBe(true);
  });

  it('Absolute Zero does not fire on boss', () => {
    const target = { name: 'Boss', hp: 10, maxHp: 100, effects: [], boss: true };
    const ctx = baseCtx({ passive: { absoluteZero: true }, target });
    SPECS.specOnHit(ctx);
    expect(target.hp).toBe(10);
  });

  it('Absolute Zero does not re-fire after use', () => {
    const t1 = { name: 'A', hp: 10, maxHp: 100, effects: [], boss: false };
    const t2 = { name: 'B', hp: 10, maxHp: 100, effects: [], boss: false };
    const ctx = baseCtx({ passive: { absoluteZero: true }, target: t1 });
    SPECS.specOnHit(ctx);
    ctx.target = t2;
    SPECS.specOnHit(ctx);
    expect(t1.hp).toBe(0);
    expect(t2.hp).toBe(10); // spared
  });

  it('Wrath of Heaven fires bonus damage every 5th magic cast', () => {
    const target = { name: 'Dummy', hp: 1000, maxHp: 1000, effects: [] };
    const ctx = baseCtx({ passive: { wrathOfHeaven: true }, target, abilityType: 'magic' });
    ctx.player.stats.wis = 20;
    // 5th cast triggers
    for (let i = 0; i < 4; i++) SPECS.specOnHit(ctx);
    expect(target.hp).toBe(1000); // no trigger yet
    SPECS.specOnHit(ctx);
    expect(target.hp).toBe(960); // 20 wis * 2 = 40 bonus dmg
    expect(ctx.state.wrathOfHeavenCount).toBe(0); // counter reset
  });
});

describe('specMpCost', () => {
  it('Arcanistry reduces cost by mpCostReduction percentage', () => {
    const ctx = baseCtx({ passive: { mpCostReduction: 25 } });
    expect(SPECS.specMpCost(10, ctx)).toBe(7); // floor(10 * 0.75)
  });

  it('Arcane Surge makes cast free', () => {
    const ctx = baseCtx();
    ctx.state.arcaneSurgeCharges = 3;
    expect(SPECS.specMpCost(10, ctx)).toBe(0);
    expect(ctx.state.arcaneSurgeCharges).toBe(2);
  });

  it('Overchannel flags first free cast under Arcane Surge for +50% effect', () => {
    const ctx = baseCtx({ passive: { mpCostReduction: 25 } });
    ctx.state.arcaneSurgeCharges = 3;
    SPECS.specMpCost(10, ctx);
    expect(ctx.state.overchannelActive).toBe(true);
  });
});

describe('specTurnStart', () => {
  it('Radiance heals hpRegenPct per turn', () => {
    const ctx = baseCtx({ passive: { hpRegenPct: 5 } });
    ctx.player.hp = 50;
    SPECS.specTurnStart(ctx);
    expect(ctx.player.hp).toBe(55);
  });

  it('Radiance partyRegen heals allies', () => {
    const ally = { name: 'Ally', hp: 50, maxHp: 100 };
    const ctx = baseCtx({ passive: { partyRegen: 3 }, allAllies: [ally] });
    SPECS.specTurnStart(ctx);
    expect(ally.hp).toBe(53); // 3% of 100
  });

  it('ticks bloodrage crit timer down', () => {
    const ctx = baseCtx();
    ctx.state.bloodrageCritTurns = 2;
    ctx.state.bloodrageCritBonus = 15;
    SPECS.specTurnStart(ctx);
    expect(ctx.state.bloodrageCritTurns).toBe(1);
    SPECS.specTurnStart(ctx);
    expect(ctx.state.bloodrageCritTurns).toBe(0);
    expect(ctx.state.bloodrageCritBonus).toBe(0);
  });
});

describe('specClassAbility', () => {
  it('aoe-stun freezes all enemies', () => {
    const e1 = { hp: 100, effects: [] };
    const e2 = { hp: 100, effects: [] };
    const ctx = baseCtx({ allEnemies: [e1, e2], special: { type: 'aoe-stun', name: 'Flash Freeze', turns: 1 } });
    SPECS.specClassAbility(ctx);
    expect(e1.effects.some(e => e.slug === 'stun')).toBe(true);
    expect(e2.effects.some(e => e.slug === 'stun')).toBe(true);
  });

  it('Miracle revives dead ally at 50% HP when available', () => {
    const dead = { name: 'Fallen', hp: 0, maxHp: 100, mp: 0, maxMp: 50 };
    const ctx = baseCtx({
      passive: { miracle: true },
      allAllies: [dead],
      special: { type: 'full-restore', name: 'Divine Restoration' },
    });
    SPECS.specClassAbility(ctx);
    expect(dead.hp).toBe(50);
    expect(ctx.state.miracleUsed).toBe(true);
  });

  it('Miracle heals self if no ally is dead', () => {
    const ctx = baseCtx({ passive: { miracle: true }, special: { type: 'full-restore', name: 'DR' } });
    ctx.player.hp = 10;
    ctx.player.mp = 10;
    SPECS.specClassAbility(ctx);
    expect(ctx.player.hp).toBe(100);
    expect(!!ctx.state.miracleUsed).toBe(false); // miracle flag unused when no dead ally
  });

  it('free-cast sets arcaneSurgeCharges', () => {
    const ctx = baseCtx({ special: { type: 'free-cast', name: 'Arcane Surge', charges: 4 } });
    SPECS.specClassAbility(ctx);
    expect(ctx.state.arcaneSurgeCharges).toBe(4);
  });
});

describe('specEnemyAtkMod', () => {
  it('slowAtkReduction reduces slowed enemy attack', () => {
    const enemy = { attack: 100, effects: [{ slug: 'slow' }] };
    const ctx = baseCtx({ passive: { slowAtkReduction: 15 } });
    expect(SPECS.specEnemyAtkMod(enemy, ctx)).toBe(85);
  });

  it('returns unchanged when no flag active', () => {
    const enemy = { attack: 50, effects: [] };
    const ctx = baseCtx();
    expect(SPECS.specEnemyAtkMod(enemy, ctx)).toBe(50);
  });
});

describe('specDotTickMod', () => {
  it('burnDamageBonus boosts burn tick damage', () => {
    const ctx = baseCtx({ passive: { burnDamageBonus: 50 } });
    expect(SPECS.specDotTickMod(10, 'burn', ctx)).toBe(15);
  });

  it('does not affect non-burn DoTs', () => {
    const ctx = baseCtx({ passive: { burnDamageBonus: 50 } });
    expect(SPECS.specDotTickMod(10, 'poison', ctx)).toBe(10);
  });
});
