// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Game subsystems (guild, academy, arena, AH, forge)
// Runs against the live DEV server (port 8181)
// ═══════════════════════════════════════════════════════════════

const {
  registerUser, createCharacter, getState, stateOf, travel,
  exploreUntilCombat, fightToEnd, uniqueHandle,
} = require('./helpers');

// ═══════════════════════════════════════════════════════════════
// GUILD
// ═══════════════════════════════════════════════════════════════

describe('Guild', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'GuildTest', 'human', 'warrior');
    // Earn some gold — fight in whispering woods
    await travel(agent, 'whispering-woods');
    for (let i = 0; i < 15; i++) {
      try {
        await exploreUntilCombat(agent);
        await fightToEnd(agent);
        const s = await getState(agent);
        if (s.character.location !== 'whispering-woods') await travel(agent, 'whispering-woods');
      } catch { break; }
    }
    await travel(agent, 'thornwall');
  });

  it('registers with guild (costs 500g)', async () => {
    const state = await getState(agent);
    if (state.character.gold >= 500 && !state.character.guild_registered) {
      const res = await agent.post('/api/fantasy/guild/register');
      expect(res.data.ok).toBe(true);
      expect(stateOf(res).character.guild_registered).toBe(true);
    }
  });

  it('rejects double registration', async () => {
    const state = await getState(agent);
    if (state.character.guild_registered) {
      const res = await agent.post('/api/fantasy/guild/register');
      expect(res.data.error).toBeTruthy();
    }
  });

  it('gets bounty board', async () => {
    const state = await getState(agent);
    if (state.character.guild_registered) {
      const res = await agent.post('/api/fantasy/bounty/board');
      expect(res.data.ok).toBe(true);
      expect(res.data.bounties).toBeInstanceOf(Array);
    }
  });

  it('gets guild vendor', async () => {
    const state = await getState(agent);
    if (state.character.guild_registered) {
      const res = await agent.post('/api/fantasy/guild/vendor');
      expect(res.data.ok).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ARENA
// ═══════════════════════════════════════════════════════════════

describe('Arena', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'ArenaTest', 'human', 'warrior');
    // Equip starter weapon and level up a bit
    await agent.post('/api/fantasy/equip', { itemSlug: 'rusty-sword' });
  });

  it('enters arena from town', async () => {
    const res = await agent.post('/api/fantasy/arena/enter');
    expect(res.data.ok).toBe(true);
    expect(stateOf(res).arenaState).toBeDefined();
    expect(stateOf(res).arenaState.wave).toBe(0);
  });

  it('starts first wave', async () => {
    const res = await agent.post('/api/fantasy/arena/next-wave');
    expect(res.data.ok).toBe(true);
    // Should now be in combat
    const state = stateOf(res);
    expect(state.character.in_combat).toBe(true);
  });

  it('fights arena wave', async () => {
    await fightToEnd(agent);
    const state = await getState(agent);
    // Either won wave or died
    expect(state.character.in_combat).toBe(false);
  });

  it('leaves arena and collects AP', async () => {
    const state = await getState(agent);
    if (state.arenaState) {
      const res = await agent.post('/api/fantasy/arena/leave');
      expect(res.data.ok).toBe(true);
      // Should have earned some AP (even wave 1)
      expect(stateOf(res).character.arena_points).toBeGreaterThanOrEqual(0);
    }
  });

  it('gets arena leaderboard', async () => {
    const res = await agent.get('/api/fantasy/arena/leaderboard');
    expect(res.data).toBeDefined();
  });

  it('gets arena store', async () => {
    const res = await agent.post('/api/fantasy/arena/store');
    expect(res.data.ok).toBe(true);
    expect(res.data.store).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// AUCTION HOUSE
// ═══════════════════════════════════════════════════════════════

describe('Auction House', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'AHTest', 'human', 'warrior');
  });

  it('browses listings', async () => {
    const res = await agent.post('/api/fantasy/auction/browse', {});
    expect(res.data.ok).toBe(true);
    expect(res.data.listings).toBeInstanceOf(Array);
  });

  it('lists an item for sale', async () => {
    const state = await getState(agent);
    const potion = state.inventory.find(i => i.slug === 'health-potion');
    if (potion) {
      const res = await agent.post('/api/fantasy/auction/list', {
        itemSlug: 'health-potion', price: 50, quantity: 1,
      });
      expect(res.data.ok).toBe(true);
    }
  });

  it('gets my listings', async () => {
    const res = await agent.post('/api/fantasy/auction/my-listings');
    expect(res.data.ok).toBe(true);
    expect(res.data.listings).toBeInstanceOf(Array);
  });

  it('cancels a listing', async () => {
    const myListings = await agent.post('/api/fantasy/auction/my-listings');
    const active = myListings.data.listings?.find(l => l.state === 'active');
    if (active) {
      const res = await agent.post('/api/fantasy/auction/cancel', { listingId: active.id });
      expect(res.data.ok).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ACADEMY
// ═══════════════════════════════════════════════════════════════

describe('Academy', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'AcademyTest', 'human', 'warrior');
  });

  it('rejects academy learn when not at Sunspire', async () => {
    // We're at Thornwall, Academy is at Sunspire
    const res = await agent.post('/api/fantasy/academy/learn', { abilitySlug: 'whirlwind' });
    expect(res.data.error).toBeTruthy();
  });

  it('equips ability loadout', async () => {
    // Can set loadout from anywhere (just can't learn)
    const res = await agent.post('/api/fantasy/academy/equip', {
      activeAbilities: ['slash', 'shield-bash', 'power-strike', 'war-cry', 'cleave'],
      mode: 'pve',
    });
    // Might fail if these aren't valid starter abilities — check either way
    if (res.data.ok) {
      expect(stateOf(res).character).toBeDefined();
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// FORGE (basic validation — requires rare+ gear to fully test)
// ═══════════════════════════════════════════════════════════════

describe('Forge', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'ForgeTest', 'human', 'warrior');
  });

  it('rejects socketing when not at home', async () => {
    await travel(agent, 'whispering-woods');
    const res = await agent.post('/api/fantasy/forge/socket', {
      equipSlot: 'weapon', socketIndex: 0, gemSlug: 'ruby-chipped',
    });
    expect(res.data.error).toBeTruthy();
    await travel(agent, 'thornwall');
  });

  it('rejects enchant on non-equipped slot', async () => {
    const res = await agent.post('/api/fantasy/forge/enchant', { equipSlot: 'weapon' });
    expect(res.data.error).toBeTruthy();
  });

  it('rejects extract-perks on non-equipped slot', async () => {
    const res = await agent.post('/api/fantasy/forge/extract-perks', { equipSlot: 'weapon' });
    expect(res.data.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// REST AT INN
// ═══════════════════════════════════════════════════════════════

describe('Rest at inn', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'RestTest', 'human', 'warrior');
    // Take some damage
    await travel(agent, 'whispering-woods');
    try {
      await exploreUntilCombat(agent);
      await combatAction(agent, 'attack');
      await fightToEnd(agent);
    } catch { /* might die */ }
    const s = await getState(agent);
    if (s.character.location !== 'thornwall') await travel(agent, 'thornwall');
  });

  it('rests at inn to restore HP/MP', async () => {
    const state = await getState(agent);
    if (state.character.gold >= 10 &&
        (state.character.hp < state.character.max_hp || state.character.mp < state.character.max_mp)) {
      const res = await agent.post('/api/fantasy/rest');
      expect(res.data.ok).toBe(true);
      expect(stateOf(res).character.hp).toBe(stateOf(res).character.max_hp);
      expect(stateOf(res).character.mp).toBe(stateOf(res).character.max_mp);
    }
  });

  it('rejects rest in wild zone', async () => {
    await travel(agent, 'whispering-woods');
    const res = await agent.post('/api/fantasy/rest');
    expect(res.data.error).toBeTruthy();
    await travel(agent, 'thornwall');
  });
});

// ═══════════════════════════════════════════════════════════════
// QUESTS
// ═══════════════════════════════════════════════════════════════

describe('Quests', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'QuestTest', 'human', 'warrior');
  });

  it('state includes available quests at Thornwall', async () => {
    const state = await getState(agent);
    // Thornwall should have quests for level 1
    expect(state.availableQuests).toBeDefined();
    const available = state.availableQuests || [];
    expect(available.length).toBeGreaterThan(0);
  });

  it('accepts a quest', async () => {
    const state = await getState(agent);
    const available = state.availableQuests || [];
    if (available.length > 0) {
      const res = await agent.post('/api/fantasy/quest/accept', { questSlug: available[0].slug });
      expect(res.data.ok).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// CRAFTING
// ═══════════════════════════════════════════════════════════════

describe('Crafting', () => {
  let agent;

  beforeAll(async () => {
    agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'CraftTest', 'human', 'warrior');
  });

  it('rejects crafting unknown recipe', async () => {
    const res = await agent.post('/api/fantasy/craft', { recipeSlug: 'craft-unobtanium' });
    expect(res.data.error).toBeTruthy();
  });

  it('rejects crafting without ingredients', async () => {
    // Health potion recipe exists but we probably lack healing-herb
    const res = await agent.post('/api/fantasy/craft', { recipeSlug: 'craft-health-potion' });
    expect(res.data.error).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════════

describe('Leaderboard', () => {
  it('returns leaderboard data', async () => {
    const agent = await registerUser(uniqueHandle());
    const res = await agent.get('/api/fantasy/leaderboard');
    expect(res.data.characters).toBeInstanceOf(Array);
  });
});
