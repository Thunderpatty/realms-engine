'use strict';
// ═══════════════════════════════════════════════════════════
// Input Validation — Zod schemas for all API endpoints
// ═══════════════════════════════════════════════════════════

const z = require('zod');

// ─── Reusable field schemas ──────────────────────────────

const slug = z.string().min(1).max(100).regex(/^[a-z0-9-]+$/, 'Must be a lowercase slug (a-z, 0-9, hyphens)');
const optionalSlug = slug.optional();
const inventoryId = z.coerce.number().int().positive();
const optionalInventoryId = inventoryId.optional();
const quantity = z.coerce.number().int().min(1).max(9999).optional().default(1);
const equipSlot = z.enum(['weapon', 'shield', 'body', 'helmet', 'gloves', 'boots', 'amulet', 'ring', 'trinket']);
const socketIndex = z.coerce.number().int().min(0).max(3);
const positiveInt = z.coerce.number().int().positive();
const choiceIndex = z.coerce.number().int().min(0).max(50);
const slotIndex = z.coerce.number().int().min(0).max(5);
const charName = z.string().min(1).max(24).trim();
const handle = z.string().min(1).max(30).trim();
const handleStrict = z.string().min(3).max(24).regex(/^[a-z0-9_-]+$/, 'Handle must use letters, numbers, underscores, or hyphens').trim();
const password = z.string().min(1).max(128);
const passwordStrong = z.string().min(8).max(128);

// ─── Auth (server.js) ────────────────────────────────────

const registerSchema = z.object({
  handle: handleStrict,
  password: passwordStrong,
  confirmPassword: passwordStrong,
});

const loginSchema = z.object({
  handle,
  password,
});

const resetPasswordSchema = z.object({
  handle: handleStrict,
  password: passwordStrong,
  confirmPassword: passwordStrong,
});

// ─── Fantasy RPG Core (fantasy-rpg.js) ───────────────────

const createCharSchema = z.object({
  name: charName,
  race: slug,
  class: slug,
});

const markJunkSchema = z.object({
  itemSlug: slug,
  inventoryId: optionalInventoryId,
});

const travelSchema = z.object({
  destination: slug,
});

const travelPathSchema = z.object({
  destination: slug,
});

const eventResolveSchema = z.object({
  choiceIdx: choiceIndex,
});

const combatActionSchema = z.object({
  action: z.enum(['attack', 'ability', 'flee', 'item', 'defend', 'classAbility']),
  abilitySlug: optionalSlug,
  itemSlug: optionalSlug,
  targetId: z.string().max(20).optional(),
  petAbility: optionalSlug,
});

const questAcceptSchema = z.object({
  questSlug: slug,
});

const questChoiceSchema = z.object({
  questSlug: slug,
  choiceIndex: choiceIndex,
});

const shopBuySchema = z.object({
  itemSlug: slug,
});

const shopSellSchema = z.object({
  itemSlug: slug,
  inventoryId: optionalInventoryId,
  quantity,
});

const buybackSchema = z.object({
  index: z.coerce.number().int().min(0).max(10),
});

const equipSchema = z.object({
  itemSlug: slug,
  inventoryId: optionalInventoryId,
});

const unequipSchema = z.object({
  slot: equipSlot,
});

const repairSchema = z.object({
  slot: equipSlot,
});

const useItemSchema = z.object({
  itemSlug: slug,
});

const homeStoreSchema = z.object({
  itemSlug: slug,
  quantity,
});

const homeWithdrawSchema = z.object({
  itemSlug: slug,
  quantity,
});

const vaultStoreSchema = z.object({
  itemSlug: slug,
  inventoryId: optionalInventoryId,
  quantity,
});

const vaultWithdrawSchema = z.object({
  itemSlug: slug,
  vaultId: optionalInventoryId,
  quantity,
});

const craftSchema = z.object({
  recipeSlug: slug,
  quantity,
});

const learnRecipeSchema = z.object({
  itemSlug: slug,
});

const switchCharSchema = z.object({
  charId: positiveInt,
});

const contentUpsertSchema = z.object({
  kind: z.string().min(1).max(50),
  payload: z.record(z.string(), z.unknown()),
});

// ─── Duel (fantasy-duel.js) ──────────────────────────────

const duelChallengeSchema = z.object({
  targetCharId: positiveInt,
  wager: z.coerce.number().int().min(0).max(999999).optional().default(0),
});

const duelAcceptSchema = z.object({
  duelId: positiveInt,
});

const duelDeclineSchema = z.object({
  duelId: positiveInt,
});

const duelActionSchema = z.object({
  duelId: positiveInt,
  action: z.enum(['attack', 'ability']),
  abilitySlug: optionalSlug,
});

const duelForfeitSchema = z.object({
  duelId: positiveInt,
});

// ─── Academy (systems/academy.js) ────────────────────────

const academyLearnSchema = z.object({
  abilitySlug: slug,
});

const academyEquipSchema = z.object({
  activeAbilities: z.array(slug).min(1).max(6),
  mode: z.enum(['pve', 'pvp']).optional().default('pve'),
});

const academyUpgradeSchema = z.object({
  abilitySlug: slug,
});

// ─── Arena (systems/arena.js) ────────────────────────────

const arenaChoiceSchema = z.object({
  choice: z.enum(['healHp', 'restoreMp', 'apBonus']),
});

const arenaStoreBuySchema = z.object({
  slotIndex,
});

const arenaRerollSlotSchema = z.object({
  slotIndex,
});

// ─── Raid (systems/raid.js) ───────────────────────────────

const raidEnterSchema = z.object({
  raidSlug: slug,
});

const raidChoiceSchema = z.object({
  choiceIdx: z.coerce.number().int().min(0).max(20),
});

const raidFloorChoiceSchema = z.object({
  choice: z.enum(['healHp', 'restoreMp', 'both']),
});

// ─── Party (systems/party.js) ─────────────────────────────

const partyInviteSchema = z.object({
  charId: z.coerce.number().int().min(1),
});

const partyInviteResponseSchema = z.object({
  inviteId: z.coerce.number().int().min(1),
});

const partyKickSchema = z.object({
  charId: z.coerce.number().int().min(1),
});

const partyStartSchema = z.object({
  raidSlug: slug,
});

// ─── Friends (systems/friends.js) ────────────────────────

const friendAddSchema = z.object({
  name: z.string().min(1).max(50).trim(),
});

const friendActionSchema = z.object({
  friendshipId: z.coerce.number().int().min(1),
});

// ─── Auction (systems/auction.js) ────────────────────────

const auctionBrowseSchema = z.object({
  slotFilter: z.string().max(50).optional(),
  rarityFilter: z.string().max(50).optional(),
  sort: z.string().max(50).optional(),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
});

const auctionListSchema = z.object({
  itemSlug: slug,
  inventoryId: optionalInventoryId,
  price: z.coerce.number().int().min(1).max(999999),
  quantity,
});

const auctionBuySchema = z.object({
  listingId: positiveInt,
});

const auctionCancelSchema = z.object({
  listingId: positiveInt,
});

// ─── Forge (systems/forge.js) ────────────────────────────

const forgeSocketSchema = z.object({
  equipSlot: equipSlot,
  socketIndex,
  gemSlug: slug,
});

const forgeExtractGemSchema = z.object({
  equipSlot: equipSlot,
  socketIndex,
});

const forgeEnchantSchema = z.object({
  equipSlot: equipSlot,
});

const forgeExtractPerksSchema = z.object({
  equipSlot: equipSlot,
});

const forgeApplyCrystalSchema = z.object({
  equipSlot: equipSlot,
  crystalInventoryId: positiveInt,
});

// ─── Guild (systems/guild.js) ────────────────────────────

const bountyAcceptSchema = z.object({
  bountyId: positiveInt,
});

const bountyClaimSchema = z.object({
  bountyId: positiveInt,
});

const bountyAbandonSchema = z.object({
  bountyId: positiveInt,
});

const guildBuySchema = z.object({
  itemSlug: slug,
});

// ─── Middleware factory ──────────────────────────────────

/**
 * Returns Express middleware that validates req.body against the given schema.
 * On success, replaces req.body with the parsed (clean, typed) data.
 * On failure, returns 400 with error details.
 */
function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body || {});
    if (!result.success) {
      const messages = result.error.issues.map(i => {
        const path = i.path.length ? i.path.join('.') + ': ' : '';
        return path + i.message;
      });
      return res.status(400).json({ error: 'Invalid input.', details: messages });
    }
    req.body = result.data;
    next();
  };
}

// ─── Exports ─────────────────────────────────────────────

module.exports = {
  validate,
  schemas: {
    // Auth
    register: registerSchema,
    login: loginSchema,
    resetPassword: resetPasswordSchema,
    // Fantasy RPG core
    createChar: createCharSchema,
    markJunk: markJunkSchema,
    travel: travelSchema,
    travelPath: travelPathSchema,
    eventResolve: eventResolveSchema,
    combatAction: combatActionSchema,
    questAccept: questAcceptSchema,
    questChoice: questChoiceSchema,
    shopBuy: shopBuySchema,
    shopSell: shopSellSchema,
    buyback: buybackSchema,
    equip: equipSchema,
    unequip: unequipSchema,
    repair: repairSchema,
    useItem: useItemSchema,
    homeStore: homeStoreSchema,
    homeWithdraw: homeWithdrawSchema,
    vaultStore: vaultStoreSchema,
    vaultWithdraw: vaultWithdrawSchema,
    craft: craftSchema,
    learnRecipe: learnRecipeSchema,
    switchChar: switchCharSchema,
    contentUpsert: contentUpsertSchema,
    // Duel
    duelChallenge: duelChallengeSchema,
    duelAccept: duelAcceptSchema,
    duelDecline: duelDeclineSchema,
    duelAction: duelActionSchema,
    duelForfeit: duelForfeitSchema,
    // Academy
    academyLearn: academyLearnSchema,
    academyEquip: academyEquipSchema,
    academyUpgrade: academyUpgradeSchema,
    // Arena
    arenaChoice: arenaChoiceSchema,
    arenaStoreBuy: arenaStoreBuySchema,
    arenaRerollSlot: arenaRerollSlotSchema,
    // Auction
    auctionBrowse: auctionBrowseSchema,
    auctionList: auctionListSchema,
    auctionBuy: auctionBuySchema,
    auctionCancel: auctionCancelSchema,
    // Forge
    forgeSocket: forgeSocketSchema,
    forgeExtractGem: forgeExtractGemSchema,
    forgeEnchant: forgeEnchantSchema,
    forgeExtractPerks: forgeExtractPerksSchema,
    forgeApplyCrystal: forgeApplyCrystalSchema,
    // Guild
    bountyAccept: bountyAcceptSchema,
    bountyClaim: bountyClaimSchema,
    bountyAbandon: bountyAbandonSchema,
    guildBuy: guildBuySchema,
    // Raid
    raidEnter: raidEnterSchema,
    raidChoice: raidChoiceSchema,
    raidFloorChoice: raidFloorChoiceSchema,
    // Friends
    friendAdd: friendAddSchema,
    friendAction: friendActionSchema,
    // Party
    partyInvite: partyInviteSchema,
    partyInviteResponse: partyInviteResponseSchema,
    partyKick: partyKickSchema,
    partyStart: partyStartSchema,
  },
};
