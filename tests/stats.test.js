// ═══════════════════════════════════════════════════════════════
// UNIT TESTS — Stat computation, XP curves, combat formulas
// ═══════════════════════════════════════════════════════════════


const {
  RACES, CLASSES, EQUIPMENT_SLOTS,
  computeStats, xpForLevel,
  calcDodgeChance, calcEnemyDodgeChance,
  calcCritChance, calcEnemyCritChance,
  applyDefenseReduction, buildScaledEnemy,
  getEquipmentPassives, getEquipmentPerkBonuses,
  getCombatPassives,
  getRacialPassive, applyRacialDamageBonus, RACIAL_PASSIVES,
} = require('../shared/game-logic');

// ─── Helper: make a character ─────────────────────────────

function makeChar(overrides = {}) {
  return {
    race: 'human',
    class: 'warrior',
    level: 1,
    hp: 40, max_hp: 40,
    mp: 12, max_mp: 12,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════
// GAME CONFIG INTEGRITY
// ═══════════════════════════════════════════════════════════════

describe('Game Config', () => {
  it('has 5 races', () => {
    expect(RACES).toHaveLength(5);
    const slugs = RACES.map(r => r.slug);
    expect(slugs).toContain('human');
    expect(slugs).toContain('elf');
    expect(slugs).toContain('dwarf');
    expect(slugs).toContain('halfling');
    expect(slugs).toContain('orc');
  });

  it('has 5 classes', () => {
    expect(CLASSES).toHaveLength(5);
    const slugs = CLASSES.map(c => c.slug);
    expect(slugs).toContain('warrior');
    expect(slugs).toContain('mage');
    expect(slugs).toContain('rogue');
    expect(slugs).toContain('cleric');
    expect(slugs).toContain('ranger');
  });

  it('every class has a primaryStat', () => {
    for (const cls of CLASSES) {
      expect(cls.primaryStat).toBeDefined();
      expect(['str', 'int', 'dex', 'wis', 'cha', 'con']).toContain(cls.primaryStat);
    }
  });

  it('every class has abilities with at least 5 starters', () => {
    for (const cls of CLASSES) {
      expect(cls.abilities.length).toBeGreaterThanOrEqual(5);
      const starters = cls.abilities.filter(a => a.starter);
      expect(starters.length).toBeGreaterThanOrEqual(5);
    }
  });

  it('has 9 equipment slots', () => {
    expect(EQUIPMENT_SLOTS).toHaveLength(9);
    expect(EQUIPMENT_SLOTS).toContain('weapon');
    expect(EQUIPMENT_SLOTS).toContain('shield');
    expect(EQUIPMENT_SLOTS).toContain('body');
    expect(EQUIPMENT_SLOTS).toContain('helmet');
    expect(EQUIPMENT_SLOTS).toContain('trinket');
  });
});

// ═══════════════════════════════════════════════════════════════
// XP CURVE
// ═══════════════════════════════════════════════════════════════

describe('xpForLevel', () => {
  it('level 1 requires 120 XP', () => {
    expect(xpForLevel(1)).toBe(120);
  });

  it('XP requirement increases with level', () => {
    let prev = xpForLevel(1);
    for (let i = 2; i <= 20; i++) {
      const xp = xpForLevel(i);
      expect(xp).toBeGreaterThan(prev);
      prev = xp;
    }
  });

  it('high levels require significantly more XP', () => {
    expect(xpForLevel(10)).toBeGreaterThan(3000);
    expect(xpForLevel(20)).toBeGreaterThan(10000);
  });
});

// ═══════════════════════════════════════════════════════════════
// COMPUTE STATS — Base stats
// ═══════════════════════════════════════════════════════════════

describe('computeStats — base stats', () => {
  it('level 1 human warrior has base 8 + race bonuses in all stats', () => {
    const char = makeChar();
    const stats = computeStats(char, {});
    // Human: +1 to all 6 stats
    expect(stats.str).toBe(9); // 8 base + 1 race
    expect(stats.con).toBe(9);
    expect(stats.int).toBe(9);
    expect(stats.wis).toBe(9);
    expect(stats.dex).toBe(9);
    expect(stats.cha).toBe(9);
  });

  it('elf has correct racial bonuses', () => {
    const char = makeChar({ race: 'elf' });
    const stats = computeStats(char, {});
    const elf = RACES.find(r => r.slug === 'elf');
    expect(stats.str).toBe(8 + elf.stats.str);
    expect(stats.dex).toBe(8 + elf.stats.dex);
    expect(stats.int).toBe(8 + elf.stats.int);
  });

  it('all 5 races × 5 classes produce valid stats (no NaN, no negative)', () => {
    for (const race of RACES) {
      for (const cls of CLASSES) {
        const char = makeChar({ race: race.slug, class: cls.slug, level: 10 });
        const stats = computeStats(char, {});
        for (const stat of ['str', 'con', 'int', 'wis', 'dex', 'cha', 'attack', 'defense']) {
          expect(stats[stat]).not.toBeNaN();
          expect(stats[stat]).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// COMPUTE STATS — Level scaling
// ═══════════════════════════════════════════════════════════════

describe('computeStats — level scaling', () => {
  it('primary stat grows with level', () => {
    const char1 = makeChar({ level: 1 });
    const char10 = makeChar({ level: 10 });
    const stats1 = computeStats(char1, {});
    const stats10 = computeStats(char10, {});
    // Warrior primary = str
    expect(stats10.str).toBeGreaterThan(stats1.str);
  });

  it('broad growth kicks in at level 6', () => {
    const char5 = makeChar({ level: 5 });
    const char6 = makeChar({ level: 6 });
    const stats5 = computeStats(char5, {});
    const stats6 = computeStats(char6, {});
    // At level 6: broadGrowth = floor(5/5) = 1
    expect(stats6.int).toBeGreaterThan(stats5.int); // non-primary stat also grows
  });

  it('attack scales with level', () => {
    const stats1 = computeStats(makeChar({ level: 1 }), {});
    const stats20 = computeStats(makeChar({ level: 20 }), {});
    expect(stats20.attack).toBeGreaterThan(stats1.attack);
  });

  it('defense scales with level (via con/dex growth)', () => {
    const stats1 = computeStats(makeChar({ level: 1 }), {});
    const stats20 = computeStats(makeChar({ level: 20 }), {});
    expect(stats20.defense).toBeGreaterThan(stats1.defense);
  });
});

// ═══════════════════════════════════════════════════════════════
// COMPUTE STATS — Equipment
// ═══════════════════════════════════════════════════════════════

describe('computeStats — equipment', () => {
  it('weapon attack bonus adds to attack', () => {
    const char = makeChar();
    const noGear = computeStats(char, {});
    const withWeapon = computeStats(char, {
      weapon: { stats: { attack: 10 } },
    });
    expect(withWeapon.attack).toBe(noGear.attack + 10);
  });

  it('armor defense bonus adds to defense', () => {
    const char = makeChar();
    const noGear = computeStats(char, {});
    const withArmor = computeStats(char, {
      body: { stats: { defense: 8 } },
    });
    expect(withArmor.defense).toBe(noGear.defense + 8);
  });

  it('equipment stat bonuses add to character stats', () => {
    const char = makeChar();
    const noGear = computeStats(char, {});
    const withGear = computeStats(char, {
      amulet: { stats: { int: 5, wis: 3 } },
    });
    expect(withGear.int).toBe(noGear.int + 5);
    expect(withGear.wis).toBe(noGear.wis + 3);
  });

  it('perk stat bonuses add to character stats', () => {
    const char = makeChar();
    const noGear = computeStats(char, {});
    const withPerks = computeStats(char, {
      weapon: {
        stats: { attack: 5 },
        perks: [{ type: 'stat', stat: 'str', value: 4 }],
      },
    });
    expect(withPerks.str).toBe(noGear.str + 4);
  });

  it('socket ATK% bonus applies after flat calculation', () => {
    const char = makeChar();
    const flat = computeStats(char, { weapon: { stats: { attack: 20 } } });
    const withGem = computeStats(char, {
      weapon: {
        stats: { attack: 20 },
        sockets: [{ bonus: { attackPct: 10 } }],
      },
    });
    // 10% bonus on top of flat attack
    expect(withGem.attack).toBe(Math.floor(flat.attack * 1.10));
  });

  it('socket DEF% bonus applies after flat calculation', () => {
    const char = makeChar();
    const flat = computeStats(char, { body: { stats: { defense: 15 } } });
    const withGem = computeStats(char, {
      body: {
        stats: { defense: 15 },
        sockets: [{ bonus: { defensePct: 8 } }],
      },
    });
    expect(withGem.defense).toBe(Math.floor(flat.defense * 1.08));
  });

  it('multiple sockets stack', () => {
    const char = makeChar();
    const withGems = computeStats(char, {
      weapon: {
        stats: { attack: 10 },
        sockets: [
          { bonus: { attackPct: 5 } },
          { bonus: { attackPct: 3 } },
        ],
      },
    });
    const flat = computeStats(char, { weapon: { stats: { attack: 10 } } });
    expect(withGems.attack).toBe(Math.floor(flat.attack * 1.08));
  });

  it('null sockets are skipped', () => {
    const char = makeChar();
    const withNulls = computeStats(char, {
      weapon: {
        stats: { attack: 10 },
        sockets: [null, { bonus: { attackPct: 5 } }, null],
      },
    });
    const flat = computeStats(char, { weapon: { stats: { attack: 10 } } });
    expect(withNulls.attack).toBe(Math.floor(flat.attack * 1.05));
  });
});

// ═══════════════════════════════════════════════════════════════
// COMBAT FORMULAS
// ═══════════════════════════════════════════════════════════════

describe('calcDodgeChance', () => {
  it('returns 2 for 0 dex', () => {
    expect(calcDodgeChance(0)).toBe(2);
  });

  it('scales with dex', () => {
    expect(calcDodgeChance(10)).toBeGreaterThan(calcDodgeChance(5));
  });

  it('caps at 18', () => {
    expect(calcDodgeChance(100)).toBe(18);
    expect(calcDodgeChance(999)).toBe(18);
  });
});

describe('calcEnemyDodgeChance', () => {
  it('caps at 12', () => {
    expect(calcEnemyDodgeChance(100)).toBe(12);
  });
});

describe('calcCritChance', () => {
  it('returns 2 for 0 cha', () => {
    expect(calcCritChance(0)).toBe(2);
  });

  it('caps at 18', () => {
    expect(calcCritChance(100)).toBe(18);
  });
});

describe('calcEnemyCritChance', () => {
  it('caps at 10', () => {
    expect(calcEnemyCritChance(100)).toBe(10);
  });
});

describe('applyDefenseReduction', () => {
  it('10 defense gives ~17% reduction', () => {
    const reduced = applyDefenseReduction(100, 10);
    expect(reduced).toBe(83); // 100 * (1 - 10/60) = 83.33 → 83
  });

  it('50 defense gives 50% reduction', () => {
    const reduced = applyDefenseReduction(100, 50);
    expect(reduced).toBe(50);
  });

  it('minimum damage is 1', () => {
    expect(applyDefenseReduction(1, 999)).toBe(1);
  });

  it('0 defense means no reduction', () => {
    expect(applyDefenseReduction(100, 0)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════════
// ENEMY SCALING
// ═══════════════════════════════════════════════════════════════

describe('buildScaledEnemy', () => {
  const baseEnemy = {
    slug: 'dire-wolf', name: 'Dire Wolf', level: 3,
    hp: 30, attack: 10, defense: 5, xp: 25, gold: 12,
    drops: ['wolf-pelt'], abilities: [],
  };

  it('same level = no scaling (stats unchanged)', () => {
    const scaled = buildScaledEnemy(baseEnemy, 3, 3);
    expect(scaled.hp).toBe(30);
    expect(scaled.attack).toBe(10);
    expect(scaled.defense).toBe(5);
  });

  it('no level-gap scaling (stats stay at base)', () => {
    const scaled = buildScaledEnemy(baseEnemy, 20, 3);
    // No inflation — enemy keeps its base stats regardless of player level
    expect(scaled.hp).toBe(30);
    expect(scaled.attack).toBe(10);
    expect(scaled.defense).toBe(5);
  });

  it('initializes combat arrays', () => {
    const scaled = buildScaledEnemy(baseEnemy, 3, 3);
    expect(scaled.buffs).toEqual([]);
    expect(scaled.statusEffects).toEqual([]);
    expect(scaled.stunned).toBe(false);
  });

  it('preserves enemy identity', () => {
    const scaled = buildScaledEnemy(baseEnemy, 10, 3);
    expect(scaled.slug).toBe('dire-wolf');
    expect(scaled.name).toBe('Dire Wolf');
    expect(scaled.drops).toEqual(['wolf-pelt']);
  });
});

// ═══════════════════════════════════════════════════════════════
// EQUIPMENT PASSIVES
// ═══════════════════════════════════════════════════════════════

describe('getEquipmentPassives', () => {
  it('returns empty for no equipment', () => {
    expect(getEquipmentPassives({})).toEqual([]);
    expect(getEquipmentPassives(null)).toEqual([]);
  });

  it('extracts base item passives', () => {
    const eq = {
      weapon: { name: 'Flame Sword', slug: 'flame-sword', slot: 'weapon', passive: { lifestealPct: 5 } },
    };
    const passives = getEquipmentPassives(eq);
    expect(passives).toHaveLength(1);
    expect(passives[0].lifestealPct).toBe(5);
    expect(passives[0].source).toBe('Flame Sword');
  });

  it('extracts lifesteal perk', () => {
    const eq = {
      weapon: { name: 'Sword', slug: 'sword', slot: 'weapon', perks: [{ type: 'lifesteal', value: 8 }] },
    };
    const passives = getEquipmentPassives(eq);
    expect(passives.some(p => p.lifestealPct === 8)).toBe(true);
  });

  it('extracts socket regen passives', () => {
    const eq = {
      body: {
        name: 'Armor', slug: 'armor', slot: 'body',
        sockets: [{ bonus: { hpRegenPct: 3 } }, { bonus: { mpRegenPct: 2 } }],
      },
    };
    const passives = getEquipmentPassives(eq);
    expect(passives.some(p => p.hpRegenPct === 3)).toBe(true);
    expect(passives.some(p => p.mpRegenPct === 2)).toBe(true);
  });

  it('skips null sockets', () => {
    const eq = {
      body: {
        name: 'Armor', slug: 'armor', slot: 'body',
        sockets: [null, { bonus: { hpRegenPct: 3 } }, null],
      },
    };
    const passives = getEquipmentPassives(eq);
    expect(passives).toHaveLength(1);
  });
});

describe('getEquipmentPerkBonuses', () => {
  it('sums crit and dodge from perks and sockets', () => {
    const eq = {
      weapon: {
        perks: [{ type: 'critBonus', value: 3 }],
        sockets: [{ bonus: { critPct: 2 } }],
      },
      boots: {
        perks: [{ type: 'dodgeBonus', value: 4 }],
        sockets: [{ bonus: { dodgePct: 1 } }],
      },
    };
    const { critBonus, dodgeBonus } = getEquipmentPerkBonuses(eq);
    expect(critBonus).toBe(5);
    expect(dodgeBonus).toBe(5);
  });
});

describe('getCombatPassives', () => {
  it('merges equipment passives with temp passives', () => {
    const eq = {
      weapon: { name: 'Sword', slug: 'sword', slot: 'weapon', passive: { lifestealPct: 5 } },
    };
    const temp = [{ source: 'Potion', hpRegen: 10 }];
    const passives = getCombatPassives(eq, temp);
    expect(passives.some(p => p.lifestealPct === 5)).toBe(true);
    expect(passives.some(p => p.hpRegen === 10)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// RACIAL PASSIVES
// ═══════════════════════════════════════════════════════════════

describe('Racial Passives — Config', () => {
  it('every race has a racial passive defined', () => {
    const raceList = ['human', 'elf', 'dwarf', 'halfling', 'orc'];
    for (const race of raceList) {
      const rp = getRacialPassive(race);
      expect(rp).toBeTruthy();
      expect(rp.name).toBeTruthy();
      expect(rp.icon).toBeTruthy();
      expect(rp.description).toBeTruthy();
    }
  });

  it('returns null for unknown race', () => {
    expect(getRacialPassive('goblin')).toBeNull();
  });

  it('RACIAL_PASSIVES has entries for all 5 races', () => {
    expect(Object.keys(RACIAL_PASSIVES)).toHaveLength(5);
  });
});

describe('Racial Passives — Damage Bonus', () => {
  it('orc gets +8% physical damage', () => {
    expect(applyRacialDamageBonus(100, 'orc', 'physical')).toBe(108);
    expect(applyRacialDamageBonus(100, 'orc', 'attack')).toBe(108);
  });

  it('orc gets no bonus on magic damage', () => {
    expect(applyRacialDamageBonus(100, 'orc', 'magic')).toBe(100);
  });

  it('elf gets +8% magic damage', () => {
    expect(applyRacialDamageBonus(100, 'elf', 'magic')).toBe(108);
  });

  it('elf gets no bonus on physical damage', () => {
    expect(applyRacialDamageBonus(100, 'elf', 'physical')).toBe(100);
  });

  it('dwarf gets +5% physical damage', () => {
    expect(applyRacialDamageBonus(100, 'dwarf', 'physical')).toBe(105);
    expect(applyRacialDamageBonus(100, 'dwarf', 'attack')).toBe(105);
  });

  it('human gets no damage bonus', () => {
    expect(applyRacialDamageBonus(100, 'human', 'physical')).toBe(100);
    expect(applyRacialDamageBonus(100, 'human', 'magic')).toBe(100);
  });

  it('halfling gets no damage bonus', () => {
    expect(applyRacialDamageBonus(100, 'halfling', 'physical')).toBe(100);
  });

  it('unknown race returns damage unchanged', () => {
    expect(applyRacialDamageBonus(100, 'goblin', 'physical')).toBe(100);
  });
});

describe('Racial Passives — Defense Bonus in computeStats', () => {
  it('dwarf gets +5% defense from Stoneborn Resilience', () => {
    const dwarfChar = makeChar({ race: 'dwarf' });
    const humanChar = makeChar({ race: 'human' });
    const dwarfStats = computeStats(dwarfChar, {});
    const humanStats = computeStats(humanChar, {});
    // Dwarf should have higher defense due to +5% racial and +CON racial stats
    expect(dwarfStats.defense).toBeGreaterThan(humanStats.defense);
  });

  it('elf and orc do not get defense bonus', () => {
    // Elf and orc have no defensePct
    const elfRp = getRacialPassive('elf');
    const orcRp = getRacialPassive('orc');
    expect(elfRp.defensePct).toBeUndefined();
    expect(orcRp.defensePct).toBeUndefined();
  });
});

describe('Racial Passives — Passive Effects', () => {
  it('human has XP and gold bonuses', () => {
    const rp = getRacialPassive('human');
    expect(rp.xpBonusPct).toBe(5);
    expect(rp.goldBonusPct).toBe(5);
  });

  it('elf has MP regen and dodge bonus', () => {
    const rp = getRacialPassive('elf');
    expect(rp.mpRegenFlat).toBe(2);
    expect(rp.dodgeBonusPct).toBe(3);
  });

  it('halfling has crit, dodge, and gold bonuses', () => {
    const rp = getRacialPassive('halfling');
    expect(rp.critBonusPct).toBe(4);
    expect(rp.dodgeBonusPct).toBe(4);
    expect(rp.goldBonusPct).toBe(10);
  });

  it('orc has lifesteal and crit bonus', () => {
    const rp = getRacialPassive('orc');
    expect(rp.lifestealPct).toBe(3);
    expect(rp.critBonusPct).toBe(2);
  });

  it('dwarf has durability reduction', () => {
    const rp = getRacialPassive('dwarf');
    expect(rp.durabilityReductionPct).toBe(10);
  });
});
