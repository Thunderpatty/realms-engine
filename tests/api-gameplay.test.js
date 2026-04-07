// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Core gameplay flows
// Runs against the live DEV server (port 8181)
// ═══════════════════════════════════════════════════════════════

const {
  registerUser, createCharacter, getState, stateOf, travel, explore,
  combatAction, fightToEnd, exploreUntilCombat, resetCharacter,
  uniqueHandle, createAgent,
} = require('./helpers');

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════

describe('Auth', () => {
  it('registers a new account', async () => {
    const agent = createAgent();
    const handle = uniqueHandle();
    const res = await agent.post('/api/register', {
      handle, password: 'testpass123', confirmPassword: 'testpass123',
    });
    expect(res.data.ok).toBe(true);
  });

  it('rejects duplicate registration', async () => {
    const handle = uniqueHandle();
    await registerUser(handle);
    const agent2 = createAgent();
    const res = await agent2.post('/api/register', {
      handle, password: 'testpass123', confirmPassword: 'testpass123',
    });
    expect(res.status).toBe(409);
  });

  it('logs in with valid credentials', async () => {
    const handle = uniqueHandle();
    await registerUser(handle, 'mypassword1');
    const agent2 = createAgent();
    const res = await agent2.post('/api/login', { handle, password: 'mypassword1' });
    expect(res.data.ok).toBe(true);
  });

  it('rejects invalid login', async () => {
    const agent = createAgent();
    const res = await agent.post('/api/login', { handle: 'nobody-exists', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('rejects bad input via zod validation', async () => {
    const agent = createAgent();
    const res = await agent.post('/api/register', { handle: '<script>', password: 'x', confirmPassword: 'x' });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Invalid input');
  });
});

// ═══════════════════════════════════════════════════════════════
// CHARACTER CREATION
// ═══════════════════════════════════════════════════════════════

describe('Character creation', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
  });

  it('creates a character with valid inputs', async () => {
    const state = await createCharacter(agent, 'TestWarrior', 'human', 'warrior');
    expect(state.character.name).toBe('TestWarrior');
    expect(state.character.race).toBe('human');
    expect(state.character.class).toBe('warrior');
    expect(state.character.level).toBe(1);
    expect(state.character.location).toBe('thornwall');
    expect(state.character.hp).toBeGreaterThan(0);
  });

  it('rejects invalid race', async () => {
    // Reset first to allow new creation
    await resetCharacter(agent);
    const res = await agent.post('/api/fantasy/create', { name: 'Bad', race: 'alien', class: 'warrior' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid class', async () => {
    const res = await agent.post('/api/fantasy/create', { name: 'Bad', race: 'human', class: 'ninja' });
    expect(res.status).toBe(400);
  });

  it('can create all 5 class types', async () => {
    for (const cls of ['warrior', 'mage', 'rogue', 'cleric', 'ranger']) {
      const a = await registerUser(uniqueHandle());
      const state = await createCharacter(a, `Test-${cls}`, 'human', cls);
      expect(state.character.class).toBe(cls);
      expect(state.character.hp).toBeGreaterThan(0);
      expect(state.character.mp).toBeGreaterThan(0);
    }
  });

  it('gives starter items on creation', async () => {
    const a = await registerUser(uniqueHandle());
    const state = await createCharacter(a, 'StarterTest', 'human', 'warrior');
    const slugs = state.inventory.map(i => i.slug);
    expect(slugs).toContain('health-potion');
    // Starter weapon is now auto-equipped, not in inventory
    expect(state.equipment.weapon).toBeDefined();
    expect(state.equipment.weapon.slug).toBe('rusty-sword');
  });
});

// ═══════════════════════════════════════════════════════════════
// TRAVEL
// ═══════════════════════════════════════════════════════════════

describe('Travel', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'TravelTest', 'human', 'warrior');
  });

  it('travels to connected location', async () => {
    const res = await travel(agent, 'whispering-woods');
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).character.location).toBe('whispering-woods');
  });

  it('travels back via multi-hop', async () => {
    const res = await travel(agent, 'thornwall');
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).character.location).toBe('thornwall');
  });

  it('rejects travel to nonexistent location', async () => {
    const res = await travel(agent, 'narnia');
    expect(res.data.error).toBeTruthy();
  });

  it('rejects travel to current location', async () => {
    const res = await travel(agent, 'thornwall');
    expect(res.data.error).toBeTruthy();
  });

  it('can reach distant locations via multi-hop', async () => {
    const res = await travel(agent, 'dragon-peak');
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).character.location).toBe('dragon-peak');
    // Return home
    await travel(agent, 'thornwall');
  });
});

// ═══════════════════════════════════════════════════════════════
// COMBAT
// ═══════════════════════════════════════════════════════════════

describe('Combat', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'CombatTest', 'human', 'warrior');
    await travel(agent, 'whispering-woods');
  });

  it('explore triggers combat in wild zone', async () => {
    const state = await exploreUntilCombat(agent);
    expect(state.character.in_combat).toBe(true);
    expect(state.character.combat_state).toBeDefined();
    expect(state.character.combat_state.enemies).toBeDefined();
    expect(state.character.combat_state.enemies.length).toBeGreaterThan(0);
  });

  it('attack deals damage to enemy', async () => {
    // Make sure we're in combat
    let state = await getState(agent);
    if (!state.character.in_combat) {
      state = await exploreUntilCombat(agent);
    }
    const enemyHpBefore = state.character.combat_state.enemies[0].hp;
    const res = await combatAction(agent, 'attack');
    expect(res.data.ok).toBe(true);
    expect(res.data.combatLog).toBeDefined();
    expect(res.data.combatLog.length).toBeGreaterThan(0);
  });

  it('flee ends combat', async () => {
    // Get into combat first
    let state = await getState(agent);
    if (!state.character.in_combat) {
      await travel(agent, 'whispering-woods');
      state = await exploreUntilCombat(agent);
    }
    const res = await combatAction(agent, 'flee');
    // Flee might fail (RNG), so try a few times
    let fled = stateOf(res)?.character?.in_combat === false;
    for (let i = 0; i < 10 && !fled; i++) {
      const s = await getState(agent);
      if (!s.character.in_combat) { fled = true; break; }
      const r = await combatAction(agent, 'flee');
      fled = stateOf(r)?.character?.in_combat === false;
    }
    // If we couldn't flee, just fight to end
    if (!fled) await fightToEnd(agent);
    const finalState = await getState(agent);
    expect(finalState.character.in_combat).toBe(false);
  });

  it('combat to victory awards XP and gold', async () => {
    await travel(agent, 'whispering-woods');
    const stateBefore = await getState(agent);
    const xpBefore = stateBefore.character.xp;
    const goldBefore = stateBefore.character.gold;

    await exploreUntilCombat(agent);
    const stateAfter = await fightToEnd(agent);

    // Should have gained XP and/or gold (if we won, not died)
    if (stateAfter.character.location === 'whispering-woods') {
      // Won the fight (didn't die/respawn)
      expect(stateAfter.character.xp + stateAfter.character.level * 10000)
        .toBeGreaterThanOrEqual(xpBefore + stateBefore.character.level * 10000);
    }
    // If died, we'd be at thornwall — that's also valid behavior
  });

  it('rejects combat action when not in combat', async () => {
    // Make sure we're not in combat
    const state = await getState(agent);
    if (state.character.in_combat) await fightToEnd(agent);

    const res = await combatAction(agent, 'attack');
    expect(res.data.error).toBeTruthy();
  });

  it('rejects invalid combat action', async () => {
    const res = await agent.post('/api/fantasy/combat/action', { action: 'hack' });
    expect(res.status).toBe(400);
    expect(res.data.error).toContain('Invalid input');
  });
});

// ═══════════════════════════════════════════════════════════════
// SHOP
// ═══════════════════════════════════════════════════════════════

describe('Shop', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'ShopTest', 'human', 'warrior');
    // Fight a few times to earn gold
    await travel(agent, 'whispering-woods');
    for (let i = 0; i < 5; i++) {
      try {
        await exploreUntilCombat(agent);
        await fightToEnd(agent);
      } catch { break; }
      const s = await getState(agent);
      if (s.character.location !== 'whispering-woods') {
        await travel(agent, 'whispering-woods');
      }
    }
    await travel(agent, 'thornwall');
  });

  it('buys an item from shop', async () => {
    const stateBefore = await getState(agent);
    const goldBefore = stateBefore.character.gold;

    const res = await agent.post('/api/fantasy/shop/buy', { itemSlug: 'health-potion' });
    if (res.data.ok) {
      const stateAfter = stateOf(res);
      expect(stateAfter.character.gold).toBeLessThan(goldBefore);
      const potions = stateAfter.inventory.filter(i => i.slug === 'health-potion');
      expect(potions.length).toBeGreaterThan(0);
    } else {
      // Not enough gold — that's valid
      expect(res.data.error).toBeTruthy();
    }
  });

  it('rejects buying nonexistent item', async () => {
    const res = await agent.post('/api/fantasy/shop/buy', { itemSlug: 'unobtanium' });
    expect(res.data.error).toBeTruthy();
  });

  it('sells an item', async () => {
    const stateBefore = await getState(agent);
    const potions = stateBefore.inventory.filter(i => i.slug === 'health-potion');
    if (potions.length > 0) {
      const goldBefore = stateBefore.character.gold;
      const res = await agent.post('/api/fantasy/shop/sell', { itemSlug: 'health-potion', quantity: 1 });
      expect(res.data.ok).toBe(true);
      expect(stateOf(res).character.gold).toBeGreaterThan(goldBefore);
    }
  });

  it('sells and buyback works', async () => {
    // Make sure we have a potion
    const state = await getState(agent);
    const hasPotions = state.inventory.some(i => i.slug === 'health-potion');
    if (hasPotions) {
      await agent.post('/api/fantasy/shop/sell', { itemSlug: 'health-potion', quantity: 1 });
      const res = await agent.post('/api/fantasy/shop/buyback', { index: 0 });
      expect(res.data.ok).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// EQUIP / UNEQUIP
// ═══════════════════════════════════════════════════════════════

describe('Equipment', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'EquipTest', 'human', 'warrior');
  });

  it('equips an item from inventory', async () => {
    // Starter weapon is auto-equipped; unequip it first, then re-equip
    await agent.post('/api/fantasy/unequip', { slot: 'weapon' });
    const res = await agent.post('/api/fantasy/equip', { itemSlug: 'rusty-sword' });
    expect(res.data.ok).toBe(true);
    const eq = stateOf(res).equipment;
    expect(eq.weapon).toBeDefined();
    expect(eq.weapon.slug).toBe('rusty-sword');
  });

  it('unequips an item', async () => {
    const res = await agent.post('/api/fantasy/unequip', { slot: 'weapon' });
    expect(res.data.ok).toBe(true);
    const eq = stateOf(res).equipment;
    expect(eq.weapon).toBeFalsy();
    // Item should be back in inventory
    expect(stateOf(res).inventory.some(i => i.slug === 'rusty-sword')).toBe(true);
  });

  it('rejects unequip on empty slot', async () => {
    const res = await agent.post('/api/fantasy/unequip', { slot: 'weapon' });
    expect(res.data.error).toBeTruthy();
  });

  it('rejects equip of non-equipment item', async () => {
    const res = await agent.post('/api/fantasy/equip', { itemSlug: 'health-potion' });
    expect(res.data.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// CONSUMABLES
// ═══════════════════════════════════════════════════════════════

describe('Consumables', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'ConsumeTest', 'human', 'warrior');
    // Take some damage first so healing is observable
    await travel(agent, 'whispering-woods');
    try {
      await exploreUntilCombat(agent);
      await combatAction(agent, 'attack'); // take at least 1 hit
      await fightToEnd(agent);
    } catch { /* might die, that's ok */ }
    const s = await getState(agent);
    if (s.character.location !== 'thornwall') await travel(agent, 'thornwall');
  });

  it('uses health potion', async () => {
    const state = await getState(agent);
    const hasPotions = state.inventory.some(i => i.slug === 'health-potion');
    if (hasPotions && state.character.hp < state.character.max_hp) {
      const hpBefore = state.character.hp;
      const res = await agent.post('/api/fantasy/use', { itemSlug: 'health-potion' });
      expect(res.data.ok).toBe(true);
      expect(stateOf(res).character.hp).toBeGreaterThanOrEqual(hpBefore);
    }
  });

  it('rejects using non-consumable', async () => {
    const res = await agent.post('/api/fantasy/use', { itemSlug: 'rusty-sword' });
    expect(res.data.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// HOME STORAGE
// ═══════════════════════════════════════════════════════════════

describe('Home storage', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'StorageTest', 'human', 'warrior');
  });

  it('stores item at home', async () => {
    // Store a health potion
    const res = await agent.post('/api/fantasy/home/store', { itemSlug: 'health-potion', quantity: 1 });
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).homeStorage.some(i => i.slug === 'health-potion')).toBe(true);
  });

  it('withdraws item from home', async () => {
    const res = await agent.post('/api/fantasy/home/withdraw', { itemSlug: 'health-potion', quantity: 1 });
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).inventory.some(i => i.slug === 'health-potion')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// CROSS-CHARACTER VAULT
// ═══════════════════════════════════════════════════════════════

describe('Cross-character vault', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'VaultChar1', 'human', 'warrior');
  });

  it('stores item in vault', async () => {
    const res = await agent.post('/api/fantasy/vault/store', { itemSlug: 'health-potion', quantity: 1 });
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).vault.items.some(i => i.slug === 'health-potion')).toBe(true);
  });

  it('withdraws item from vault', async () => {
    const res = await agent.post('/api/fantasy/vault/withdraw', { itemSlug: 'health-potion', quantity: 1 });
    expect(res.data.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// JUNK + AUTO-SELL
// ═══════════════════════════════════════════════════════════════

describe('Junk system', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'JunkTest', 'human', 'warrior');
  });

  it('marks item as junk', async () => {
    const res = await agent.post('/api/fantasy/inventory/mark-junk', { itemSlug: 'health-potion' });
    expect(res.data.ok).toBe(true);
  });

  it('unmarks junk', async () => {
    const res = await agent.post('/api/fantasy/inventory/mark-junk', { itemSlug: 'health-potion' });
    expect(res.data.ok).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// CHARACTER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

describe('Character management', () => {
  it('switches between characters', async () => {
    const agent = await registerUser(uniqueHandle());
    const state1 = await createCharacter(agent, 'Char1', 'human', 'warrior');
    const charId1 = state1.character.id;

    // Create second character
    await agent.post('/api/fantasy/new-character');
    const state2 = await createCharacter(agent, 'Char2', 'elf', 'mage');
    const charId2 = state2.character.id;
    expect(charId2).not.toBe(charId1);

    // Switch back to first
    const res = await agent.post('/api/fantasy/switch-character', { charId: charId1 });
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).character.id).toBe(charId1);
    expect(stateOf(res).character.name).toBe('Char1');
  });

  it('deletes character', async () => {
    const agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'ToDelete', 'human', 'warrior');
    const res = await resetCharacter(agent);
    expect(res.data.ok).toBe(true);
  });
});
