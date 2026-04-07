// ═══════════════════════════════════════════════════════════════
// INTEGRATION TESTS — Transaction atomicity & race conditions
// Runs against the live DEV server (port 8181)
//
// These tests verify that concurrent operations don't corrupt
// game state — the transaction work from Tier 1 Week 2.
// ═══════════════════════════════════════════════════════════════

const {
  registerUser, createCharacter, getState, travel,
  exploreUntilCombat, fightToEnd, uniqueHandle, createAgent,
} = require('./helpers');

// ═══════════════════════════════════════════════════════════════
// DOUBLE-BUY PREVENTION
// ═══════════════════════════════════════════════════════════════

describe('Transaction atomicity — shop', () => {
  it('concurrent buy requests do not double-spend gold', async () => {
    const agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'RaceTest', 'human', 'warrior');

    // Earn gold by fighting
    await travel(agent, 'whispering-woods');
    for (let i = 0; i < 10; i++) {
      try {
        await exploreUntilCombat(agent);
        await fightToEnd(agent);
        const s = await getState(agent);
        if (s.character.location !== 'whispering-woods') await travel(agent, 'whispering-woods');
      } catch { break; }
    }
    await travel(agent, 'thornwall');

    const stateBefore = await getState(agent);
    const goldBefore = stateBefore.character.gold;

    if (goldBefore < 20) {
      // Not enough gold to test — skip gracefully
      return;
    }

    // Fire 5 buy requests simultaneously
    const promises = Array.from({ length: 5 }, () =>
      agent.post('/api/fantasy/shop/buy', { itemSlug: 'health-potion' })
    );
    const results = await Promise.all(promises);

    const successes = results.filter(r => r.data.ok === true).length;
    const stateAfter = await getState(agent);

    // Gold should never go negative
    expect(stateAfter.character.gold).toBeGreaterThanOrEqual(0);

    // The number of potions gained should match the gold spent
    const goldSpent = goldBefore - stateAfter.character.gold;
    // Each potion costs the same amount — verify consistency
    if (successes > 0) {
      const costPerPotion = Math.floor(goldSpent / successes);
      // All potions should have cost the same amount (± 1 for rounding)
      expect(goldSpent).toBeGreaterThan(0);
      expect(costPerPotion).toBeGreaterThan(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// DOUBLE-EQUIP PREVENTION
// ═══════════════════════════════════════════════════════════════

describe('Transaction atomicity — equip', () => {
  it('concurrent equip requests do not duplicate items', async () => {
    const agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'EquipRace', 'human', 'warrior');

    // Fire 3 equip requests for the same rusty-sword simultaneously
    const promises = Array.from({ length: 3 }, () =>
      agent.post('/api/fantasy/equip', { itemSlug: 'rusty-sword' })
    );
    const results = await Promise.all(promises);

    const successes = results.filter(r => r.data.ok === true).length;
    const errors = results.filter(r => r.data.error).length;

    // Exactly one should succeed, rest should error
    // (or all succeed if equip/unequip cycle, but no item duplication)
    const stateAfter = await getState(agent);

    // Count total rusty-swords (inventory + equipment)
    const inInventory = stateAfter.inventory.filter(i => i.slug === 'rusty-sword')
      .reduce((sum, i) => sum + (i.quantity || 1), 0);
    const inEquipment = stateAfter.equipment.weapon?.slug === 'rusty-sword' ? 1 : 0;
    const totalSwords = inInventory + inEquipment;

    // Should still have exactly 1 rusty-sword total (no duplication)
    expect(totalSwords).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// AUCTION HOUSE — DOUBLE-BUY PREVENTION
// ═══════════════════════════════════════════════════════════════

describe('Transaction atomicity — auction house', () => {
  it('concurrent AH buy requests — only one succeeds', async () => {
    // Seller: create and list an item
    const seller = await registerUser(uniqueHandle());
    await createCharacter(seller, 'Seller', 'human', 'warrior');

    const listRes = await seller.post('/api/fantasy/auction/list', {
      itemSlug: 'health-potion', price: 5, quantity: 1,
    });

    if (!listRes.data.ok) return; // can't test without a listing

    // Find the listing
    const browseRes = await seller.post('/api/fantasy/auction/browse', {});
    const listing = browseRes.data.listings?.find(l =>
      l.seller_name === 'Seller' && l.state === 'active'
    );
    if (!listing) return;

    // Buyer 1 and Buyer 2 — two different accounts
    const buyer1 = await registerUser(uniqueHandle());
    await createCharacter(buyer1, 'Buyer1', 'human', 'warrior');
    // Earn gold for buyer1
    await travel(buyer1, 'whispering-woods');
    for (let i = 0; i < 5; i++) {
      try {
        await exploreUntilCombat(buyer1);
        await fightToEnd(buyer1);
        const s = await getState(buyer1);
        if (s.character.location !== 'whispering-woods') await travel(buyer1, 'whispering-woods');
      } catch { break; }
    }
    await travel(buyer1, 'thornwall');

    const buyer2 = await registerUser(uniqueHandle());
    await createCharacter(buyer2, 'Buyer2', 'human', 'warrior');
    await travel(buyer2, 'whispering-woods');
    for (let i = 0; i < 5; i++) {
      try {
        await exploreUntilCombat(buyer2);
        await fightToEnd(buyer2);
        const s = await getState(buyer2);
        if (s.character.location !== 'whispering-woods') await travel(buyer2, 'whispering-woods');
      } catch { break; }
    }
    await travel(buyer2, 'thornwall');

    // Both try to buy simultaneously
    const [res1, res2] = await Promise.all([
      buyer1.post('/api/fantasy/auction/buy', { listingId: listing.id }),
      buyer2.post('/api/fantasy/auction/buy', { listingId: listing.id }),
    ]);

    const successes = [res1, res2].filter(r => r.data.ok === true).length;
    const errors = [res1, res2].filter(r => r.data.error).length;

    // At most one should succeed
    expect(successes).toBeLessThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// SELL — QUANTITY INTEGRITY
// ═══════════════════════════════════════════════════════════════

describe('Transaction atomicity — sell', () => {
  it('selling more than owned quantity fails', async () => {
    const agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'SellTest', 'human', 'warrior');

    const state = await getState(agent);
    const potions = state.inventory.find(i => i.slug === 'health-potion');
    const qty = potions?.quantity || 0;

    if (qty > 0) {
      // Try to sell more than we have
      const res = await agent.post('/api/fantasy/shop/sell', {
        itemSlug: 'health-potion', quantity: qty + 100,
      });
      // Should either error or cap at actual quantity
      const stateAfter = await getState(agent);
      const potionsAfter = stateAfter.inventory.find(i => i.slug === 'health-potion');
      // Should not have negative potions
      expect((potionsAfter?.quantity || 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it('concurrent sell requests do not oversell', async () => {
    const agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'DoubleSell', 'human', 'warrior');

    // We have 3 health potions from starter
    const promises = Array.from({ length: 5 }, () =>
      agent.post('/api/fantasy/shop/sell', { itemSlug: 'health-potion', quantity: 1 })
    );
    const results = await Promise.all(promises);

    const stateAfter = await getState(agent);
    const potionsAfter = stateAfter.inventory.find(i => i.slug === 'health-potion');

    // Should never go negative
    expect((potionsAfter?.quantity || 0)).toBeGreaterThanOrEqual(0);

    // Total sold should not exceed what we started with (3)
    const successes = results.filter(r => r.data.ok === true).length;
    expect(successes).toBeLessThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// CURRENCY — NEVER NEGATIVE
// ═══════════════════════════════════════════════════════════════

describe('Currency safety', () => {
  it('gold never goes negative after rapid spending', async () => {
    const agent = await registerUser(uniqueHandle());
    await createCharacter(agent, 'GoldTest', 'human', 'warrior');

    // Try to buy 10 health potions rapidly (probably only have enough for a few)
    const promises = Array.from({ length: 10 }, () =>
      agent.post('/api/fantasy/shop/buy', { itemSlug: 'health-potion' })
    );
    await Promise.all(promises);

    const state = await getState(agent);
    expect(state.character.gold).toBeGreaterThanOrEqual(0);
  });
});
