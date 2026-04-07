// ═══════════════════════════════════════════════════════════════
// FORGE — Socketing gems & Enchanting equipment
// All operations wrapped in transactions for atomicity.
// ═══════════════════════════════════════════════════════════════

const GAME_CONFIG = require('../shared/game-config');
// Forge available at any realm hub town (via ctx.hasCraftingAccess)
const SOCKET_SLOTS = GAME_CONFIG.socketSlots || {};
const ENCHANT_COSTS = GAME_CONFIG.enchantCosts || {};
const EXTRACT_PERK_COSTS = GAME_CONFIG.extractPerkCosts || {};
const EXTRACT_GEM_COSTS = GAME_CONFIG.extractGemCosts || {};
const COMMON_MATS = GAME_CONFIG.commonMaterials || [];
const RARE_MATS = GAME_CONFIG.rareMaterials || [];
const { validate, schemas } = require('../validation');

function register(app, requireAuth, ctx) {
  const { db, q, q1, withTransaction, getChar, addLog, buildState, getContent, addItem, removeItem, removeHomeItem, rollPerks, getPerkPrefix, rand, EQUIPMENT_SLOTS } = ctx;

  async function getEquipRow(charId, slot, txClient = null) {
    return q1('SELECT * FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [charId, slot], txClient);
  }

  function initSockets(rarity) {
    const count = SOCKET_SLOTS[rarity] || 0;
    if (count === 0) return null;
    return new Array(count).fill(null);
  }

  // ─── SOCKET GEM ───
  app.post('/api/fantasy/forge/socket', requireAuth, validate(schemas.forgeSocket), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!ctx.hasCraftingAccess(char.location)) return res.status(400).json({ error: 'The Forge requires a town with a workshop (any realm hub town).' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot use forge during combat.' });

      const { equipSlot, socketIndex, gemSlug } = req.body;
      if (!EQUIPMENT_SLOTS.includes(equipSlot)) return res.status(400).json({ error: 'Invalid equipment slot.' });

      const eqRow = await getEquipRow(char.id, equipSlot);
      if (!eqRow) return res.status(400).json({ error: 'Nothing equipped in that slot.' });

      const baseItem = getContent().items[eqRow.item_slug] || {};
      const maxSockets = SOCKET_SLOTS[baseItem.rarity] || 0;
      if (maxSockets === 0) return res.status(400).json({ error: 'This item cannot be socketed.' });

      let sockets = eqRow.sockets ? (typeof eqRow.sockets === 'string' ? JSON.parse(eqRow.sockets) : eqRow.sockets) : initSockets(baseItem.rarity);
      if (!sockets) sockets = initSockets(baseItem.rarity);

      if (socketIndex < 0 || socketIndex >= sockets.length) return res.status(400).json({ error: 'Invalid socket slot.' });
      if (sockets[socketIndex]) return res.status(400).json({ error: 'Socket already occupied. Extract the gem first.' });

      const gemItem = getContent().items[gemSlug];
      if (!gemItem || gemItem.type !== 'gem' || !gemItem.gem) return res.status(400).json({ error: 'Invalid gem.' });

      await withTransaction(async (tx) => {
        const removed = await removeItem(char.id, gemSlug, 1, null, tx);
        if (!removed) throw new Error("You don't have that gem.");
        sockets[socketIndex] = { gemSlug, bonus: gemItem.gem.bonus, name: gemItem.name, tier: gemItem.gem.tier };
        await tx.query('UPDATE fantasy_equipment SET sockets=$1 WHERE char_id=$2 AND slot=$3', [JSON.stringify(sockets), char.id, equipSlot]);
        await addLog(char.id, 'shop', `💎 Socketed ${gemItem.name} into ${baseItem.name || equipSlot}.`, tx);
      });

      // Achievement: gems-socketed
      if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'gems-socketed', 1);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) {
      if (e.message.includes("don't have")) return res.status(400).json({ error: e.message });
      console.error(e); res.status(500).json({ error: 'Socket failed.' });
    }
  });

  // ─── EXTRACT GEM ───
  app.post('/api/fantasy/forge/extract-gem', requireAuth, validate(schemas.forgeExtractGem), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!ctx.hasCraftingAccess(char.location)) return res.status(400).json({ error: 'The Forge requires a town with a workshop.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot use forge during combat.' });

      const { equipSlot, socketIndex } = req.body;
      const eqRow = await getEquipRow(char.id, equipSlot);
      if (!eqRow) return res.status(400).json({ error: 'Nothing equipped in that slot.' });

      let sockets = eqRow.sockets ? (typeof eqRow.sockets === 'string' ? JSON.parse(eqRow.sockets) : eqRow.sockets) : null;
      if (!sockets || socketIndex < 0 || socketIndex >= sockets.length) return res.status(400).json({ error: 'Invalid socket.' });
      const sock = sockets[socketIndex];
      if (!sock) return res.status(400).json({ error: 'Socket is empty.' });

      const cost = EXTRACT_GEM_COSTS[sock.tier] || 50;
      if (char.gold < cost) return res.status(400).json({ error: `Not enough gold (need ${cost}g).` });

      await withTransaction(async (tx) => {
        await tx.query('UPDATE fantasy_characters SET gold=gold-$1 WHERE id=$2 AND gold>=$1', [cost, char.id]);
        await addItem(char.id, sock.gemSlug, 1, null, tx);
        sockets[socketIndex] = null;
        await tx.query('UPDATE fantasy_equipment SET sockets=$1 WHERE char_id=$2 AND slot=$3', [JSON.stringify(sockets), char.id, equipSlot]);
        const gemItem = getContent().items[sock.gemSlug];
        await addLog(char.id, 'shop', `💎 Extracted ${gemItem?.name || sock.gemSlug} for ${cost}g.`, tx);
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Extract failed.' }); }
  });

  // ─── ENCHANT (roll new perks) ───
  app.post('/api/fantasy/forge/enchant', requireAuth, validate(schemas.forgeEnchant), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!ctx.hasCraftingAccess(char.location)) return res.status(400).json({ error: 'The Forge requires a town with a workshop.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot enchant during combat.' });

      const { equipSlot } = req.body;
      const eqRow = await getEquipRow(char.id, equipSlot);
      if (!eqRow) return res.status(400).json({ error: 'Nothing equipped in that slot.' });

      const baseItem = getContent().items[eqRow.item_slug] || {};
      const rarity = baseItem.rarity;
      const costs = ENCHANT_COSTS[rarity];
      if (!costs) return res.status(400).json({ error: 'This item cannot be enchanted (must be rare or higher).' });
      if (char.gold < costs.gold) return res.status(400).json({ error: `Not enough gold (need ${costs.gold}g).` });

      // Check materials before transaction
      const inv = await q('SELECT item_slug, SUM(quantity)::int as qty FROM fantasy_inventory WHERE char_id=$1 AND perks IS NULL GROUP BY item_slug', [char.id]);
      const stor = await q('SELECT item_slug, SUM(quantity)::int as qty FROM fantasy_home_storage WHERE char_id=$1 GROUP BY item_slug', [char.id]);
      const invMap = {}, storMap = {};
      for (const r of inv) invMap[r.item_slug] = r.qty;
      for (const r of stor) storMap[r.item_slug] = r.qty;

      let commonCount = 0;
      for (const mat of COMMON_MATS) commonCount += (invMap[mat] || 0) + (storMap[mat] || 0);
      let rareCount = 0;
      for (const mat of RARE_MATS) rareCount += (invMap[mat] || 0) + (storMap[mat] || 0);

      if (commonCount < costs.materials) return res.status(400).json({ error: `Need ${costs.materials} common materials (have ${commonCount}).` });
      if (costs.rareMaterials && rareCount < costs.rareMaterials) return res.status(400).json({ error: `Need ${costs.rareMaterials} rare materials (have ${rareCount}).` });

      // Roll perks before transaction (pure computation, no DB)
      let newPerks = null;
      for (let attempt = 0; attempt < 10; attempt++) {
        newPerks = rollPerks(rarity, baseItem);
        if (newPerks && newPerks.length) break;
      }
      if (!newPerks || !newPerks.length) {
        const allStats = ['str','dex','int','wis','con','cha'];
        newPerks = [{ type: 'stat', stat: allStats[rand(0, allStats.length - 1)], value: rand(1, 3) }];
      }

      const { displayName } = await withTransaction(async (tx) => {
        // Deduct gold
        await tx.query('UPDATE fantasy_characters SET gold=gold-$1 WHERE id=$2', [costs.gold, char.id]);

        // Deduct common materials
        let remaining = costs.materials;
        for (const mat of COMMON_MATS) {
          if (remaining <= 0) break;
          const haveInv = invMap[mat] || 0;
          if (haveInv > 0) {
            const take = Math.min(haveInv, remaining);
            await removeItem(char.id, mat, take, null, tx);
            invMap[mat] -= take;
            remaining -= take;
          }
          if (remaining <= 0) break;
          const haveStor = storMap[mat] || 0;
          if (haveStor > 0) {
            const take = Math.min(haveStor, remaining);
            await removeHomeItem(char.id, mat, take, tx);
            storMap[mat] -= take;
            remaining -= take;
          }
        }

        // Deduct rare materials
        remaining = costs.rareMaterials || 0;
        for (const mat of RARE_MATS) {
          if (remaining <= 0) break;
          const haveInv = invMap[mat] || 0;
          if (haveInv > 0) {
            const take = Math.min(haveInv, remaining);
            await removeItem(char.id, mat, take, null, tx);
            invMap[mat] -= take;
            remaining -= take;
          }
          if (remaining <= 0) break;
          const haveStor = storMap[mat] || 0;
          if (haveStor > 0) {
            const take = Math.min(haveStor, remaining);
            await removeHomeItem(char.id, mat, take, tx);
            storMap[mat] -= take;
            remaining -= take;
          }
        }

        // Apply perks
        await tx.query('UPDATE fantasy_equipment SET perks=$1 WHERE char_id=$2 AND slot=$3', [JSON.stringify(newPerks), char.id, equipSlot]);

        const prefix = getPerkPrefix(newPerks);
        const dn = prefix ? prefix + ' ' + (baseItem.name || eqRow.item_slug) : (baseItem.name || eqRow.item_slug);
        await addLog(char.id, 'shop', `✨ Enchanted ${dn} with ${newPerks.length} perk${newPerks.length > 1 ? 's' : ''}! (-${costs.gold}g)`, tx);
        return { displayName: dn };
      });

      // Achievement: items-enchanted
      if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'items-enchanted', 1);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, newPerks, displayName });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Enchant failed.' }); }
  });

  // ─── EXTRACT PERKS → Perk Crystal ───
  app.post('/api/fantasy/forge/extract-perks', requireAuth, validate(schemas.forgeExtractPerks), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!ctx.hasCraftingAccess(char.location)) return res.status(400).json({ error: 'The Forge requires a town with a workshop.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot use forge during combat.' });

      const { equipSlot } = req.body;
      const eqRow = await getEquipRow(char.id, equipSlot);
      if (!eqRow) return res.status(400).json({ error: 'Nothing equipped in that slot.' });

      const baseItem = getContent().items[eqRow.item_slug] || {};
      const perks = eqRow.perks ? (typeof eqRow.perks === 'string' ? JSON.parse(eqRow.perks) : eqRow.perks) : null;
      if (!perks || !perks.length) return res.status(400).json({ error: 'Item has no perks to extract.' });

      const cost = EXTRACT_PERK_COSTS[baseItem.rarity] || 300;
      if (char.gold < cost) return res.status(400).json({ error: `Not enough gold (need ${cost}g).` });

      const success = rand(1, 100) <= 75;

      await withTransaction(async (tx) => {
        await tx.query('UPDATE fantasy_characters SET gold=gold-$1 WHERE id=$2', [cost, char.id]);
        await tx.query('UPDATE fantasy_equipment SET perks=NULL WHERE char_id=$1 AND slot=$2', [char.id, equipSlot]);

        if (success) {
          await addItem(char.id, 'perk-crystal', 1, perks, tx);
          await addLog(char.id, 'shop', `🔮 Extracted perk crystal from ${baseItem.name || equipSlot}! (-${cost}g)`, tx);
        } else {
          await addLog(char.id, 'shop', `💥 Perk extraction failed! Perks destroyed. (-${cost}g)`, tx);
        }
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, success });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Extract failed.' }); }
  });

  // ─── APPLY PERK CRYSTAL ───
  app.post('/api/fantasy/forge/apply-crystal', requireAuth, validate(schemas.forgeApplyCrystal), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!ctx.hasCraftingAccess(char.location)) return res.status(400).json({ error: 'The Forge requires a town with a workshop.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot use forge during combat.' });

      const { equipSlot, crystalInventoryId } = req.body;
      const eqRow = await getEquipRow(char.id, equipSlot);
      if (!eqRow) return res.status(400).json({ error: 'Nothing equipped in that slot.' });

      const baseItem = getContent().items[eqRow.item_slug] || {};
      const rarity = baseItem.rarity;
      if (!['rare','epic','legendary','mythic'].includes(rarity)) return res.status(400).json({ error: 'Item cannot hold perks.' });

      const crystal = await q1('SELECT * FROM fantasy_inventory WHERE id=$1 AND char_id=$2 AND item_slug=$3', [crystalInventoryId, char.id, 'perk-crystal']);
      if (!crystal) return res.status(400).json({ error: 'Perk crystal not found.' });
      const crystalPerks = crystal.perks ? (typeof crystal.perks === 'string' ? JSON.parse(crystal.perks) : crystal.perks) : null;
      if (!crystalPerks || !crystalPerks.length) return res.status(400).json({ error: 'Invalid crystal.' });

      await withTransaction(async (tx) => {
        await removeItem(char.id, 'perk-crystal', 1, crystalInventoryId, tx);
        await tx.query('UPDATE fantasy_equipment SET perks=$1 WHERE char_id=$2 AND slot=$3', [JSON.stringify(crystalPerks), char.id, equipSlot]);
        const prefix = getPerkPrefix(crystalPerks);
        const displayName = prefix ? prefix + ' ' + (baseItem.name || eqRow.item_slug) : (baseItem.name || eqRow.item_slug);
        await addLog(char.id, 'shop', `🔮 Applied perk crystal to ${displayName}!`, tx);
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Apply crystal failed.' }); }
  });
}

module.exports = { register };
