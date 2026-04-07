// ═══════════════════════════════════════════════════════════════
// SHOP — Buy, Sell, Buyback, Repair, Rest
// Extracted from fantasy-rpg.js (Tier 2A.7)
// ═══════════════════════════════════════════════════════════════

const GAME_CONFIG = require('../shared/game-config');
const { validate, schemas } = require('../validation');

const REPAIR_RARITY_MULT = GAME_CONFIG.repairRarityMult;
const BUYBACK_MAX = 5;
const buybackLists = new Map();

function getBuyback(charId) { return buybackLists.get(charId) || []; }
function addBuyback(charId, entry) {
  let list = buybackLists.get(charId) || [];
  list.unshift(entry);
  if (list.length > BUYBACK_MAX) list = list.slice(0, BUYBACK_MAX);
  buybackLists.set(charId, list);
}

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, withTransaction, getChar, addLog, addItem, removeItem,
    buildState, buildPatch, getContent, getMaxDurability, EQUIPMENT_SLOTS,
    getEquipment, getPerkPrefix,
  } = ctx;

  function getRepairCost(itemSlug, currentDurability) {
    const item = getContent().items[itemSlug];
    const maxDur = getMaxDurability(itemSlug);
    const missing = maxDur - currentDurability;
    if (missing <= 0) return { cost: 0, missing: 0, maxDur };
    const rarityMult = REPAIR_RARITY_MULT[item?.rarity] || 1;
    const cost = Math.max(1, Math.floor(missing * 2 * rarityMult));
    return { cost, missing, maxDur, item };
  }

  app.post('/api/fantasy/shop/buy', requireAuth, validate(schemas.shopBuy), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { itemSlug } = req.body;
      const shopItems = getContent().shopItems[char.location];
      if (!shopItems || !shopItems.includes(itemSlug)) return res.status(400).json({ error: 'Item not available here.' });
      const item = getContent().items[itemSlug];
      if (!item) return res.status(400).json({ error: 'Unknown item.' });
      if (char.gold < item.cost) return res.status(400).json({ error: 'Not enough gold.' });
      await withTransaction(async (tx) => {
        const r = await tx.query('UPDATE fantasy_characters SET gold = gold - $1 WHERE id = $2 AND gold >= $1 RETURNING gold', [item.cost, char.id]);
        if (r.rowCount === 0) throw new Error('Not enough gold.');
        await addItem(char.id, itemSlug, 1, null, tx);
        await addLog(char.id, 'shop', `🛒 Bought ${item.name} for ${item.cost} gold.`, tx);
      });
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'inventory', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Purchase failed.' }); }
  });

  app.post('/api/fantasy/shop/sell', requireAuth, validate(schemas.shopSell), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { itemSlug, inventoryId, quantity } = req.body;
      const item = getContent().items[itemSlug];
      if (!item) return res.status(400).json({ error: 'Unknown item.' });
      const sellQty = inventoryId ? 1 : Math.max(1, Math.min(parseInt(quantity, 10) || 1, 9999));
      const sellPrice = (item.sell || 1) * sellQty;

      let soldPerks = null;
      if (inventoryId) {
        const invRow = await q1('SELECT perks FROM fantasy_inventory WHERE id=$1 AND char_id=$2', [inventoryId, char.id]);
        if (invRow?.perks) soldPerks = typeof invRow.perks === 'string' ? JSON.parse(invRow.perks) : invRow.perks;
      }

      await withTransaction(async (tx) => {
        const removed = await removeItem(char.id, itemSlug, sellQty, inventoryId || null, tx);
        if (!removed) throw new Error("You don't have that item.");
        await tx.query('UPDATE fantasy_characters SET gold = gold + $1 WHERE id = $2', [sellPrice, char.id]);
        const label = sellQty > 1 ? `${item.name} ×${sellQty}` : item.name;
        await addLog(char.id, 'shop', `💰 Sold ${label} for ${sellPrice} gold.`, tx);
      });

      addBuyback(char.id, { itemSlug, name: item.name, rarity: item.rarity, perks: soldPerks, sellPrice, quantity: sellQty });

      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'inventory', 'log']);
      patch.buyback = getBuyback(char.id);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Sale failed.' }); }
  });

  app.post('/api/fantasy/shop/buyback', requireAuth, validate(schemas.buyback), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const shopItems = getContent().shopItems[char.location];
      if (!shopItems) return res.status(400).json({ error: 'No shop here.' });
      const { index } = req.body;
      const list = getBuyback(char.id);
      const entry = list[index];
      if (!entry) return res.status(400).json({ error: 'Nothing to buy back.' });
      if (char.gold < entry.sellPrice) return res.status(400).json({ error: `Not enough gold (need ${entry.sellPrice}g).` });

      await withTransaction(async (tx) => {
        const r = await tx.query('UPDATE fantasy_characters SET gold = gold - $1 WHERE id = $2 AND gold >= $1 RETURNING gold', [entry.sellPrice, char.id]);
        if (r.rowCount === 0) throw new Error('Not enough gold.');
        await addItem(char.id, entry.itemSlug, entry.quantity, entry.perks, tx);
        const label = entry.quantity > 1 ? `${entry.name} ×${entry.quantity}` : entry.name;
        await addLog(char.id, 'shop', `🔄 Bought back ${label} for ${entry.sellPrice} gold.`, tx);
      });

      list.splice(index, 1);
      buybackLists.set(char.id, list);

      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'inventory', 'log']);
      patch.buyback = getBuyback(char.id);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Buyback failed.' }); }
  });

  app.post('/api/fantasy/equip', requireAuth, validate(schemas.equip), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot equip during combat.' });
      const { itemSlug, inventoryId } = req.body;
      const item = getContent().items[itemSlug];
      const slot = item?.type;
      if (!item || !EQUIPMENT_SLOTS.includes(slot)) return res.status(400).json({ error: 'Cannot equip that item.' });
      if (item.classReq && item.classReq !== char.class) return res.status(400).json({ error: `Only ${item.classReq}s can equip ${item.name}.` });
      const hasItem = inventoryId
        ? await q1('SELECT * FROM fantasy_inventory WHERE id=$1 AND char_id=$2 AND item_slug=$3', [inventoryId, char.id, itemSlug])
        : await q1('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND item_slug=$2', [char.id, itemSlug]);
      if (!hasItem) return res.status(400).json({ error: "You don't have that item." });
      const itemPerks = hasItem.perks ? (typeof hasItem.perks === 'string' ? JSON.parse(hasItem.perks) : hasItem.perks) : null;

      await withTransaction(async (tx) => {
        const current = await q1('SELECT * FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [char.id, slot], tx);
        if (current) {
          const currentPerks = current.perks ? (typeof current.perks === 'string' ? JSON.parse(current.perks) : current.perks) : null;
          await addItem(char.id, current.item_slug, 1, currentPerks, tx);
          await tx.query('DELETE FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [char.id, slot]);
        }
        await removeItem(char.id, itemSlug, 1, hasItem.perks ? hasItem.id : null, tx);
        const maxDur = getMaxDurability(itemSlug);
        await tx.query('INSERT INTO fantasy_equipment (char_id, slot, item_slug, durability, perks) VALUES ($1, $2, $3, $4, $5)',
          [char.id, slot, itemSlug, maxDur, itemPerks ? JSON.stringify(itemPerks) : null]);
        const displayName = itemPerks ? (getPerkPrefix(itemPerks) + ' ' + item.name) : item.name;
        await addLog(char.id, 'equip', `🛡 Equipped ${displayName}. (Durability: ${maxDur}/${maxDur})`, tx);
      });

      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'inventory', 'equipment', 'stats', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Equip failed.' }); }
  });

  app.post('/api/fantasy/unequip', requireAuth, validate(schemas.unequip), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { slot } = req.body;
      const current = await q1('SELECT * FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [char.id, slot]);
      if (!current) return res.status(400).json({ error: 'Nothing equipped in that slot.' });
      const currentPerks = current.perks ? (typeof current.perks === 'string' ? JSON.parse(current.perks) : current.perks) : null;

      await withTransaction(async (tx) => {
        await addItem(char.id, current.item_slug, 1, currentPerks, tx);
        await tx.query('DELETE FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [char.id, slot]);
        const item = getContent().items[current.item_slug];
        const displayName = currentPerks ? (getPerkPrefix(currentPerks) + ' ' + (item?.name || current.item_slug)) : (item?.name || current.item_slug);
        await addLog(char.id, 'equip', `Unequipped ${displayName}.`, tx);
      });

      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'inventory', 'equipment', 'stats', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Unequip failed.' }); }
  });

  app.post('/api/fantasy/repair', requireAuth, validate(schemas.repair), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot repair during combat.' });
      const shopItems = getContent().shopItems[char.location];
      if (!shopItems) return res.status(400).json({ error: 'No blacksmith at this location. Visit a town.' });
      const { slot } = req.body;
      if (!EQUIPMENT_SLOTS.includes(slot)) return res.status(400).json({ error: 'Unknown equipment slot.' });
      const eq = await q1('SELECT * FROM fantasy_equipment WHERE char_id=$1 AND slot=$2', [char.id, slot]);
      if (!eq) return res.status(400).json({ error: 'Nothing equipped in that slot.' });
      const { cost, missing, maxDur, item } = getRepairCost(eq.item_slug, eq.durability);
      if (missing <= 0) return res.status(400).json({ error: 'Item is already at full durability.' });
      if (char.gold < cost) return res.status(400).json({ error: `Not enough gold. Repair costs ${cost}g.` });
      await withTransaction(async (tx) => {
        const r = await tx.query('UPDATE fantasy_characters SET gold = gold - $1 WHERE id = $2 AND gold >= $1 RETURNING gold', [cost, char.id]);
        if (r.rowCount === 0) throw new Error('Not enough gold.');
        await tx.query('UPDATE fantasy_equipment SET durability=$1 WHERE char_id=$2 AND slot=$3', [maxDur, char.id, slot]);
        await addLog(char.id, 'shop', `🔧 Repaired ${item?.name || eq.item_slug} to full durability. (-${cost}g)`, tx);
      });
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'equipment', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Repair failed.' }); }
  });

  app.post('/api/fantasy/repair-all', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot repair during combat.' });
      const shopItems = getContent().shopItems[char.location];
      if (!shopItems) return res.status(400).json({ error: 'No blacksmith at this location. Visit a town.' });
      const allEq = await q('SELECT * FROM fantasy_equipment WHERE char_id=$1', [char.id]);
      let totalCost = 0;
      const toRepair = [];
      for (const eq of allEq) {
        const { cost, missing, maxDur, item } = getRepairCost(eq.item_slug, eq.durability);
        if (missing > 0) {
          toRepair.push({ eq, cost, maxDur, item });
          totalCost += cost;
        }
      }
      if (toRepair.length === 0) return res.status(400).json({ error: 'All equipment is already at full durability.' });
      if (char.gold < totalCost) return res.status(400).json({ error: `Not enough gold. Repairing all costs ${totalCost}g.` });
      await withTransaction(async (tx) => {
        const r = await tx.query('UPDATE fantasy_characters SET gold = gold - $1 WHERE id = $2 AND gold >= $1 RETURNING gold', [totalCost, char.id]);
        if (r.rowCount === 0) throw new Error('Not enough gold.');
        for (const { eq, maxDur } of toRepair) {
          await tx.query('UPDATE fantasy_equipment SET durability=$1 WHERE char_id=$2 AND slot=$3', [maxDur, char.id, eq.slot]);
        }
        const names = toRepair.map(r => r.item?.name || r.eq.item_slug).join(', ');
        await addLog(char.id, 'shop', `🔧 Repaired ${toRepair.length} item${toRepair.length > 1 ? 's' : ''}: ${names}. (-${totalCost}g)`, tx);
      });
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'equipment', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Repair all failed.' }); }
  });

  app.post('/api/fantasy/rest', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot rest during combat.' });
      const cost = getContent().innCost[char.location];
      if (!cost) return res.status(400).json({ error: 'No inn at this location.' });
      if (char.gold < cost) return res.status(400).json({ error: 'Not enough gold.' });
      await withTransaction(async (tx) => {
        const r = await tx.query('UPDATE fantasy_characters SET gold = gold - $1, hp = max_hp, mp = max_mp WHERE id = $2 AND gold >= $1 RETURNING gold', [cost, char.id]);
        if (r.rowCount === 0) throw new Error('Not enough gold.');
        await addLog(char.id, 'rest', `🏨 You rest at the inn. HP and MP fully restored. (-${cost} gold)`, tx);
      });
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Rest failed.' }); }
  });

  app.post('/api/fantasy/inventory/mark-junk', requireAuth, validate(schemas.markJunk), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { itemSlug, inventoryId } = req.body;
      // Use inventoryId (row PK) when provided to target a specific perked item
      const row = inventoryId
        ? await q1('SELECT * FROM fantasy_inventory WHERE id=$1 AND char_id=$2', [inventoryId, char.id])
        : await q1('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND item_slug=$2 AND perks IS NULL', [char.id, itemSlug]);
      if (!row) return res.status(400).json({ error: "You don't have that item." });
      const nowJunk = !row.junk;
      await db.query('UPDATE fantasy_inventory SET junk=$1 WHERE id=$2 AND char_id=$3', [nowJunk, row.id, char.id]);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['inventory']);
      res.json({ ok: true, junk: nowJunk, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to mark item.' }); }
  });

  app.post('/api/fantasy/use', requireAuth, validate(schemas.useItem), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Use combat item actions during combat.' });
      const { itemSlug } = req.body;
      const item = getContent().items[itemSlug];
      if (!item || item.type !== 'consumable') return res.status(400).json({ error: 'That item cannot be used.' });
      if (item.use?.combatOnly) return res.status(400).json({ error: 'Use that item during combat.' });
      const removed = await removeItem(char.id, itemSlug);
      if (!removed) return res.status(400).json({ error: "You don't have that item." });
      ctx.applyConsumableUse(item, char);
      await db.query('UPDATE fantasy_characters SET hp=$1, mp=$2 WHERE id=$3', [char.hp, char.mp, char.id]);
      await addLog(char.id, 'item', `🧪 Used ${item.name}.`);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'inventory', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Use item failed.' }); }
  });
}

module.exports = { register, getBuyback };
