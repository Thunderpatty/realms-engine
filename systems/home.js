// ═══════════════════════════════════════════════════════════════
// HOME — Storage, Vault, Crafting, Upgrades
// Extracted from fantasy-rpg.js (Tier 2A.7)
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, withTransaction, getChar, addLog, addItem, removeItem,
    buildState, buildPatch, getContent, HOME_LOCATION,
    getHomeStorage, addHomeItem, removeHomeItem,
    getKnownRecipes, getRecipeBySlug, isRecipeUnlockedForChar,
    unlockRecipe, consumeCraftingIngredients,
    getHomeStorageCapacity, getHomeStorageUpgradeCost,
    getCompletedQuests,
    getVault, addVaultItem, removeVaultItem, VAULT_CAPACITY,
  } = ctx;

  app.post('/api/fantasy/home/store', requireAuth, validate(schemas.homeStore), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot manage home storage during combat.' });
      if (char.location !== HOME_LOCATION) return res.status(400).json({ error: 'You must be at your home in Thornwall.' });
      const { itemSlug, quantity } = req.body;
      const qty = Math.max(1, Number(quantity) || 1);
      const stack = await q1('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND item_slug=$2', [char.id, itemSlug]);
      if (!stack) return res.status(400).json({ error: "You don't have that item." });
      const moveQty = Math.min(qty, stack.quantity);
      const storageRows = await getHomeStorage(char.id);
      const storageUsed = storageRows.reduce((sum, row) => sum + row.quantity, 0);
      const capacity = getHomeStorageCapacity(char, (await getCompletedQuests(char.id)).length);
      if (storageUsed + moveQty > capacity) return res.status(400).json({ error: `Not enough room in storage. Capacity: ${storageUsed}/${capacity}.` });
      const removed = await removeItem(char.id, itemSlug, moveQty);
      if (!removed) return res.status(400).json({ error: 'Failed to move that item.' });
      await addHomeItem(char.id, itemSlug, moveQty);
      const item = getContent().items[itemSlug];
      const message = `🏠 Stored ${item?.name || itemSlug} ×${moveQty} in your cottage stash.`;
      await addLog(char.id, 'home', message);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch, messages: [message] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to store item.' }); }
  });

  app.post('/api/fantasy/home/withdraw', requireAuth, validate(schemas.homeWithdraw), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot manage home storage during combat.' });
      if (char.location !== HOME_LOCATION) return res.status(400).json({ error: 'You must be at your home in Thornwall.' });
      const { itemSlug, quantity } = req.body;
      const qty = Math.max(1, Number(quantity) || 1);
      const stack = await q1('SELECT * FROM fantasy_home_storage WHERE char_id=$1 AND item_slug=$2', [char.id, itemSlug]);
      if (!stack) return res.status(400).json({ error: 'That item is not in storage.' });
      const moveQty = Math.min(qty, stack.quantity);
      const removed = await removeHomeItem(char.id, itemSlug, moveQty);
      if (!removed) return res.status(400).json({ error: 'Failed to withdraw that item.' });
      await addItem(char.id, itemSlug, moveQty);
      const item = getContent().items[itemSlug];
      const message = `🏠 Retrieved ${item?.name || itemSlug} ×${moveQty} from your cottage stash.`;
      await addLog(char.id, 'home', message);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch, messages: [message] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to withdraw item.' }); }
  });

  // ─── ACCOUNT VAULT ────────

  app.post('/api/fantasy/vault/store', requireAuth, validate(schemas.vaultStore), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot access vault during combat.' });
      const { itemSlug, inventoryId, quantity } = req.body;
      const qty = Math.max(1, Number(quantity) || 1);
      const item = getContent().items[itemSlug];
      if (!item) return res.status(400).json({ error: 'Unknown item.' });

      const vaultRows = await getVault(req.session.userId);
      const vaultUsed = vaultRows.reduce((s, r) => s + r.quantity, 0);
      if (vaultUsed + qty > VAULT_CAPACITY) return res.status(400).json({ error: `Vault is full (${vaultUsed}/${VAULT_CAPACITY}).` });

      const invRow = inventoryId
        ? await q1('SELECT * FROM fantasy_inventory WHERE id=$1 AND char_id=$2 AND item_slug=$3', [inventoryId, char.id, itemSlug])
        : await q1('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND item_slug=$2 AND perks IS NULL', [char.id, itemSlug]);
      if (!invRow || (!inventoryId && invRow.quantity < qty)) return res.status(400).json({ error: "You don't have that item." });
      const perks = invRow.perks ? (typeof invRow.perks === 'string' ? JSON.parse(invRow.perks) : invRow.perks) : null;
      const moveQty = perks ? 1 : Math.min(qty, invRow.quantity);

      await withTransaction(async (tx) => {
        const removed = await removeItem(char.id, itemSlug, moveQty, perks ? invRow.id : null, tx);
        if (!removed) throw new Error('Failed to remove item.');
        await addVaultItem(req.session.userId, itemSlug, moveQty, perks, tx);
        await addLog(char.id, 'home', `📦 Stored ${item.name}${moveQty > 1 ? ' ×' + moveQty : ''} in the account vault.`, tx);
      });

      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch });
    } catch (e) {
      if (e.message.includes('remove')) return res.status(400).json({ error: e.message });
      console.error(e); res.status(500).json({ error: 'Vault store failed.' });
    }
  });

  app.post('/api/fantasy/vault/withdraw', requireAuth, validate(schemas.vaultWithdraw), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot access vault during combat.' });
      const { itemSlug, vaultId, quantity } = req.body;
      const qty = Math.max(1, Number(quantity) || 1);
      const item = getContent().items[itemSlug];
      if (!item) return res.status(400).json({ error: 'Unknown item.' });

      const vaultRow = vaultId
        ? await q1('SELECT * FROM fantasy_account_vault WHERE id=$1 AND user_id=$2', [vaultId, req.session.userId])
        : await q1('SELECT * FROM fantasy_account_vault WHERE user_id=$1 AND item_slug=$2 AND perks IS NULL', [req.session.userId, itemSlug]);
      if (!vaultRow) return res.status(400).json({ error: 'Item not in vault.' });
      const perks = vaultRow.perks ? (typeof vaultRow.perks === 'string' ? JSON.parse(vaultRow.perks) : vaultRow.perks) : null;
      const moveQty = perks ? 1 : Math.min(qty, vaultRow.quantity);

      await withTransaction(async (tx) => {
        const removed = await removeVaultItem(req.session.userId, itemSlug, moveQty, perks ? vaultRow.id : null, tx);
        if (!removed) throw new Error('Failed to remove from vault.');
        await addItem(char.id, itemSlug, moveQty, perks, tx);
        await addLog(char.id, 'home', `📦 Withdrew ${item.name}${moveQty > 1 ? ' ×' + moveQty : ''} from the account vault.`, tx);
      });

      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch });
    } catch (e) {
      if (e.message.includes('remove')) return res.status(400).json({ error: e.message });
      console.error(e); res.status(500).json({ error: 'Vault withdraw failed.' });
    }
  });

  // ─── CRAFTING ─────────────────────────────────────────────────

  app.post('/api/fantasy/craft', requireAuth, validate(schemas.craft), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot craft during combat.' });
      if (!ctx.hasCraftingAccess(char.location)) return res.status(400).json({ error: 'Crafting requires a town with a workshop (any realm hub town).' });
      const { recipeSlug, quantity } = req.body;
      const craftQty = Math.max(1, Number(quantity) || 1);
      const recipe = getRecipeBySlug(recipeSlug);
      if (!recipe) return res.status(400).json({ error: 'Unknown recipe.' });
      const knownRows = await getKnownRecipes(char.id);
      const knownSet = new Set(knownRows.map(row => row.recipe_slug));
      if (!isRecipeUnlockedForChar(recipe, char, knownSet)) {
        if (char.level < (recipe.unlockLevel || 1)) return res.status(400).json({ error: `Reach level ${recipe.unlockLevel || 1} to craft that.` });
        return res.status(400).json({ error: 'You have not discovered that recipe yet.' });
      }
      const scaledIngredients = (recipe.ingredients || []).map(ingredient => ({ ...ingredient, qty: ingredient.qty * craftQty }));

      const message = await withTransaction(async (tx) => {
        const consumed = await consumeCraftingIngredients(char.id, scaledIngredients, tx);
        if (!consumed) throw new Error('You do not have the required materials.');
        await addItem(char.id, recipe.outputItem, (recipe.outputQty || 1) * craftQty, null, tx);
        const output = getContent().items[recipe.outputItem];
        const msg = `🛠 Crafted ${output?.name || recipe.outputItem} ×${(recipe.outputQty || 1) * craftQty}.`;
        await addLog(char.id, 'craft', `${msg} Forged in your Thornwall home.`, tx);
        return msg;
      });

      // Achievement: items-crafted
      if (ctx.checkAndAwardAchievements) {
        if (ctx.recordCodex) await ctx.recordCodex(char.id, 'craft', recipeSlug);
        const totalCrafted = await q1('SELECT COALESCE(SUM(count),0)::int as total FROM fantasy_codex WHERE char_id=$1 AND category=$2', [char.id, 'craft']);
        await ctx.checkAndAwardAchievements(char.id, 'items-crafted', totalCrafted?.total || 0);
      }
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch, messages: [message] });
    } catch (e) {
      if (e.message === 'You do not have the required materials.') return res.status(400).json({ error: e.message });
      console.error(e); res.status(500).json({ error: 'Crafting failed.' });
    }
  });

  app.post('/api/fantasy/home/upgrade', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot upgrade your home during combat.' });
      if (char.location !== HOME_LOCATION) return res.status(400).json({ error: 'You must be at your home in Thornwall.' });
      const cost = getHomeStorageUpgradeCost(char);
      if (char.gold < cost) return res.status(400).json({ error: `Not enough gold. Upgrade costs ${cost}g.` });
      const message = await withTransaction(async (tx) => {
        const r = await tx.query('UPDATE fantasy_characters SET gold = gold - $1, home_storage_bonus = home_storage_bonus + 1 WHERE id = $2 AND gold >= $1 RETURNING gold', [cost, char.id]);
        if (r.rowCount === 0) throw new Error('Not enough gold.');
        const msg = `🏠 Home expanded. Storage capacity increased by 10 slots. (-${cost} gold)`;
        await addLog(char.id, 'home', msg, tx);
        return msg;
      });
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch, messages: [message] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Home upgrade failed.' }); }
  });

  app.post('/api/fantasy/learn-recipe', requireAuth, validate(schemas.learnRecipe), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot study recipes during combat.' });
      const { itemSlug } = req.body;
      const item = getContent().items[itemSlug];
      if (!item || item.type !== 'recipe' || !item.recipeSlug) return res.status(400).json({ error: 'That is not a recipe scroll.' });
      const recipe = getRecipeBySlug(item.recipeSlug);
      if (!recipe) return res.status(400).json({ error: 'That recipe is unknown.' });
      const removed = await removeItem(char.id, itemSlug, 1);
      if (!removed) return res.status(400).json({ error: "You don't have that scroll." });
      const unlocked = await unlockRecipe(char.id, item.recipeSlug, 'scroll');
      if (!unlocked) {
        await addItem(char.id, itemSlug, 1);
        return res.status(400).json({ error: 'You already know that recipe.' });
      }
      const message = `📜 Learned recipe: ${recipe.name}. Return to your crafting bench to forge it.`;
      await addLog(char.id, 'quest', message);
      // Achievement: recipes-learned
      if (ctx.checkAndAwardAchievements) {
        const knownCount = await q1('SELECT COUNT(*)::int as cnt FROM fantasy_known_recipes WHERE char_id=$1', [char.id]);
        await ctx.checkAndAwardAchievements(char.id, 'recipes-learned', knownCount?.cnt || 0);
      }
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ["character", "inventory", "home", "log"]);
      res.json({ ok: true, patch, messages: [message] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to learn recipe.' }); }
  });
}

module.exports = { register };
