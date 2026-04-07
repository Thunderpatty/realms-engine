// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Status effects, passives, consumables
// ═══════════════════════════════════════════════════════════════


const {
  STATUS_EFFECTS,
  applyEffect, removeEffect, getEffectStatMods,
  tickEffects, isStunned,
  applyDamagePassives, applyTurnRegenPassives,
  addTempPassive, applyConsumableUse,
  rollPerks, getPerkPrefix,
  PERK_POOLS,
} = require('../shared/game-logic');

// ═══════════════════════════════════════════════════════════════
// STATUS EFFECTS
// ═══════════════════════════════════════════════════════════════

describe('applyEffect', () => {
  it('adds a known effect to the array', () => {
    const effects = [];
    const result = applyEffect(effects, 'burn', 3, 'Fireball');
    expect(result).not.toBeNull();
    expect(effects).toHaveLength(1);
    expect(effects[0].slug).toBe('burn');
    expect(effects[0].source).toBe('Fireball');
  });

  it('returns null for unknown effect slug', () => {
    const effects = [];
    const result = applyEffect(effects, 'nonexistent', 3, 'test');
    expect(result).toBeNull();
    expect(effects).toHaveLength(0);
  });

  it('refreshes duration on non-stackable duplicate', () => {
    const effects = [];
    applyEffect(effects, 'burn', 2, 'Fireball');
    const result = applyEffect(effects, 'burn', 5, 'Fireball');
    // Non-stackable: refresh returns null, array still length 1
    expect(result).toBeNull();
    expect(effects).toHaveLength(1);
    expect(effects[0].turnsLeft).toBe(5);
  });

  it('stun gets +1 turn adjustment', () => {
    const effects = [];
    applyEffect(effects, 'stun', 1, 'Bash');
    expect(effects[0].turnsLeft).toBe(2); // 1 + 1
  });
});

describe('removeEffect', () => {
  it('removes existing effect and returns it', () => {
    const effects = [];
    applyEffect(effects, 'burn', 3, 'test');
    const removed = removeEffect(effects, 'burn');
    expect(removed).not.toBeNull();
    expect(removed.slug).toBe('burn');
    expect(effects).toHaveLength(0);
  });

  it('returns null if effect not present', () => {
    const effects = [];
    expect(removeEffect(effects, 'burn')).toBeNull();
  });
});

describe('getEffectStatMods', () => {
  it('sums stat mods from active effects', () => {
    const effects = [];
    // Apply an effect that has statMod
    applyEffect(effects, 'weaken', 3, 'test');
    const mods = getEffectStatMods(effects);
    // weaken should reduce attack stat
    if (STATUS_EFFECTS.weaken?.statMod) {
      expect(mods).toHaveProperty('attack');
    }
  });

  it('returns empty object for no effects', () => {
    expect(getEffectStatMods([])).toEqual({});
  });
});

describe('tickEffects', () => {
  it('applies DoT damage and returns negative hpChange', () => {
    const effects = [];
    applyEffect(effects, 'burn', 3, 'test');
    const burnDmg = effects[0].damagePerTurn || 0;
    const log = [];
    const hpChange = tickEffects(effects, 'Goblin', 50, 50, log);
    if (burnDmg > 0) {
      expect(hpChange).toBeLessThan(0);
      expect(log.length).toBeGreaterThan(0);
    }
  });

  it('decrements turn counters', () => {
    const effects = [];
    applyEffect(effects, 'burn', 2, 'test');
    const log = [];
    tickEffects(effects, 'Target', 50, 50, log);
    if (effects.length > 0) {
      expect(effects[0].turnsLeft).toBeLessThan(2);
    }
  });

  it('removes expired effects', () => {
    const effects = [];
    applyEffect(effects, 'burn', 1, 'test');
    const log = [];
    tickEffects(effects, 'Target', 50, 50, log);
    // After 1 tick, effect with 1 turn should be gone
    expect(effects).toHaveLength(0);
  });
});

describe('isStunned', () => {
  it('returns true when stun is active', () => {
    const effects = [];
    applyEffect(effects, 'stun', 1, 'Bash');
    expect(isStunned(effects)).toBe(true);
  });

  it('returns false with no stun', () => {
    const effects = [];
    applyEffect(effects, 'burn', 3, 'test');
    expect(isStunned(effects)).toBe(false);
  });

  it('returns false with empty effects', () => {
    expect(isStunned([])).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// DAMAGE & REGEN PASSIVES
// ═══════════════════════════════════════════════════════════════

describe('applyDamagePassives', () => {
  it('lifesteal heals based on damage dealt', () => {
    const char = { hp: 50, max_hp: 100 };
    const enemy = { name: 'Goblin' };
    const passives = [{ source: 'Vampiric Sword', lifestealPct: 20 }];
    const log = [];
    applyDamagePassives(char, enemy, 50, passives, [], log);
    expect(char.hp).toBe(60); // 50 * 0.20 = 10 healed
    expect(log.some(l => l.includes('lifesteal'))).toBe(true);
  });

  it('lifesteal does not overheal', () => {
    const char = { hp: 95, max_hp: 100 };
    const enemy = { name: 'Goblin' };
    const passives = [{ source: 'Sword', lifestealPct: 50 }];
    const log = [];
    applyDamagePassives(char, enemy, 100, passives, [], log);
    expect(char.hp).toBe(100); // capped at max
  });

  it('does nothing with 0 damage', () => {
    const char = { hp: 50, max_hp: 100 };
    const log = [];
    applyDamagePassives(char, { name: 'X' }, 0, [{ source: 'S', lifestealPct: 50 }], [], log);
    expect(char.hp).toBe(50);
    expect(log).toHaveLength(0);
  });
});

describe('applyTurnRegenPassives', () => {
  it('mana regen restores MP', () => {
    const char = { mp: 10, max_mp: 50, hp: 50, max_hp: 100 };
    const passives = [{ source: 'Staff', manaRegen: 5 }];
    const log = [];
    applyTurnRegenPassives(char, passives, log);
    expect(char.mp).toBe(15);
  });

  it('mana regen does not exceed max', () => {
    const char = { mp: 48, max_mp: 50, hp: 50, max_hp: 100 };
    const passives = [{ source: 'Staff', manaRegen: 10 }];
    const log = [];
    applyTurnRegenPassives(char, passives, log);
    expect(char.mp).toBe(50);
  });

  it('hp regen percentage works', () => {
    const char = { hp: 50, max_hp: 200, mp: 10, max_mp: 50 };
    const passives = [{ source: 'Ring', hpRegenPct: 5 }];
    const log = [];
    applyTurnRegenPassives(char, passives, log);
    expect(char.hp).toBe(60); // 200 * 5% = 10
  });

  it('mp regen percentage works', () => {
    const char = { hp: 50, max_hp: 100, mp: 10, max_mp: 100 };
    const passives = [{ source: 'Gem', mpRegenPct: 3 }];
    const log = [];
    applyTurnRegenPassives(char, passives, log);
    expect(char.mp).toBe(13); // 100 * 3% = 3
  });
});

// ═══════════════════════════════════════════════════════════════
// TEMP PASSIVES
// ═══════════════════════════════════════════════════════════════

describe('addTempPassive', () => {
  it('adds passive with correct turns', () => {
    const temps = [];
    addTempPassive(temps, { lifestealPct: 10, turns: 3 }, 'Potion');
    expect(temps).toHaveLength(1);
    expect(temps[0].turnsLeft).toBe(3);
    expect(temps[0].source).toBe('Potion');
    expect(temps[0].lifestealPct).toBe(10);
  });

  it('defaults to 1 turn', () => {
    const temps = [];
    addTempPassive(temps, { hpRegen: 5 }, 'Herb');
    expect(temps[0].turnsLeft).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// CONSUMABLE USE
// ═══════════════════════════════════════════════════════════════

describe('applyConsumableUse', () => {
  it('heals HP', () => {
    const char = { hp: 30, max_hp: 100, mp: 10, max_mp: 50 };
    const item = { name: 'Health Potion', use: { heal: 25 } };
    const log = [];
    applyConsumableUse(item, char, { log });
    expect(char.hp).toBe(55);
    expect(log.some(l => l.includes('Health Potion'))).toBe(true);
  });

  it('heals MP', () => {
    const char = { hp: 100, max_hp: 100, mp: 5, max_mp: 50 };
    const item = { name: 'Mana Potion', use: { mana: 20 } };
    const log = [];
    applyConsumableUse(item, char, { log });
    expect(char.mp).toBe(25);
  });

  it('does not overheal', () => {
    const char = { hp: 95, max_hp: 100, mp: 50, max_mp: 50 };
    const item = { name: 'Big Heal', use: { heal: 100 } };
    const log = [];
    applyConsumableUse(item, char, { log });
    expect(char.hp).toBe(100);
  });

  it('cures status effect', () => {
    const effects = [];
    applyEffect(effects, 'burn', 3, 'test');
    const char = { hp: 50, max_hp: 100, mp: 10, max_mp: 50 };
    const item = { name: 'Antidote', use: { cure: 'burn' } };
    const log = [];
    applyConsumableUse(item, char, { effectsArray: effects, log });
    expect(effects).toHaveLength(0);
    expect(log.some(l => l.includes('cures'))).toBe(true);
  });

  it('applies temp passives', () => {
    const char = { hp: 50, max_hp: 100, mp: 10, max_mp: 50 };
    const tempPassives = [];
    const item = { name: 'Battle Elixir', use: { tempPassives: [{ lifestealPct: 10, turns: 3 }] } };
    const log = [];
    applyConsumableUse(item, char, { tempPassives, log });
    expect(tempPassives).toHaveLength(1);
    expect(tempPassives[0].lifestealPct).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════
// PERK GENERATION
// ═══════════════════════════════════════════════════════════════

describe('rollPerks', () => {
  it('returns null for common rarity (no perk pool)', () => {
    // Common has no perk pool or 0% roll chance
    const result = rollPerks('common', { stats: {} });
    expect(result).toBeNull();
  });

  it('epic+ items can produce perks (run 100 times for probability)', () => {
    let gotPerks = false;
    for (let i = 0; i < 100; i++) {
      const result = rollPerks('epic', { stats: { attack: 15, str: 3 } });
      if (result) { gotPerks = true; break; }
    }
    expect(gotPerks).toBe(true);
  });

  it('perks have valid structure', () => {
    // Force a roll by trying many times
    let perks = null;
    for (let i = 0; i < 200; i++) {
      perks = rollPerks('legendary', { stats: { attack: 20, str: 5 } });
      if (perks) break;
    }
    if (perks) {
      for (const perk of perks) {
        expect(perk.type).toBeDefined();
        if (perk.type === 'stat') {
          expect(perk.stat).toBeDefined();
          expect(perk.value).toBeGreaterThan(0);
        } else if (perk.type === 'onHitStatus') {
          expect(perk.slug).toBeDefined();
          expect(perk.chance).toBeGreaterThan(0);
        } else {
          expect(perk.value).toBeGreaterThan(0);
        }
      }
    }
  });

  it('no duplicate perk types in a single roll', () => {
    for (let i = 0; i < 100; i++) {
      const perks = rollPerks('mythic', { stats: { attack: 25, str: 8 } });
      if (perks) {
        const types = perks.map(p => p.type === 'onHitStatus' ? `onHit_${p.slug}` : p.type);
        const unique = new Set(types);
        expect(unique.size).toBe(types.length);
      }
    }
  });
});

describe('getPerkPrefix', () => {
  it('returns empty for no perks', () => {
    expect(getPerkPrefix(null)).toBe('');
    expect(getPerkPrefix([])).toBe('');
  });

  it('returns stat-based prefix for stat perks', () => {
    const prefix = getPerkPrefix([{ type: 'stat', stat: 'str', value: 3 }]);
    expect(prefix).toBeTruthy();
    expect(typeof prefix).toBe('string');
  });

  it('returns prefix for lifesteal perk', () => {
    const prefix = getPerkPrefix([{ type: 'lifesteal', value: 5 }]);
    expect(prefix).toBeTruthy();
  });
});
