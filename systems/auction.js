// ═══════════════════════════════════════════════════════════════
// AUCTION HOUSE
// All mutation operations wrapped in transactions for atomicity.
// ═══════════════════════════════════════════════════════════════

const GAME_CONFIG = require('../shared/game-config');

const AH_LISTING_FEE_PCT = GAME_CONFIG.auctionHouse.listingFeePct;
const AH_SALES_TAX_PCT = GAME_CONFIG.auctionHouse.salesTaxPct;
const AH_MAX_LISTINGS = GAME_CONFIG.auctionHouse.maxListings;
const AH_DURATION_HOURS = GAME_CONFIG.auctionHouse.durationHours;
const AH_PAGE_SIZE = GAME_CONFIG.auctionHouse.pageSize;
const { validate, schemas } = require('../validation');

function register(app, requireAuth, ctx) {
  const { db, q, q1, withTransaction, getChar, addLog, addItem, removeItem, buildState, getContent, getPerkPrefix } = ctx;

  async function processExpiredListings() {
    const expired = await q("SELECT * FROM fantasy_auction_listings WHERE state = 'active' AND expires_at < NOW()");
    for (const listing of expired) {
      await withTransaction(async (tx) => {
        const perks = listing.item_perks ? (typeof listing.item_perks === 'string' ? JSON.parse(listing.item_perks) : listing.item_perks) : null;
        await addItem(listing.seller_id, listing.item_slug, listing.quantity, perks, tx);
        await tx.query("UPDATE fantasy_auction_listings SET state = 'expired' WHERE id = $1", [listing.id]);
        await addLog(listing.seller_id, 'shop', `🏛 Auction expired: ${listing.item_name} returned to your inventory.`, tx);
      });
    }
    return expired.length;
  }

  app.post('/api/fantasy/auction/browse', requireAuth, validate(schemas.auctionBrowse), async (req, res) => {
    try {
      await processExpiredListings();
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { slotFilter, rarityFilter, sort, page } = req.body;
      let where = "state = 'active'";
      const params = [];
      let paramIdx = 1;
      if (slotFilter && slotFilter !== 'all') { where += ` AND item_type = $${paramIdx++}`; params.push(slotFilter); }
      if (rarityFilter && rarityFilter !== 'all') { where += ` AND item_rarity = $${paramIdx++}`; params.push(rarityFilter); }
      const orderBy = sort === 'price-desc' ? 'price DESC' : sort === 'rarity' ? "CASE item_rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 WHEN 'epic' THEN 3 WHEN 'legendary' THEN 4 WHEN 'mythic' THEN 5 END DESC, price ASC" : sort === 'newest' ? 'listed_at DESC' : 'price ASC';
      const offset = ((page || 1) - 1) * AH_PAGE_SIZE;
      const countResult = await q1(`SELECT COUNT(*) as cnt FROM fantasy_auction_listings WHERE ${where}`, params);
      const totalCount = parseInt(countResult?.cnt || 0);
      const listings = await q(`SELECT * FROM fantasy_auction_listings WHERE ${where} ORDER BY ${orderBy} LIMIT ${AH_PAGE_SIZE} OFFSET ${offset}`, params);
      const slugs = [...new Set(listings.map(l => l.item_slug))];
      const priceHistory = {};
      for (const slug of slugs) {
        const recent = await q1('SELECT price FROM fantasy_auction_history WHERE item_slug = $1 ORDER BY sold_at DESC LIMIT 1', [slug]);
        if (recent) priceHistory[slug] = recent.price;
      }
      res.json({
        ok: true,
        listings: listings.map(l => ({
          id: l.id, itemSlug: l.item_slug, itemName: l.item_name, itemRarity: l.item_rarity,
          itemType: l.item_type, itemPerks: l.item_perks, quantity: l.quantity, price: l.price,
          sellerName: l.seller_name, sellerId: l.seller_id, listedAt: l.listed_at, expiresAt: l.expires_at,
          isMine: l.seller_id === char.id,
        })),
        priceHistory, totalCount, page: page || 1, totalPages: Math.ceil(totalCount / AH_PAGE_SIZE),
      });
    } catch (e) { console.error('AH browse error:', e); res.status(500).json({ error: 'Browse failed.' }); }
  });

  app.post('/api/fantasy/auction/list', requireAuth, validate(schemas.auctionList), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot list items during combat.' });
      const { itemSlug, inventoryId, price, quantity } = req.body;
      const qty = quantity || 1;
      if (!price || price < 1) return res.status(400).json({ error: 'Price must be at least 1 gold.' });
      if (qty < 1) return res.status(400).json({ error: 'Invalid quantity.' });
      const activeCount = (await q1("SELECT COUNT(*)::int as cnt FROM fantasy_auction_listings WHERE seller_id = $1 AND state = 'active'", [char.id]))?.cnt || 0;
      if (activeCount >= AH_MAX_LISTINGS) return res.status(400).json({ error: `Maximum ${AH_MAX_LISTINGS} active listings.` });
      const invRow = inventoryId
        ? await q1('SELECT * FROM fantasy_inventory WHERE id=$1 AND char_id=$2 AND item_slug=$3', [inventoryId, char.id, itemSlug])
        : await q1('SELECT * FROM fantasy_inventory WHERE char_id=$1 AND item_slug=$2 AND perks IS NULL', [char.id, itemSlug]);
      if (!invRow || invRow.quantity < qty) return res.status(400).json({ error: "You don't have enough of that item." });
      const item = getContent().items[itemSlug];
      if (!item) return res.status(400).json({ error: 'Unknown item.' });
      const totalPrice = price * qty;
      const listingFee = AH_LISTING_FEE_PCT > 0 ? Math.max(1, Math.floor(totalPrice * AH_LISTING_FEE_PCT / 100)) : 0;
      if (listingFee > 0 && char.gold < listingFee) return res.status(400).json({ error: `Listing fee is ${listingFee}g. Not enough gold.` });

      await withTransaction(async (tx) => {
        if (listingFee > 0) {
          await tx.query('UPDATE fantasy_characters SET gold=gold-$1 WHERE id=$2 AND gold>=$1', [listingFee, char.id]);
        }
        const perks = invRow.perks ? (typeof invRow.perks === 'string' ? JSON.parse(invRow.perks) : invRow.perks) : null;
        const removed = await removeItem(char.id, itemSlug, qty, perks ? invRow.id : null, tx);
        if (!removed) throw new Error('Failed to remove item.');
        const displayName = perks ? (getPerkPrefix(perks) + ' ' + item.name) : item.name;
        await tx.query(
          `INSERT INTO fantasy_auction_listings (seller_id, seller_name, item_slug, item_name, item_rarity, item_type, item_perks, quantity, price, listing_fee, inventory_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [char.id, char.name, itemSlug, displayName, item.rarity, item.type, perks ? JSON.stringify(perks) : null, qty, price, listingFee, invRow.id]
        );
        await addLog(char.id, 'shop', `🏛 Listed ${displayName}${qty > 1 ? ' ×' + qty : ''} on the Auction House for ${totalPrice}g.${listingFee ? ' Listing fee: ' + listingFee + 'g.' : ''}`, tx);
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) {
      if (e.message === 'Failed to remove item.') return res.status(400).json({ error: e.message });
      console.error('AH list error:', e); res.status(500).json({ error: 'Listing failed.' });
    }
  });

  app.post('/api/fantasy/auction/buy', requireAuth, validate(schemas.auctionBuy), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { listingId } = req.body;

      await withTransaction(async (tx) => {
        // Atomic claim — only one buyer can get it
        const listing = (await tx.query("UPDATE fantasy_auction_listings SET state='sold', buyer_id=$1, buyer_name=$2, sold_at=NOW() WHERE id=$3 AND state='active' RETURNING *", [char.id, char.name, listingId])).rows[0];
        if (!listing) throw new Error('Listing no longer available.');
        if (listing.seller_id === char.id) {
          await tx.query("UPDATE fantasy_auction_listings SET state='active', buyer_id=NULL, buyer_name=NULL, sold_at=NULL WHERE id=$1", [listingId]);
          throw new Error("You can't buy your own listing.");
        }
        const totalPrice = listing.price * listing.quantity;
        // Atomic gold deduction — fails if insufficient
        const goldResult = await tx.query('UPDATE fantasy_characters SET gold=gold-$1 WHERE id=$2 AND gold>=$1 RETURNING gold', [totalPrice, char.id]);
        if (goldResult.rowCount === 0) {
          await tx.query("UPDATE fantasy_auction_listings SET state='active', buyer_id=NULL, buyer_name=NULL, sold_at=NULL WHERE id=$1", [listingId]);
          throw new Error(`Not enough gold (need ${totalPrice}g).`);
        }
        const perks = listing.item_perks ? (typeof listing.item_perks === 'string' ? JSON.parse(listing.item_perks) : listing.item_perks) : null;
        await addItem(char.id, listing.item_slug, listing.quantity, perks, tx);
        const tax = AH_SALES_TAX_PCT > 0 ? Math.max(1, Math.floor(totalPrice * AH_SALES_TAX_PCT / 100)) : 0;
        const sellerProceeds = totalPrice - tax;
        await tx.query('UPDATE fantasy_characters SET gold = gold + $1 WHERE id = $2', [sellerProceeds, listing.seller_id]);
        await tx.query('INSERT INTO fantasy_auction_history (item_slug, item_rarity, price) VALUES ($1, $2, $3)', [listing.item_slug, listing.item_rarity, listing.price]);
        await addLog(char.id, 'shop', `🏛 Bought ${listing.item_name}${listing.quantity > 1 ? ' ×' + listing.quantity : ''} for ${totalPrice}g from ${listing.seller_name}.`, tx);
        await addLog(listing.seller_id, 'shop', `🏛 Sold ${listing.item_name}${listing.quantity > 1 ? ' ×' + listing.quantity : ''} to ${char.name} for ${totalPrice}g.${tax ? ' (' + tax + 'g tax). Received ' + sellerProceeds + 'g.' : ''}`, tx);
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) {
      if (e.message.includes('gold') || e.message.includes('available') || e.message.includes('own listing')) return res.status(400).json({ error: e.message });
      console.error('AH buy error:', e); res.status(500).json({ error: 'Purchase failed.' });
    }
  });

  app.post('/api/fantasy/auction/cancel', requireAuth, validate(schemas.auctionCancel), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { listingId } = req.body;

      await withTransaction(async (tx) => {
        const listing = (await tx.query("UPDATE fantasy_auction_listings SET state='cancelled' WHERE id=$1 AND seller_id=$2 AND state='active' RETURNING *", [listingId, char.id])).rows[0];
        if (!listing) throw new Error('Listing not found or already sold.');
        const perks = listing.item_perks ? (typeof listing.item_perks === 'string' ? JSON.parse(listing.item_perks) : listing.item_perks) : null;
        await addItem(char.id, listing.item_slug, listing.quantity, perks, tx);
        await addLog(char.id, 'shop', `🏛 Cancelled listing: ${listing.item_name} returned to inventory.${listing.listing_fee ? ' (' + listing.listing_fee + 'g fee not refunded)' : ''}`, tx);
      });

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) {
      if (e.message.includes('not found') || e.message.includes('already sold')) return res.status(400).json({ error: e.message });
      console.error('AH cancel error:', e); res.status(500).json({ error: 'Cancel failed.' });
    }
  });

  app.post('/api/fantasy/auction/my-listings', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      await processExpiredListings();
      const listings = await q("SELECT * FROM fantasy_auction_listings WHERE seller_id = $1 AND state IN ('active','sold','expired','cancelled') ORDER BY listed_at DESC LIMIT 20", [char.id]);
      res.json({
        ok: true,
        listings: listings.map(l => ({
          id: l.id, itemSlug: l.item_slug, itemName: l.item_name, itemRarity: l.item_rarity,
          itemType: l.item_type, itemPerks: l.item_perks, quantity: l.quantity, price: l.price,
          listingFee: l.listing_fee, state: l.state, buyerName: l.buyer_name,
          listedAt: l.listed_at, expiresAt: l.expires_at, soldAt: l.sold_at,
        })),
      });
    } catch (e) { console.error('AH my-listings error:', e); res.status(500).json({ error: 'Failed.' }); }
  });
}

module.exports = { register };
