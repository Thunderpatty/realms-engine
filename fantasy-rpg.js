// ═══════════════════════════════════════════════════════════════════
// FANTASY RPG — Text-Based Adventure Module
// Integrates with the existing Express + PGlite server
// ═══════════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');

// ─── GAME CONFIG (data-driven constants) ─────────────────────────

const GAME_CONFIG = require('./shared/game-config');

// ─── GAME EVENTS (cross-system event emitter) ───────────────────

const gameEvents = require('./systems/game-events');
const { withTransaction } = require('./postgres-runtime');
const { validate, schemas } = require('./validation');
const gameLogic = require('./shared/game-logic');
const { createSchema } = require('./db/schema');

// Import pure functions from shared module (extracted for testability)
const {
  rand, xpForLevel, computeStats,
  calcDodgeChance, calcEnemyDodgeChance, calcCritChance, calcEnemyCritChance,
  applyDefenseReduction, getEquipmentPassives, getEquipmentPerkBonuses,
  getCombatPassives, applyEffect, removeEffect, getEffectStatMods,
  tickEffects, isStunned, applyDamagePassives, applyTurnRegenPassives,
  addTempPassive, applyConsumableUse, rollPerks, getPerkPrefix, getAbilityRankCost,
  getRacialPassive, applyRacialDamageBonus, RACIAL_PASSIVES,
} = gameLogic;

// ─── GAME DATA ───────────────────────────────────────────────────


const RACES = GAME_CONFIG.races;
const CLASSES = GAME_CONFIG.classes;

// Build a flat ability index from all class abilities + any extra abilities in config
// This enables ability lookup by slug without knowing the class, and supports
// future non-class abilities (scrolls, quest rewards, etc.)
const ABILITY_INDEX = {};
for (const cls of CLASSES) {
  for (const ability of cls.abilities) {
    ABILITY_INDEX[ability.slug] = { ...ability, class: cls.slug };
  }
}
// Extra abilities defined outside classes (future expansion)
if (GAME_CONFIG.extraAbilities) {
  for (const ability of GAME_CONFIG.extraAbilities) {
    ABILITY_INDEX[ability.slug] = ability;
  }
}


const CONTENT_SEED_PATH = path.join(__dirname, 'fantasy-content.seed.json');
const CRAFTING_SEED_PATH = path.join(__dirname, 'fantasy-crafting.seed.json');
let CONTENT_SEED = require('./fantasy-content.seed.json');
let CRAFTING_SEED = require('./fantasy-crafting.seed.json');
const HOME_LOCATION = GAME_CONFIG.homeLocation;

// Split content directory loader (Phase 2 — content/ directory)
const { buildContentFromDirectory, hasContentDirectory } = require('./systems/content-loader');

function buildStaticFantasyContent() {
  // Prefer split content/ directory if it exists
  if (hasContentDirectory()) {
    const dirContent = buildContentFromDirectory();
    // Merge with legacy seed crafting data that may not be in the directory yet
    const {
      extraItems = {},
      recipes: craftRecipes = [],
      materialDrops: craftDrops = {},
      bossRecipeDrops: craftBossDrops = {},
    } = CRAFTING_SEED;
    return {
      ...dirContent,
      items: { ...dirContent.items, ...extraItems },
      recipes: dirContent.recipes.length ? dirContent.recipes : craftRecipes,
      materialDrops: Object.keys(dirContent.materialDrops).length ? dirContent.materialDrops : craftDrops,
      bossRecipeDrops: Object.keys(dirContent.bossRecipeDrops).length ? dirContent.bossRecipeDrops : craftBossDrops,
    };
  }

  // Fallback: legacy monolith seed files
  const {
    locations = [],
    enemies = {},
    items: baseItems = {},
    quests = [],
    shopItems = {},
    innCost = {},
    dungeonConfig = {},
    locationThreat = {},
  } = CONTENT_SEED;
  const {
    extraItems = {},
    recipes = [],
    materialDrops = {},
    bossRecipeDrops = {},
  } = CRAFTING_SEED;

  return {
    locations,
    enemies,
    items: { ...baseItems, ...extraItems },
    quests,
    shopItems,
    innCost,
    dungeonConfig,
    locationThreat,
    exploreEvents: {},
    recipes,
    materialDrops,
    bossRecipeDrops,
  };
}

let STATIC_FANTASY_CONTENT = buildStaticFantasyContent();
let DB_CONTENT = null;

function persistSeedFile(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function reloadSeedContent() {
  CONTENT_SEED = JSON.parse(fs.readFileSync(CONTENT_SEED_PATH, 'utf8'));
  CRAFTING_SEED = JSON.parse(fs.readFileSync(CRAFTING_SEED_PATH, 'utf8'));
  STATIC_FANTASY_CONTENT = buildStaticFantasyContent();
}

function getContent() {
  return DB_CONTENT || STATIC_FANTASY_CONTENT;
}

function parseJsonField(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch (_) { return fallback; }
  }
  return value;
}

function ensureArray(value, fieldName) {
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array.`);
  return value;
}

function ensureObject(value, fieldName) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${fieldName} must be an object.`);
  return value;
}

function upsertBySlug(list, entry) {
  const index = list.findIndex(item => item.slug === entry.slug);
  if (index === -1) list.push(entry);
  else list[index] = entry;
}

function applyContentMutation(kind, payload) {
  const body = ensureObject(payload, 'payload');
  switch (kind) {
    case 'item': {
      if (!body.slug) throw new Error('item.slug is required.');
      const target = body.seed === 'crafting' ? (CRAFTING_SEED.extraItems ||= {}) : (CONTENT_SEED.items ||= {});
      target[body.slug] = { ...body.data };
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      persistSeedFile(CRAFTING_SEED_PATH, CRAFTING_SEED);
      break;
    }
    case 'recipe': {
      if (!body.slug) throw new Error('recipe.slug is required.');
      const recipes = ensureArray(CRAFTING_SEED.recipes ||= [], 'recipes');
      upsertBySlug(recipes, { slug: body.slug, ...body.data });
      persistSeedFile(CRAFTING_SEED_PATH, CRAFTING_SEED);
      break;
    }
    case 'location': {
      if (!body.slug) throw new Error('location.slug is required.');
      const locations = ensureArray(CONTENT_SEED.locations ||= [], 'locations');
      upsertBySlug(locations, { slug: body.slug, ...body.data });
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      break;
    }
    case 'enemy': {
      if (!body.locationSlug) throw new Error('enemy.locationSlug is required.');
      if (!body.slug) throw new Error('enemy.slug is required.');
      const enemies = ensureObject(CONTENT_SEED.enemies ||= {}, 'enemies');
      enemies[body.locationSlug] ||= [];
      upsertBySlug(enemies[body.locationSlug], { slug: body.slug, ...body.data });
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      break;
    }
    case 'quest': {
      if (!body.slug) throw new Error('quest.slug is required.');
      const quests = ensureArray(CONTENT_SEED.quests ||= [], 'quests');
      upsertBySlug(quests, { slug: body.slug, ...body.data });
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      break;
    }
    case 'shop': {
      if (!body.locationSlug) throw new Error('shop.locationSlug is required.');
      CONTENT_SEED.shopItems ||= {};
      CONTENT_SEED.shopItems[body.locationSlug] = ensureArray(body.items || [], 'shop.items');
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      break;
    }
    case 'inn': {
      if (!body.locationSlug) throw new Error('inn.locationSlug is required.');
      if (typeof body.cost !== 'number') throw new Error('inn.cost must be a number.');
      CONTENT_SEED.innCost ||= {};
      CONTENT_SEED.innCost[body.locationSlug] = body.cost;
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      break;
    }
    case 'dungeon': {
      if (!body.locationSlug) throw new Error('dungeon.locationSlug is required.');
      CONTENT_SEED.dungeonConfig ||= {};
      CONTENT_SEED.dungeonConfig[body.locationSlug] = ensureObject(body.data, 'dungeon.data');
      persistSeedFile(CONTENT_SEED_PATH, CONTENT_SEED);
      break;
    }
    case 'material-drop': {
      if (!body.enemySlug) throw new Error('material-drop.enemySlug is required.');
      CRAFTING_SEED.materialDrops ||= {};
      CRAFTING_SEED.materialDrops[body.enemySlug] = ensureArray(body.drops || [], 'material-drop.drops');
      persistSeedFile(CRAFTING_SEED_PATH, CRAFTING_SEED);
      break;
    }
    case 'boss-recipe-drop': {
      if (!body.bossSlug) throw new Error('boss-recipe-drop.bossSlug is required.');
      CRAFTING_SEED.bossRecipeDrops ||= {};
      CRAFTING_SEED.bossRecipeDrops[body.bossSlug] = ensureArray(body.drops || [], 'boss-recipe-drop.drops');
      persistSeedFile(CRAFTING_SEED_PATH, CRAFTING_SEED);
      break;
    }
    default:
      throw new Error(`Unsupported content kind: ${kind}`);
  }
  reloadSeedContent();
}

async function syncFantasyContent(db) {
  await seedFantasyContentTables(db);
  await loadFantasyContent(db);
}

async function seedFantasyContentTables(db) {
  const staticContent = buildStaticFantasyContent();
  const { locations, items, enemies, quests, shopItems, innCost, dungeonConfig, locationThreat, recipes, materialDrops, bossRecipeDrops } = staticContent;

  for (const [index, loc] of locations.entries()) {
    await db.query(
      `INSERT INTO fantasy_content_locations (slug, sort_order, name, type, description, connections, threat)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         sort_order=EXCLUDED.sort_order,
         name=EXCLUDED.name,
         type=EXCLUDED.type,
         description=EXCLUDED.description,
         connections=EXCLUDED.connections,
         threat=EXCLUDED.threat`,
      [loc.slug, index, loc.name, loc.type, loc.description, JSON.stringify(loc.connections || []), locationThreat[loc.slug] || 1]
    );
  }

  for (const [index, [slug, item]] of Object.entries(items).entries()) {
    await db.query(
      `INSERT INTO fantasy_content_items (slug, sort_order, data) VALUES ($1, $2, $3)
       ON CONFLICT (slug) DO UPDATE SET sort_order=EXCLUDED.sort_order, data=EXCLUDED.data`,
      [slug, index, JSON.stringify(item)]
    );
  }

  let enemyOrder = 0;
  for (const [locationSlug, enemyList] of Object.entries(enemies)) {
    for (const enemy of enemyList) {
      await db.query(
        `INSERT INTO fantasy_content_enemies (slug, location_slug, sort_order, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (slug) DO UPDATE SET location_slug=EXCLUDED.location_slug, sort_order=EXCLUDED.sort_order, data=EXCLUDED.data`,
        [enemy.slug, locationSlug, enemyOrder++, JSON.stringify(enemy)]
      );
    }
  }

  for (const [index, quest] of quests.entries()) {
    await db.query(
      `INSERT INTO fantasy_content_quest_defs (slug, sort_order, location_slug, min_level, data) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET sort_order=EXCLUDED.sort_order, location_slug=EXCLUDED.location_slug, min_level=EXCLUDED.min_level, data=EXCLUDED.data`,
      [quest.slug, index, quest.location, quest.minLevel, JSON.stringify(quest)]
    );
  }

  // Sync shops using upsert + cleanup (no destructive DELETE ALL)
  const shopLocations = new Set(Object.keys(shopItems));
  for (const [locationSlug, itemSlugs] of Object.entries(shopItems)) {
    // Remove items no longer in this location's shop
    await db.query('DELETE FROM fantasy_content_shops WHERE location_slug = $1 AND item_slug != ALL($2::text[])', [locationSlug, itemSlugs]);
    for (const [sortOrder, itemSlug] of itemSlugs.entries()) {
      await db.query(
        `INSERT INTO fantasy_content_shops (location_slug, item_slug, sort_order) VALUES ($1, $2, $3)
         ON CONFLICT (location_slug, item_slug) DO UPDATE SET sort_order=EXCLUDED.sort_order`,
        [locationSlug, itemSlug, sortOrder]
      );
    }
  }
  // Remove shops for locations that no longer have shops
  if (shopLocations.size > 0) {
    await db.query('DELETE FROM fantasy_content_shops WHERE location_slug != ALL($1::text[])', [[...shopLocations]]);
  }

  for (const [locationSlug, cost] of Object.entries(innCost)) {
    await db.query(
      `INSERT INTO fantasy_content_inns (location_slug, cost) VALUES ($1, $2)
       ON CONFLICT (location_slug) DO UPDATE SET cost=EXCLUDED.cost`,
      [locationSlug, cost]
    );
  }

  for (const [locationSlug, config] of Object.entries(dungeonConfig)) {
    await db.query(
      `INSERT INTO fantasy_content_dungeons (location_slug, data) VALUES ($1, $2)
       ON CONFLICT (location_slug) DO UPDATE SET data=EXCLUDED.data`,
      [locationSlug, JSON.stringify(config)]
    );
  }

  for (const [index, recipe] of recipes.entries()) {
    await db.query(
      `INSERT INTO fantasy_content_recipes (slug, sort_order, unlock_level, output_item_slug, output_qty, requires_discovery, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         sort_order=EXCLUDED.sort_order,
         unlock_level=EXCLUDED.unlock_level,
         output_item_slug=EXCLUDED.output_item_slug,
         output_qty=EXCLUDED.output_qty,
         requires_discovery=EXCLUDED.requires_discovery,
         data=EXCLUDED.data`,
      [recipe.slug, index, recipe.unlockLevel || 1, recipe.outputItem, recipe.outputQty || 1, !!recipe.requiresDiscovery, JSON.stringify(recipe)]
    );
  }
  // Remove recipes no longer in content files
  if (recipes.length > 0) {
    const recipeSlugs = recipes.map(r => r.slug);
    await db.query('DELETE FROM fantasy_content_recipes WHERE slug != ALL($1)', [recipeSlugs]);
  }

  let materialOrder = 0;
  for (const [enemySlug, drops] of Object.entries(materialDrops)) {
    for (const drop of drops) {
      await db.query(
        `INSERT INTO fantasy_content_explore_materials (enemy_slug, item_slug, sort_order, chance, min_qty, max_qty)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (enemy_slug, item_slug) DO UPDATE SET
           sort_order=EXCLUDED.sort_order,
           chance=EXCLUDED.chance,
           min_qty=EXCLUDED.min_qty,
           max_qty=EXCLUDED.max_qty`,
        [enemySlug, drop.itemSlug, materialOrder++, drop.chance, drop.minQty || 1, drop.maxQty || drop.minQty || 1]
      );
    }
  }

  let bossDropOrder = 0;
  for (const [bossSlug, recipeDrops] of Object.entries(bossRecipeDrops)) {
    for (const drop of recipeDrops) {
      await db.query(
        `INSERT INTO fantasy_content_boss_recipe_drops (boss_slug, recipe_slug, sort_order, chance)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (boss_slug, recipe_slug) DO UPDATE SET sort_order=EXCLUDED.sort_order, chance=EXCLUDED.chance`,
        [bossSlug, drop.recipeSlug, bossDropOrder++, drop.chance]
      );
    }
  }
}

async function loadFantasyContent(db) {
  const [locationRes, itemRes, enemyRes, questRes, shopRes, innRes, dungeonRes, recipeRes, materialRes, bossRecipeRes] = await Promise.all([
    db.query('SELECT * FROM fantasy_content_locations ORDER BY sort_order, slug'),
    db.query('SELECT * FROM fantasy_content_items ORDER BY sort_order, slug'),
    db.query('SELECT * FROM fantasy_content_enemies ORDER BY location_slug, sort_order, slug'),
    db.query('SELECT * FROM fantasy_content_quest_defs ORDER BY sort_order, slug'),
    db.query('SELECT * FROM fantasy_content_shops ORDER BY location_slug, sort_order, item_slug'),
    db.query('SELECT * FROM fantasy_content_inns ORDER BY location_slug'),
    db.query('SELECT * FROM fantasy_content_dungeons ORDER BY location_slug'),
    db.query('SELECT * FROM fantasy_content_recipes ORDER BY sort_order, slug'),
    db.query('SELECT * FROM fantasy_content_explore_materials ORDER BY enemy_slug, sort_order, item_slug'),
    db.query('SELECT * FROM fantasy_content_boss_recipe_drops ORDER BY boss_slug, sort_order, recipe_slug'),
  ]);

  // Get map coordinates from static content (presentation-only, not stored in DB)
  const staticLocs = buildStaticFantasyContent().locations;
  const staticLocMap = {};
  for (const sl of staticLocs) staticLocMap[sl.slug] = sl;

  const locations = locationRes.rows.map(row => ({
    slug: row.slug,
    name: row.name,
    type: row.type,
    description: row.description,
    connections: parseJsonField(row.connections, []),
    mapX: staticLocMap[row.slug]?.mapX ?? null,
    mapY: staticLocMap[row.slug]?.mapY ?? null,
    realm: staticLocMap[row.slug]?.realm ?? 'ashlands',
  }));

  const locationThreat = {};
  for (const row of locationRes.rows) locationThreat[row.slug] = row.threat || 1;

  const items = {};
  for (const row of itemRes.rows) items[row.slug] = parseJsonField(row.data, {});

  const enemies = {};
  for (const row of enemyRes.rows) {
    if (!enemies[row.location_slug]) enemies[row.location_slug] = [];
    enemies[row.location_slug].push({ slug: row.slug, ...parseJsonField(row.data, {}) });
  }

  const quests = questRes.rows.map(row => ({ slug: row.slug, ...parseJsonField(row.data, {}) }));

  const shopItems = {};
  for (const row of shopRes.rows) {
    if (!shopItems[row.location_slug]) shopItems[row.location_slug] = [];
    shopItems[row.location_slug].push(row.item_slug);
  }

  const innCost = {};
  for (const row of innRes.rows) innCost[row.location_slug] = row.cost;

  const dungeonConfig = {};
  for (const row of dungeonRes.rows) dungeonConfig[row.location_slug] = parseJsonField(row.data, {});

  const recipes = recipeRes.rows.map(row => ({
    ...parseJsonField(row.data, {}),
    slug: row.slug,
    unlockLevel: row.unlock_level,
    outputItem: row.output_item_slug,
    outputQty: row.output_qty,
    requiresDiscovery: row.requires_discovery,
  }));

  const materialDrops = {};
  for (const row of materialRes.rows) {
    if (!materialDrops[row.enemy_slug]) materialDrops[row.enemy_slug] = [];
    materialDrops[row.enemy_slug].push({
      itemSlug: row.item_slug,
      chance: row.chance,
      minQty: row.min_qty,
      maxQty: row.max_qty,
    });
  }

  const bossRecipeDrops = {};
  for (const row of bossRecipeRes.rows) {
    if (!bossRecipeDrops[row.boss_slug]) bossRecipeDrops[row.boss_slug] = [];
    bossRecipeDrops[row.boss_slug].push({ recipeSlug: row.recipe_slug, chance: row.chance });
  }

  // exploreEvents and enemyGroups are file-only (not DB-synced), merge from static content
  const exploreEvents = STATIC_FANTASY_CONTENT.exploreEvents || {};
  const enemyGroups = STATIC_FANTASY_CONTENT.enemyGroups || {};
  const realms = STATIC_FANTASY_CONTENT.realms || [];
  DB_CONTENT = { locations, enemies, items, quests, shopItems, innCost, dungeonConfig, locationThreat, exploreEvents, enemyGroups, recipes, materialDrops, bossRecipeDrops, realms };
  return DB_CONTENT;
}

// ─── STATUS EFFECTS ──────────────────────────────────────────────
// Scalable status-effect definitions. Each effect has:
//   slug, name, icon, type (dot|debuff|buff|cc|hot), stackable,
//   and optional stat/damage/heal parameters.
// Enemy abilities reference these by slug.

const STATUS_EFFECTS = GAME_CONFIG.statusEffects;

// Enemy abilities: enemies reference these to inflict effects on the player.
// Format: { slug, name, chance (%), effect (slug), turns, damagePerTurn?, statMod?, ... }
// Enemies carry an `abilities` array in seed data; each ability is tried once per turn.
const ENEMY_ABILITIES = GAME_CONFIG.enemyAbilities;

// ── Status effect engine + combat formulas ──
// (Implementations in shared/game-logic.js, imported at top of file)

// ═══════════════════════════════════════════
//  PERK GENERATION SYSTEM
// ═══════════════════════════════════════════

// Perk generation, defense reduction, damage/regen passives, consumable use
// (Implementations in shared/game-logic.js, imported at top of file)

function cureEffect(effectsArray, effectSlug) {
  return removeEffect(effectsArray, effectSlug);
}

// ─── DURABILITY ──────────────────────────────────────────────────

const DURABILITY_BY_RARITY = GAME_CONFIG.durabilityByRarity;
const EQUIPMENT_SLOTS = GAME_CONFIG.equipmentSlots;

function getMaxDurability(itemSlug) {
  const item = getContent().items[itemSlug];
  if (!item) return 20;
  return DURABILITY_BY_RARITY[item.rarity] || 20;
}

// ─── HELPERS ─────────────────────────────────────────────────────

// rand — imported from shared/game-logic.js

// xpForLevel — imported from shared/game-logic.js

// computeStats, getEquipmentPassives, getEquipmentPerkBonuses, getCombatPassives
// (Implementations in shared/game-logic.js, imported at top of file)

function buildIngredientBook(allRecipes) {
  const ingredientMap = new Map();
  for (const recipe of allRecipes) {
    for (const ingredient of (recipe.ingredients || [])) {
      const item = getContent().items[ingredient.item] || {};
      if (!ingredientMap.has(ingredient.item)) {
        ingredientMap.set(ingredient.item, {
          slug: ingredient.item,
          name: item.name || ingredient.item,
          rarity: item.rarity || 'common',
          type: item.type || 'material',
          description: item.description || '',
          uses: [],
        });
      }
      ingredientMap.get(ingredient.item).uses.push({
        recipeSlug: recipe.slug,
        recipeName: recipe.name,
        recipeLevel: recipe.unlockLevel || 1,
        qty: ingredient.qty,
        known: recipe.known,
        unlocked: recipe.unlocked,
        unlockedByLevel: recipe.unlockedByLevel,
        requiresDiscovery: recipe.requiresDiscovery,
        category: recipe.category || 'other',
        output: recipe.output,
      });
    }
  }
  return [...ingredientMap.values()]
    .map(entry => ({ ...entry, uses: entry.uses.sort((a, b) => a.recipeLevel - b.recipeLevel || a.recipeName.localeCompare(b.recipeName)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function pickEncounterForLocation(location, charLevel, bountyTargets) {
  const locEnemies = getContent().enemies[location] || [];
  if (locEnemies.length === 0) return null;
  const targetLevel = Math.max(charLevel, (getContent().locationThreat || STATIC_FANTASY_CONTENT.locationThreat)[location] || 1);
  let pool = locEnemies.filter((enemy) => enemy.level >= Math.max(1, targetLevel - 2) && enemy.level <= targetLevel + 1);
  if (pool.length === 0) {
    pool = locEnemies.filter((enemy) => enemy.level <= targetLevel + 2);
  }
  if (pool.length === 0) pool = locEnemies;
  pool.sort((a, b) => a.level - b.level);
  const upperPool = pool.slice(Math.floor(pool.length / 2));
  const finalPool = upperPool.length > 0 ? upperPool : pool;

  // Bounty encounter boost: if the player has active bounties targeting enemies in this
  // location, give those enemies a ~40% chance of being picked instead of a random mob.
  // This makes bounty targets feel findable without guaranteeing every fight is the target.
  if (bountyTargets && bountyTargets.length > 0) {
    const bountyInPool = finalPool.filter(e => bountyTargets.includes(e.slug));
    if (bountyInPool.length > 0 && Math.random() < 0.40) {
      return bountyInPool[rand(0, bountyInPool.length - 1)];
    }
    // Also check the full location pool (bounty enemy might be outside level-filtered pool)
    const bountyInLoc = locEnemies.filter(e => bountyTargets.includes(e.slug));
    if (bountyInLoc.length > 0 && Math.random() < 0.25) {
      return bountyInLoc[rand(0, bountyInLoc.length - 1)];
    }
  }

  return finalPool[rand(0, finalPool.length - 1)];
}

function buildScaledEnemy(enemy, charLevel, location, { elite = false } = {}) {
  // No level-gap scaling — enemies use their base stats from zone files.
  // Base stats are balanced per-level via the rebalance formulas.
  // Only elite modifier applies (rare 5% spawn chance).
  const eliteHpMul = elite ? 1.8 : 1;
  const eliteAtkMul = elite ? 1.3 : 1;
  const eliteDefMul = elite ? 1.2 : 1;
  return {
    ...enemy,
    name: elite ? `${enemy.name}` : enemy.name,
    hp: Math.floor(enemy.hp * eliteHpMul),
    maxHp: Math.floor(enemy.hp * eliteHpMul),
    attack: Math.floor(enemy.attack * eliteAtkMul),
    defense: Math.floor(enemy.defense * eliteDefMul),
    elite: elite || false,
    buffs: [],
    dots: [],
    stunned: false,
    statusEffects: [],
    abilities: enemy.abilities || [],
  };
}

// ─── COMPANION HELPER ────────────────────────────────────────────

function buildCompanionAlly(char) {
  if (!char.companion) return null;
  const comp = char.companion;
  const def = GAME_CONFIG.companions[comp.type];
  if (!def) return null;
  const level = comp.level || 1;
  const statBonus = Math.floor((char[def.scaleStat] || 10) * 0.3);

  // Apply tier bonuses from companion evolution
  const specTier = comp.specTier || 1;
  const tierData = def.tiers?.[specTier - 1];
  const tierBonuses = tierData?.bonuses || {};
  const hpMul = tierBonuses.hpMul || 1;
  const atkMul = tierBonuses.atkMul || 1;
  const damageTakenMul = tierBonuses.damageTakenMul || 1;

  const baseHp = def.baseHp + (def.hpPerLevel * (level - 1)) + statBonus;
  const baseAtk = def.baseAttack + (def.attackPerLevel * (level - 1)) + Math.floor(statBonus * 0.5);
  const baseDef = def.baseDefense + (def.defensePerLevel * (level - 1));

  return {
    id: 'a0',
    name: tierBonuses.evolvedName || comp.name || def.name,
    icon: def.icon,
    type: comp.type,
    hp: Math.floor(baseHp * hpMul),
    maxHp: Math.floor(baseHp * hpMul),
    attack: Math.floor(baseAtk * atkMul),
    defense: baseDef,
    effects: [],
    level,
    activeAbility: comp.activeAbility || def.abilities[0]?.slug,
    cooldowns: {},
    companionData: true,
    // Tier bonus flags for combat engine
    specTier,
    tierBonuses,
    damageTakenMul,
    immortal: !!tierBonuses.immortal,
  };
}

// ─── DB INIT & QUERIES ──────────────────────────────────────────

async function initFantasyDb(db) {
  // Create tables and run migrations (extracted to db/schema.js)
  await createSchema(db);

  // Fix any existing equipment rows with 0 durability (legacy)
  try {
    const legacyEq = await db.query('SELECT * FROM fantasy_equipment WHERE durability <= 0');
    for (const row of legacyEq.rows) {
      const maxDur = getMaxDurability(row.item_slug);
      await db.query('UPDATE fantasy_equipment SET durability=$1 WHERE char_id=$2 AND slot=$3', [maxDur, row.char_id, row.slot]);
    }
  } catch (e) { /* ignore */ }

  // Retroactively recalculate HP for existing characters based on new baseHp values
  try {
    const chars = await db.query('SELECT id, class, level, hp, max_hp FROM fantasy_characters');
    for (const char of chars.rows) {
      const cls = CLASSES.find(c => c.slug === char.class);
      if (!cls) continue;
      const hpPerLevel = Math.floor(cls.baseHp / 4) + 3; // avg of rand(2,5) = 3.5 ≈ 3
      const expectedHp = cls.baseHp + (char.level - 1) * hpPerLevel;
      if (char.max_hp < expectedHp) {
        const hpDiff = expectedHp - char.max_hp;
        await db.query('UPDATE fantasy_characters SET max_hp=$1, hp=LEAST(hp+$2, $1) WHERE id=$3',
          [expectedHp, hpDiff, char.id]);
      }
    }
  } catch (e) { /* ignore */ }

  await syncFantasyContent(db);
}

// ─── ROUTE REGISTRATION ─────────────────────────────────────────

function registerFantasyRoutes(app, db, requireAuth, requireAdmin = requireAuth) {

  // Query helpers — accept optional txClient for transaction support.
  // When txClient is passed, queries run inside that transaction.
  // When omitted, queries run on the pool (backward compatible).
  async function q(sql, params = [], txClient = null) {
    const res = await (txClient || db).query(sql, params);
    return res.rows;
  }
  async function q1(sql, params = [], txClient = null) {
    const rows = await q(sql, params, txClient);
    return rows[0] || null;
  }

  async function getChar(userId, activeCharId) {
    // If we have an active char ID, use it (verify ownership)
    if (activeCharId) {
      return q1('SELECT * FROM fantasy_characters WHERE id = $1 AND user_id = $2', [activeCharId, userId]);
    }
    // Fallback: get the most recent character for this user
    return q1('SELECT * FROM fantasy_characters WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]);
  }

  async function getCharList(userId) {
    return q('SELECT id, name, race, class, level, hp, max_hp, mp, max_mp, gold, location FROM fantasy_characters WHERE user_id = $1 ORDER BY id', [userId]);
  }

  const MAX_ACTIVE_ABILITIES = GAME_CONFIG.maxActiveAbilities;

  function getCharAbilities(char) {
    const cls = CLASSES.find(c => c.slug === char.class);
    if (!cls) return { all: [], learned: [], active: [], activePvp: [], activeAbilities: [], racialAbility: null };
    const racialAbility = GAME_CONFIG.racialAbilities?.[char.race] || null;
    const starterSlugs = cls.abilities.filter(a => a.starter).map(a => a.slug);
    // Racial is separate — never in learned/active arrays, doesn't count toward loadout
    const learned = char.learned_abilities ? (typeof char.learned_abilities === 'string' ? JSON.parse(char.learned_abilities) : char.learned_abilities) : starterSlugs;
    const active = char.active_abilities ? (typeof char.active_abilities === 'string' ? JSON.parse(char.active_abilities) : char.active_abilities) : starterSlugs;
    // PvP loadout — falls back to PvE loadout if not set
    const activePvpRaw = char.active_abilities_pvp ? (typeof char.active_abilities_pvp === 'string' ? JSON.parse(char.active_abilities_pvp) : char.active_abilities_pvp) : null;
    const activePvp = activePvpRaw || active;
    // Raid loadout — falls back to PvE loadout if not set
    const activeRaidRaw = char.active_abilities_raid ? (typeof char.active_abilities_raid === 'string' ? JSON.parse(char.active_abilities_raid) : char.active_abilities_raid) : null;
    const activeRaid = activeRaidRaw || active;
    // Filter out racial from active/learned in case it was injected by old code
    const cleanLearned = learned.filter(s => s !== racialAbility?.slug);
    const cleanActive = active.filter(s => s !== racialAbility?.slug);
    const cleanActivePvp = activePvp.filter(s => s !== racialAbility?.slug);
    const cleanActiveRaid = activeRaid.filter(s => s !== racialAbility?.slug);
    // Resolve class abilities for the PvE loadout
    const activeAbilities = cleanActive.map(s => ABILITY_INDEX[s] || cls.abilities.find(a => a.slug === s)).filter(Boolean);
    // Append racial at the end — always present, outside the loadout
    if (racialAbility) activeAbilities.push(racialAbility);
    return {
      all: cls.abilities, // class abilities only (for Academy UI)
      learned: cleanLearned,
      active: cleanActive,       // PvE loadout slugs
      activePvp: cleanActivePvp, // PvP loadout slugs
      activeRaid: cleanActiveRaid, // Raid loadout slugs
      pvpCustomized: !!activePvpRaw, // whether PvP loadout was explicitly set
      raidCustomized: !!activeRaidRaw, // whether Raid loadout was explicitly set
      activeAbilities, // PvE class loadout + racial appended (used by combat engine)
      racialAbility,
    };
  }

  async function getInventory(charId) {
    return q('SELECT * FROM fantasy_inventory WHERE char_id = $1 ORDER BY item_slug', [charId]);
  }

  async function getEquipment(charId) {
    const rows = await q('SELECT * FROM fantasy_equipment WHERE char_id = $1', [charId]);
    const eq = {};
    for (const row of rows) {
      const base = getContent().items[row.item_slug] || {};
      const perks = row.perks ? (typeof row.perks === 'string' ? JSON.parse(row.perks) : row.perks) : null;
      const sockets = row.sockets ? (typeof row.sockets === 'string' ? JSON.parse(row.sockets) : row.sockets) : null;
      const item = {
        slot: row.slot,
        ...base,
        slug: row.item_slug,
        durability: row.durability,
        maxDurability: getMaxDurability(row.item_slug),
        perks,
        sockets,
        maxSockets: GAME_CONFIG.socketSlots?.[base.rarity] || 0,
      };
      if (perks && perks.length) {
        const prefix = getPerkPrefix(perks);
        if (prefix) item.name = prefix + ' ' + (base.name || row.item_slug);
      }
      eq[row.slot] = item;
    }
    return eq;
  }

  async function getActiveQuests(charId) {
    return q("SELECT * FROM fantasy_quests WHERE char_id = $1 AND status = 'active'", [charId]);
  }

  async function getCompletedQuests(charId) {
    return q("SELECT * FROM fantasy_quests WHERE char_id = $1 AND status = 'completed'", [charId]);
  }

  async function getLog(charId, limit = 100) {
    return q('SELECT * FROM fantasy_game_log WHERE char_id = $1 ORDER BY id DESC LIMIT $2', [charId, limit]);
  }

  let _logInsertCount = 0;
  const LOG_PRUNE_INTERVAL = 50; // prune every N inserts
  const LOG_MAX_PER_CHAR = 500;  // keep last N entries per character

  async function addLog(charId, tone, entry, txClient = null) {
    await (txClient || db).query('INSERT INTO fantasy_game_log (char_id, tone, entry) VALUES ($1, $2, $3)', [charId, tone, entry]);
    // Periodic pruning (only outside transactions to avoid locks)
    if (!txClient && ++_logInsertCount % LOG_PRUNE_INTERVAL === 0) {
      try {
        await db.query(
          `DELETE FROM fantasy_game_log WHERE id IN (
            SELECT id FROM fantasy_game_log WHERE char_id = $1
            ORDER BY id DESC OFFSET $2
          )`, [charId, LOG_MAX_PER_CHAR]
        );
      } catch (e) { /* non-critical, log pruning can fail silently */ }
    }
  }

  async function addItem(charId, itemSlug, qty = 1, perks = null, txClient = null) {
    const conn = txClient || db;
    if (perks) {
      // Perked items are always individual rows, never stacked
      await conn.query('INSERT INTO fantasy_inventory (char_id, item_slug, quantity, perks) VALUES ($1, $2, 1, $3)', [charId, itemSlug, JSON.stringify(perks)]);
      return;
    }
    const existing = await q1('SELECT * FROM fantasy_inventory WHERE char_id = $1 AND item_slug = $2 AND perks IS NULL', [charId, itemSlug], txClient);
    if (existing) {
      await conn.query('UPDATE fantasy_inventory SET quantity = quantity + $1 WHERE id = $2', [qty, existing.id]);
    } else {
      await conn.query('INSERT INTO fantasy_inventory (char_id, item_slug, quantity) VALUES ($1, $2, $3)', [charId, itemSlug, qty]);
    }
  }

  async function removeItem(charId, itemSlug, qty = 1, inventoryId = null, txClient = null) {
    const conn = txClient || db;
    // If a specific inventory row is targeted (perked items), use that
    if (inventoryId) {
      const row = await q1('SELECT * FROM fantasy_inventory WHERE id = $1 AND char_id = $2', [inventoryId, charId], txClient);
      if (!row) return false;
      await conn.query('DELETE FROM fantasy_inventory WHERE id = $1', [row.id]);
      return true;
    }
    // Otherwise remove from non-perked stack — atomic check + update
    const existing = await q1('SELECT * FROM fantasy_inventory WHERE char_id = $1 AND item_slug = $2 AND perks IS NULL', [charId, itemSlug], txClient);
    if (!existing || existing.quantity < qty) return false;
    if (existing.quantity <= qty) {
      // Delete only if quantity hasn't changed (atomic guard)
      const del = await conn.query('DELETE FROM fantasy_inventory WHERE id = $1 AND quantity <= $2 RETURNING id', [existing.id, qty]);
      if (del.rowCount === 0) return false;
    } else {
      // Subtract only if sufficient quantity remains (atomic guard)
      const upd = await conn.query('UPDATE fantasy_inventory SET quantity = quantity - $1 WHERE id = $2 AND quantity >= $1 RETURNING quantity', [qty, existing.id]);
      if (upd.rowCount === 0) return false;
    }
    return true;
  }

  async function getHomeStorage(charId) {
    return q('SELECT * FROM fantasy_home_storage WHERE char_id = $1 ORDER BY item_slug', [charId]);
  }

  async function addHomeItem(charId, itemSlug, qty = 1, txClient = null) {
    const conn = txClient || db;
    const existing = await q1('SELECT * FROM fantasy_home_storage WHERE char_id = $1 AND item_slug = $2', [charId, itemSlug], txClient);
    if (existing) {
      await conn.query('UPDATE fantasy_home_storage SET quantity = quantity + $1 WHERE char_id = $2 AND item_slug = $3', [qty, charId, itemSlug]);
    } else {
      await conn.query('INSERT INTO fantasy_home_storage (char_id, item_slug, quantity) VALUES ($1, $2, $3)', [charId, itemSlug, qty]);
    }
  }

  async function removeHomeItem(charId, itemSlug, qty = 1, txClient = null) {
    const conn = txClient || db;
    const existing = await q1('SELECT * FROM fantasy_home_storage WHERE char_id = $1 AND item_slug = $2', [charId, itemSlug], txClient);
    if (!existing || existing.quantity < qty) return false;
    if (existing.quantity <= qty) {
      await conn.query('DELETE FROM fantasy_home_storage WHERE char_id = $1 AND item_slug = $2', [charId, itemSlug]);
    } else {
      await conn.query('UPDATE fantasy_home_storage SET quantity = quantity - $1 WHERE char_id = $2 AND item_slug = $3', [qty, charId, itemSlug]);
    }
    return true;
  }

  // ── Account Vault (shared across all characters for one user) ──
  const VAULT_CAPACITY = 20;

  async function getVault(userId) {
    return q('SELECT * FROM fantasy_account_vault WHERE user_id = $1 ORDER BY created_at', [userId]);
  }

  async function addVaultItem(userId, itemSlug, qty = 1, perks = null, txClient = null) {
    const conn = txClient || db;
    if (perks) {
      await conn.query('INSERT INTO fantasy_account_vault (user_id, item_slug, quantity, perks) VALUES ($1, $2, 1, $3)', [userId, itemSlug, JSON.stringify(perks)]);
      return;
    }
    const existing = await q1('SELECT * FROM fantasy_account_vault WHERE user_id = $1 AND item_slug = $2 AND perks IS NULL', [userId, itemSlug], txClient);
    if (existing) {
      await conn.query('UPDATE fantasy_account_vault SET quantity = quantity + $1 WHERE id = $2', [qty, existing.id]);
    } else {
      await conn.query('INSERT INTO fantasy_account_vault (user_id, item_slug, quantity) VALUES ($1, $2, $3)', [userId, itemSlug, qty]);
    }
  }

  async function removeVaultItem(userId, itemSlug, qty = 1, vaultId = null, txClient = null) {
    const conn = txClient || db;
    if (vaultId) {
      const row = await q1('SELECT * FROM fantasy_account_vault WHERE id = $1 AND user_id = $2', [vaultId, userId], txClient);
      if (!row) return false;
      await conn.query('DELETE FROM fantasy_account_vault WHERE id = $1', [row.id]);
      return true;
    }
    const existing = await q1('SELECT * FROM fantasy_account_vault WHERE user_id = $1 AND item_slug = $2 AND perks IS NULL', [userId, itemSlug], txClient);
    if (!existing || existing.quantity < qty) return false;
    if (existing.quantity <= qty) {
      await conn.query('DELETE FROM fantasy_account_vault WHERE id = $1', [existing.id]);
    } else {
      await conn.query('UPDATE fantasy_account_vault SET quantity = quantity - $1 WHERE id = $2', [qty, existing.id]);
    }
    return true;
  }

  async function getKnownRecipes(charId) {
    return q('SELECT * FROM fantasy_known_recipes WHERE char_id = $1 ORDER BY learned_at, recipe_slug', [charId]);
  }

  function enrichItemStacks(rows) {
    return rows.map(row => {
      const base = getContent().items[row.item_slug] || {};
      const perks = row.perks ? (typeof row.perks === 'string' ? JSON.parse(row.perks) : row.perks) : null;
      const result = { ...row, ...base, slug: row.item_slug, perks };
      if (perks && perks.length) {
        const prefix = getPerkPrefix(perks);
        if (prefix) result.name = prefix + ' ' + (base.name || row.item_slug);
        result.inventoryId = row.id; // unique ID for perked items
      }
      return result;
    });
  }

  function getRecipeBySlug(recipeSlug) {
    return (getContent().recipes || []).find(recipe => recipe.slug === recipeSlug) || null;
  }

  function buildItemCountMap(rows) {
    const counts = {};
    for (const row of rows) counts[row.item_slug] = (counts[row.item_slug] || 0) + row.quantity;
    return counts;
  }

  function getQuestStorageBonus(completedQuestCount) {
    return Math.floor((completedQuestCount || 0) / 3) * 5;
  }

  function getHomeStorageCapacity(char, completedQuestCount = 0) {
    return 25 + ((char.home_storage_bonus || 0) * 10) + getQuestStorageBonus(completedQuestCount);
  }

  function getHomeStorageUpgradeCost(char) {
    return 60 + ((char.home_storage_bonus || 0) * 45);
  }

  function getRecipeScrollItemSlug(recipeSlug) {
    const match = Object.entries(getContent().bossRecipeDrops || {}).flatMap(([, drops]) => drops).find(drop => drop.recipeSlug === recipeSlug);
    return match?.scrollItem || null;
  }

  function isRecipeUnlockedForChar(recipe, char, knownRecipeSet) {
    if (!recipe) return false;
    if (char.level < (recipe.unlockLevel || 1)) return false;
    if (recipe.requiresDiscovery && !knownRecipeSet.has(recipe.slug)) return false;
    return true;
  }

  async function unlockRecipe(charId, recipeSlug, source = 'discovery') {
    const existing = await q1('SELECT * FROM fantasy_known_recipes WHERE char_id = $1 AND recipe_slug = $2', [charId, recipeSlug]);
    if (existing) return false;
    await db.query('INSERT INTO fantasy_known_recipes (char_id, recipe_slug, source) VALUES ($1, $2, $3)', [charId, recipeSlug, source]);
    return true;
  }

  async function consumeCraftingIngredients(charId, ingredients, txClient = null) {
    const [inventoryRows, storageRows] = await Promise.all([getInventory(charId), getHomeStorage(charId)]);
    const inventoryCounts = buildItemCountMap(inventoryRows);
    const storageCounts = buildItemCountMap(storageRows);
    for (const ingredient of ingredients) {
      const total = (inventoryCounts[ingredient.item] || 0) + (storageCounts[ingredient.item] || 0);
      if (total < ingredient.qty) return false;
    }
    for (const ingredient of ingredients) {
      let remaining = ingredient.qty;
      const fromStorage = Math.min(storageCounts[ingredient.item] || 0, remaining);
      if (fromStorage > 0) {
        await removeHomeItem(charId, ingredient.item, fromStorage, txClient);
        remaining -= fromStorage;
      }
      if (remaining > 0) {
        await removeItem(charId, ingredient.item, remaining, null, txClient);
      }
    }
    return true;
  }

  function buildRecipeState(recipe, char, inventoryRows, storageRows, knownRecipeSet) {
    const output = getContent().items[recipe.outputItem] || {};
    const inventoryCounts = buildItemCountMap(inventoryRows);
    const storageCounts = buildItemCountMap(storageRows);
    const ingredients = (recipe.ingredients || []).map(ingredient => {
      const inPack = inventoryCounts[ingredient.item] || 0;
      const inStorage = storageCounts[ingredient.item] || 0;
      const total = inPack + inStorage;
      const item = getContent().items[ingredient.item] || {};
      return {
        ...ingredient,
        name: item.name || ingredient.item,
        rarity: item.rarity || 'common',
        inPack,
        inStorage,
        total,
        met: total >= ingredient.qty,
      };
    });
    const known = knownRecipeSet.has(recipe.slug);
    const unlockedByLevel = char.level >= (recipe.unlockLevel || 1);
    const unlocked = isRecipeUnlockedForChar(recipe, char, knownRecipeSet);
    const maxCraftable = ingredients.length ? Math.min(...ingredients.map(ingredient => Math.floor(ingredient.total / ingredient.qty))) : 0;
    const canCraft = unlocked && maxCraftable > 0;
    return {
      ...recipe,
      output: { slug: recipe.outputItem, ...output },
      known,
      unlockedByLevel,
      unlocked,
      canCraft,
      maxCraftable,
      ingredients,
    };
  }

  async function awardExploreMaterials(charId, enemy, log, options = {}, txClient = null) {
    if (options.questCombat) return;
    const drops = (getContent().materialDrops || {})[enemy.slug] || [];
    for (const drop of drops) {
      if (rand(1, 100) > (drop.chance || 100)) continue;
      const qty = rand(drop.minQty || 1, drop.maxQty || drop.minQty || 1);
      await addItem(charId, drop.itemSlug, qty, null, txClient);
      const item = getContent().items[drop.itemSlug];
      log.push(`🌿 Materials: ${item?.name || drop.itemSlug} ×${qty}`);
    }
  }

  async function awardBossRecipe(charId, enemy, log, txClient = null) {
    if (!enemy?.boss) return;
    const options = ((getContent().bossRecipeDrops || {})[enemy.slug] || []).slice();
    if (!options.length) return;
    const [knownRows, inventoryRows, storageRows] = await Promise.all([getKnownRecipes(charId), getInventory(charId), getHomeStorage(charId)]);
    const known = new Set(knownRows.map(row => row.recipe_slug));
    const owned = new Set([...inventoryRows, ...storageRows].map(row => row.item_slug));
    for (const drop of options) {
      const scrollItem = drop.scrollItem || getRecipeScrollItemSlug(drop.recipeSlug);
      if (known.has(drop.recipeSlug) || (scrollItem && owned.has(scrollItem))) continue;
      if (rand(1, 100) > (drop.chance || 10)) continue;
      if (scrollItem) {
        await addItem(charId, scrollItem, 1, null, txClient);
        const item = getContent().items[scrollItem];
        log.push(`📜 Recipe scroll found: ${item?.name || scrollItem}. Learn it at home to unlock a legendary craft.`);
      } else {
        const unlocked = await unlockRecipe(charId, drop.recipeSlug, `boss:${enemy.slug}`);
        if (!unlocked) continue;
        const recipe = getRecipeBySlug(drop.recipeSlug);
        log.push(`📜 Legendary recipe found: ${recipe?.name || drop.recipeSlug}. Craft it at your home in Thornwall.`);
      }
      break;
    }
  }

  async function checkLevelUp(char, txClient = null) {
    const conn = txClient || db;
    let leveled = false;
    const messages = [];
    while (char.xp >= xpForLevel(char.level)) {
      char.level++;
      leveled = true;
      const cls = CLASSES.find(c => c.slug === char.class);
      const hpGain = Math.floor((cls?.baseHp || 45) / 4) + rand(2, 5);
      const mpGain = Math.floor((cls?.baseMp || 10) / 6) + rand(0, 2);
      char.max_hp += hpGain;
      char.max_mp += mpGain;
      char.hp = char.max_hp;
      char.mp = char.max_mp;
      const message = `⬆ LEVEL UP! You are now level ${char.level}. +${hpGain} Max HP, +${mpGain} Max MP.`;
      messages.push(message);
      await addLog(char.id, 'level', message, txClient);
      await gameEvents.emit('level-up', { charId: char.id, oldLevel: char.level - 1, newLevel: char.level });
    }
    if (leveled) {
      await conn.query('UPDATE fantasy_characters SET level=$1, xp=$2, hp=$3, max_hp=$4, mp=$5, max_mp=$6 WHERE id=$7',
        [char.level, char.xp, char.hp, char.max_hp, char.mp, char.max_mp, char.id]);
    }
    return { leveled, messages };
  }

  // Check whether exploration is gated by quests at this location
  async function isExploreGated(charId, location, charLevel) {
    const loc = getContent().locations.find(l => l.slug === location);
    // Only gate wild locations — dungeons use the dungeon system, towns have no combat
    if (!loc || loc.type !== 'wild') return false;

    const completedQuests = await getCompletedQuests(charId);
    const activeQuests = await getActiveQuests(charId);
    const completedHere = completedQuests.filter(q => {
      const def = getContent().quests.find(quest => quest.slug === q.quest_slug);
      return def?.location === location;
    });
    const activeHere = activeQuests.filter(q => {
      const def = getContent().quests.find(quest => quest.slug === q.quest_slug);
      return def?.location === location;
    });
    const availableHere = getContent().quests.filter(q => {
      if (q.location !== location) return false;
      if (q.minLevel > charLevel) return false;
      const done = completedQuests.find(cq => cq.quest_slug === q.slug);
      const active = activeQuests.find(aq => aq.quest_slug === q.slug);
      return !done && !active;
    });

    // Early story guidance: require players to engage with the first couple of quests,
    // then open the wilds for free exploration while remaining quests stay optional.
    if (completedHere.length >= 2) return false;
    return activeHere.length > 0 || availableHere.length > 0;
  }

  async function buildState(userId, activeCharId) {
    const charList = await getCharList(userId);
    const char = await getChar(userId, activeCharId);
    if (!char) return { hasCharacter: false, races: RACES, classes: CLASSES, charList, maxChars: 10 };

    // ── Stale party cleanup ──
    // If character has party_id but the party is disbanded/gone, clear it
    let partyRow = null;
    if (char.party_id) {
      partyRow = await q1("SELECT id, state, raid_state, combat_state FROM fantasy_parties WHERE id = $1", [char.party_id]);
      if (!partyRow || partyRow.state === 'disbanded') {
        await db.query('UPDATE fantasy_characters SET party_id = NULL, raid_state = NULL WHERE id = $1', [char.id]);
        char.party_id = null;
        char.raid_state = null;
        partyRow = null;
      }
    }
    // Clean stale party raid stubs from character (legacy cleanup)
    if (char.raid_state?.partyRaid) {
      await db.query('UPDATE fantasy_characters SET raid_state = NULL WHERE id = $1', [char.id]);
      char.raid_state = null;
    }
    const equipment = await getEquipment(char.id);
    const stats = computeStats(char, equipment);
    const [invRows, storageRows, activeQuests, completedQuests, log, knownRecipesRows] = await Promise.all([
      getInventory(char.id),
      getHomeStorage(char.id),
      getActiveQuests(char.id),
      getCompletedQuests(char.id),
      getLog(char.id),
      getKnownRecipes(char.id),
    ]);
    const inventory = enrichItemStacks(invRows);
    const homeStorage = enrichItemStacks(storageRows);
    const knownRecipeSet = new Set(knownRecipesRows.map(row => row.recipe_slug));

    const loc = getContent().locations.find(l => l.slug === char.location);
    const connections = loc ? loc.connections.map(c => getContent().locations.find(l => l.slug === c)).filter(Boolean) : [];
    const shop = getContent().shopItems[char.location] ? getContent().shopItems[char.location].map(slug => ({ slug, ...getContent().items[slug] })) : null;
    const inn = getContent().innCost[char.location] || null;
    const availableQuests = getContent().quests.filter(quest => {
      if (quest.minLevel > char.level) return false;
      if (quest.location !== char.location) return false;
      const done = completedQuests.find(q => q.quest_slug === quest.slug);
      const active = activeQuests.find(q => q.quest_slug === quest.slug);
      if (done || active) return false;
      return true;
    });

    const enrichedQuests = activeQuests.map(aq => {
      const def = getContent().quests.find(q => q.slug === aq.quest_slug);
      if (!def) return aq;
      const stage = def.stages[aq.stage];
      return { ...aq, title: def.title, description: def.description, stage_data: stage };
    });

    const exploreGated = await isExploreGated(char.id, char.location, char.level);
    const isDungeon = loc?.type === 'dungeon';
    const dungeonConfig = isDungeon ? getContent().dungeonConfig[char.location] : null;
    const dungeonState = char.dungeon_state || null;
    const inDungeonRun = dungeonState && dungeonState.dungeon === char.location;
    const isAtHome = char.location === HOME_LOCATION;
    const canCraftHere = hasCraftingAccess(char.location);
    const allRecipes = (getContent().recipes || []).map(recipe => buildRecipeState(recipe, char, invRows, storageRows, knownRecipeSet));
    const visibleRecipes = allRecipes.filter(recipe => recipe.unlocked);
    const recipeBook = allRecipes;
    const ingredientBook = buildIngredientBook(allRecipes);
    const storageUsed = homeStorage.reduce((sum, item) => sum + item.quantity, 0);
    const storageCapacity = getHomeStorageCapacity(char, completedQuests.length);
    const recipeScrolls = inventory.filter(item => item.type === 'recipe');

    // Fetch active (accepted, unclaimed) bounties targeting this location for UI hints
    const activeBountiesHere = char.guild_registered ? (await q(
      `SELECT b.enemy_slug, b.enemy_name, bp.kills, b.kill_target, b.tier
       FROM fantasy_bounty_progress bp
       JOIN fantasy_bounties b ON b.id = bp.bounty_id
       WHERE bp.char_id = $1 AND bp.claimed = FALSE AND b.area_slug = $2`,
      [char.id, char.location]
    )).map(r => ({ enemySlug: r.enemy_slug, enemyName: r.enemy_name, kills: r.kills, killTarget: r.kill_target, tier: r.tier })) : [];

    // All active bounties across all locations (for map + location info panel)
    const allActiveBounties = char.guild_registered ? (await q(
      `SELECT b.enemy_slug, b.enemy_name, bp.kills, b.kill_target, b.tier, b.area_slug, b.area_name
       FROM fantasy_bounty_progress bp
       JOIN fantasy_bounties b ON b.id = bp.bounty_id
       WHERE bp.char_id = $1 AND bp.claimed = FALSE AND bp.completed = FALSE`,
      [char.id]
    )).map(r => ({ enemySlug: r.enemy_slug, enemyName: r.enemy_name, kills: r.kills, killTarget: r.kill_target, tier: r.tier, areaSlug: r.area_slug, areaName: r.area_name })) : [];

    return {
      hasCharacter: true,
      character: {
        ...char,
        combat_state: char.combat_state || null,
      },
      stats,
      equipment,
      inventory,
      homeStorage,
      activeQuests: enrichedQuests,
      completedQuests,
      availableQuests,
      log,
      location: loc,
      connections,
      shop,
      inn,
      xpNeeded: xpForLevel(char.level),
      abilities: getCharAbilities(char),
      locations: getContent().locations,
      exploreGated,
      isDungeon,
      dungeonConfig,
      dungeonState: inDungeonRun ? dungeonState : null,
      // Exploration event state
      activeEvent: (() => {
        const es = char.event_state;
        if (!es || es.location !== char.location) return null;
        const events = getContent().exploreEvents?.[char.location] || [];
        const eventDef = events.find(e => e.slug === es.slug);
        if (!eventDef) return null;
        return { ...eventDef, resolved: es.resolved || false, outcome: es.outcome || null };
      })(),
      vault: await (async () => {
        const vaultRows = await getVault(userId);
        const vaultItems = enrichItemStacks(vaultRows.map(r => ({ ...r, char_id: null, item_slug: r.item_slug, id: r.id })));
        const vaultUsed = vaultRows.reduce((s, r) => s + r.quantity, 0);
        return { items: vaultItems, used: vaultUsed, capacity: VAULT_CAPACITY };
      })(),
      home: {
        locationSlug: HOME_LOCATION,
        isAtHome,
        canCraftHere,
        storage: homeStorage,
        storageUsed,
        storageCapacity,
        storageRemaining: Math.max(0, storageCapacity - storageUsed),
        upgradeCost: getHomeStorageUpgradeCost(char),
        questStorageBonus: getQuestStorageBonus(completedQuests.length),
        goldStorageBonus: (char.home_storage_bonus || 0) * 10,
        knownRecipeSlugs: [...knownRecipeSet],
        recipeScrolls,
        recipes: visibleRecipes,
        recipeBook,
        ingredientBook,
      },
      charList,
      maxChars: 10,
      guild: {
        registered: !!char.guild_registered,
        rank: char.guild_rank || 0,
        xp: char.guild_xp || 0,
        marks: char.guild_marks || 0,
        rankInfo: getGuildRankInfo(char.guild_xp || 0),
        registrationCost: GUILD_REGISTRATION_COST,
        hasBountyBoard: !!BOUNTY_CONFIG[char.location],
        activeBountiesHere: activeBountiesHere,
        allActiveBounties: allActiveBounties,
      },
      hasAuctionHouse: loc?.type === 'town',
      hasArena: loc?.type === 'town',
      hasRaidTower: (getContent().realms || []).some(r => r.raidTown === char.location),
      hasClassTrainer: hasCraftingAccess(char.location),
      arenaState: char.arena_state || null,
      raidState: (char.party_id && partyRow?.state === 'in_raid') ? partyRow.raid_state : (char.raid_state || null),
      partyCombat: (char.party_id && partyRow?.state === 'in_raid') ? partyRow.combat_state : null,
      partyId: char.party_id || null,
      arenaBestWave: ((await q('SELECT MAX(wave_reached) as best FROM fantasy_arena_runs WHERE char_id = $1', [char.id]))[0]?.best) || 0,
      locationThreat: getContent().locationThreat || {},
      currentRealm: loc?.realm || 'ashlands',
      unlockedRealms: char.unlocked_realms || ['ashlands'],
    };
  }

  // ─── PARTIAL STATE BUILDER (2A.8 optimization) ─────────────
  // Returns only the requested state fields, avoiding unnecessary DB queries.
  // Fields: 'character', 'stats', 'equipment', 'inventory', 'log', 'abilities',
  //         'location', 'home', 'quests', 'guild'
  async function buildPatch(userId, activeCharId, fields) {
    const char = await getChar(userId, activeCharId);
    if (!char) return { hasCharacter: false };
    const fieldSet = new Set(fields);
    const patch = { hasCharacter: true };

    // Character is almost always needed
    if (fieldSet.has('character')) {
      patch.character = { ...char, combat_state: char.combat_state || null };
      patch.xpNeeded = xpForLevel(char.level);
      patch.arenaState = char.arena_state || null;
      if (char.party_id) {
        const pp = await q1("SELECT raid_state, combat_state, state FROM fantasy_parties WHERE id=$1", [char.party_id]);
        patch.raidState = (pp?.state === 'in_raid') ? pp.raid_state : null;
        patch.partyCombat = (pp?.state === 'in_raid') ? pp.combat_state : null;
      } else {
        patch.raidState = char.raid_state || null;
      }
      patch.arenaBestWave = ((await q('SELECT MAX(wave_reached) as best FROM fantasy_arena_runs WHERE char_id = $1', [char.id]))[0]?.best) || 0;
    }

    // Equipment — also needed for stats
    let equipment = null;
    if (fieldSet.has('equipment') || fieldSet.has('stats')) {
      equipment = await getEquipment(char.id);
      if (fieldSet.has('equipment')) patch.equipment = equipment;
      if (fieldSet.has('stats')) patch.stats = computeStats(char, equipment);
    }

    if (fieldSet.has('inventory')) {
      const invRows = await getInventory(char.id);
      patch.inventory = enrichItemStacks(invRows);
    }

    if (fieldSet.has('log')) {
      patch.log = await getLog(char.id);
    }

    if (fieldSet.has('abilities')) {
      patch.abilities = getCharAbilities(char);
    }

    if (fieldSet.has('location')) {
      const loc = getContent().locations.find(l => l.slug === char.location);
      const connections = loc ? loc.connections.map(c => getContent().locations.find(l => l.slug === c)).filter(Boolean) : [];
      patch.location = loc;
      patch.connections = connections;
      patch.shop = getContent().shopItems[char.location] ? getContent().shopItems[char.location].map(slug => ({ slug, ...getContent().items[slug] })) : null;
      patch.inn = getContent().innCost[char.location] || null;
      const isDungeon = loc?.type === 'dungeon';
      patch.isDungeon = isDungeon;
      patch.dungeonConfig = isDungeon ? getContent().dungeonConfig[char.location] : null;
      patch.dungeonState = (char.dungeon_state && char.dungeon_state.dungeon === char.location) ? char.dungeon_state : null;
      patch.activeEvent = (() => {
        const es = char.event_state;
        if (!es || es.location !== char.location) return null;
        const events = getContent().exploreEvents?.[char.location] || [];
        const eventDef = events.find(e => e.slug === es.slug);
        if (!eventDef) return null;
        return { ...eventDef, resolved: es.resolved || false, outcome: es.outcome || null };
      })();
      patch.exploreGated = await isExploreGated(char.id, char.location, char.level);
      patch.hasAuctionHouse = loc?.type === 'town';
      patch.hasArena = loc?.type === 'town';
      patch.hasRaidTower = (getContent().realms || []).some(r => r.raidTown === char.location);
      patch.hasClassTrainer = hasCraftingAccess(char.location);
      patch.locationThreat = getContent().locationThreat || {};
      patch.locations = getContent().locations;
    }

    if (fieldSet.has('quests')) {
      const [activeQuests, completedQuests] = await Promise.all([getActiveQuests(char.id), getCompletedQuests(char.id)]);
      patch.activeQuests = activeQuests.map(aq => {
        const def = getContent().quests.find(q => q.slug === aq.quest_slug);
        if (!def) return aq;
        const stage = def.stages[aq.stage];
        return { ...aq, title: def.title, description: def.description, stage_data: stage };
      });
      patch.completedQuests = completedQuests;
      patch.availableQuests = getContent().quests.filter(quest => {
        if (quest.minLevel > char.level) return false;
        if (quest.location !== char.location) return false;
        return !completedQuests.find(q => q.quest_slug === quest.slug) && !activeQuests.find(q => q.quest_slug === quest.slug);
      });
    }

    if (fieldSet.has('home')) {
      const [storageRows, completedQuests, knownRecipesRows, invRows] = await Promise.all([
        getHomeStorage(char.id), getCompletedQuests(char.id), getKnownRecipes(char.id), getInventory(char.id),
      ]);
      const homeStorage = enrichItemStacks(storageRows);
      const knownRecipeSet = new Set(knownRecipesRows.map(row => row.recipe_slug));
      const allRecipes = (getContent().recipes || []).map(recipe => buildRecipeState(recipe, char, invRows, storageRows, knownRecipeSet));
      const storageUsed = homeStorage.reduce((sum, item) => sum + item.quantity, 0);
      const storageCapacity = getHomeStorageCapacity(char, completedQuests.length);
      const inventory = enrichItemStacks(invRows);
      patch.homeStorage = homeStorage;
      patch.home = {
        locationSlug: HOME_LOCATION,
        isAtHome: char.location === HOME_LOCATION,
        canCraftHere: hasCraftingAccess(char.location),
        storage: homeStorage,
        storageUsed,
        storageCapacity,
        storageRemaining: Math.max(0, storageCapacity - storageUsed),
        upgradeCost: getHomeStorageUpgradeCost(char),
        questStorageBonus: getQuestStorageBonus(completedQuests.length),
        goldStorageBonus: (char.home_storage_bonus || 0) * 10,
        knownRecipeSlugs: [...knownRecipeSet],
        recipeScrolls: inventory.filter(item => item.type === 'recipe'),
        recipes: allRecipes.filter(r => r.unlocked),
        recipeBook: allRecipes,
        ingredientBook: buildIngredientBook(allRecipes),
      };
      // Also include vault when home is requested
      const vaultRows = await getVault(userId);
      const vaultItems = enrichItemStacks(vaultRows.map(r => ({ ...r, char_id: null, item_slug: r.item_slug, id: r.id })));
      const vaultUsed = vaultRows.reduce((s, r) => s + r.quantity, 0);
      patch.vault = { items: vaultItems, used: vaultUsed, capacity: VAULT_CAPACITY };
    }

    if (fieldSet.has('guild')) {
      const activeBountiesHere = char.guild_registered ? (await q(
        `SELECT b.enemy_slug, b.enemy_name, bp.kills, b.kill_target, b.tier
         FROM fantasy_bounty_progress bp JOIN fantasy_bounties b ON b.id = bp.bounty_id
         WHERE bp.char_id = $1 AND bp.claimed = FALSE AND b.area_slug = $2`, [char.id, char.location]
      )).map(r => ({ enemySlug: r.enemy_slug, enemyName: r.enemy_name, kills: r.kills, killTarget: r.kill_target, tier: r.tier })) : [];
      const allActiveBounties = char.guild_registered ? (await q(
        `SELECT b.enemy_slug, b.enemy_name, bp.kills, b.kill_target, b.tier, b.area_slug, b.area_name
         FROM fantasy_bounty_progress bp JOIN fantasy_bounties b ON b.id = bp.bounty_id
         WHERE bp.char_id = $1 AND bp.claimed = FALSE AND bp.completed = FALSE`, [char.id]
      )).map(r => ({ enemySlug: r.enemy_slug, enemyName: r.enemy_name, kills: r.kills, killTarget: r.kill_target, tier: r.tier, areaSlug: r.area_slug, areaName: r.area_name })) : [];
      patch.guild = {
        registered: !!char.guild_registered, rank: char.guild_rank || 0, xp: char.guild_xp || 0,
        marks: char.guild_marks || 0, rankInfo: getGuildRankInfo(char.guild_xp || 0),
        registrationCost: GUILD_REGISTRATION_COST, hasBountyBoard: !!BOUNTY_CONFIG[char.location],
        activeBountiesHere, allActiveBounties,
      };
    }

    return patch;
  }

  async function getLeaderboardCharacters(limit = 10) {
    const chars = await q(
      'SELECT * FROM fantasy_characters ORDER BY level DESC, xp DESC, gold DESC, id ASC LIMIT $1',
      [limit]
    );

    return Promise.all(chars.map(async (char) => {
      const equipment = await getEquipment(char.id);
      const stats = computeStats(char, equipment);
      const abils = getCharAbilities(char);
      return {
        name: char.name,
        level: char.level,
        xp: char.xp,
        xpNeeded: xpForLevel(char.level),
        gold: char.gold,
        race: char.race,
        class: char.class,
        hp: char.hp, maxHp: char.max_hp,
        mp: char.mp, maxMp: char.max_mp,
        guildRegistered: !!char.guild_registered,
        guildRank: char.guild_registered ? (getGuildRankInfo(char.guild_xp || 0).name) : null,
        guildXp: char.guild_xp || 0,
        guildMarks: char.guild_marks || 0,
        arcaneTokens: char.arcane_tokens || 0,
        abilityRanks: char.ability_ranks || {},
        dodgePct: calcDodgeChance(stats.dex),
        critPct: calcCritChance(stats.cha),
        stats,
        gear: Object.fromEntries(EQUIPMENT_SLOTS.map(slot => {
          const item = equipment[slot];
          if (!item) return [slot, null];
          return [slot, { name: item.name, rarity: item.rarity, stats: item.stats, perks: item.perks, durability: item.durability, maxDurability: item.maxDurability }];
        })),
        activeAbilities: abils.activeAbilities.map(a => ({ name: a.name, type: a.type, cost: a.cost })),
        knownRecipeCount: (await q('SELECT COUNT(*)::int as cnt FROM fantasy_known_recipes WHERE char_id = $1', [char.id]))[0]?.cnt || 0,
        location: char.location,
        arenaPoints: char.arena_points || 0,
        arenaBestWave: ((await q('SELECT MAX(wave_reached) as best FROM fantasy_arena_runs WHERE char_id = $1', [char.id]))[0]?.best) || 0,
      };
    }));
  }

  // ─── API ROUTES ──────────────────────────────────────────────

  app.get('/fantasy-rpg', (req, res) => {
    if (!req.session.userId) return res.redirect('/');
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(path.join(__dirname, 'public', 'fantasy-rpg.html'));
  });

  app.get('/leaderboard', (_req, res) => {
    return res.sendFile(path.join(__dirname, 'public', 'leaderboard.html'));
  });

  app.get('/api/fantasy/leaderboard', async (_req, res) => {
    try {
      const characters = await getLeaderboardCharacters(5);
      return res.json({ ok: true, characters });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Failed to load leaderboard.' });
    }
  });

  // Tutorial completion reward
  app.post('/api/fantasy/tutorial/complete', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      // Prevent double-claiming
      const meta = parseJsonField(char.daily_login, {});
      if (meta.tutorialDone) return res.json({ ok: true, alreadyClaimed: true });
      meta.tutorialDone = true;
      await db.query('UPDATE fantasy_characters SET gold = gold + 200, arcane_tokens = COALESCE(arcane_tokens,0) + 1, daily_login = $1 WHERE id = $2', [JSON.stringify(meta), char.id]);
      await addLog(char.id, 'quest', '🎓 Tutorial complete! Received 200 gold and 1 Arcane Token.');
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
  });

  app.get('/api/fantasy/data', requireAuth, (req, res) => {
    // Build enemy defs for codex bestiary
    const enemyDefs = {};
    for (const [loc, enemies] of Object.entries(getContent().enemies)) {
      for (const e of enemies) {
        enemyDefs[e.slug] = { slug: e.slug, name: e.name, level: e.level, hp: e.hp, attack: e.attack, defense: e.defense, boss: !!e.boss, location: loc, xp: e.xp, gold: e.gold };
      }
    }
    // Load codex guide
    let codexGuide = [];
    try { codexGuide = JSON.parse(fs.readFileSync(path.join(__dirname, 'content', 'codex-guide.json'), 'utf8')); } catch(e) {}
    // Load raid definitions for codex
    const raidDefs = {};
    const RAID_DIR = path.join(__dirname, 'content', 'raids');
    try {
      if (fs.existsSync(RAID_DIR)) {
        for (const f of fs.readdirSync(RAID_DIR)) {
          if (!f.endsWith('.json')) continue;
          const rd = JSON.parse(fs.readFileSync(path.join(RAID_DIR, f), 'utf8'));
          if (rd.slug) raidDefs[rd.slug] = {
            slug: rd.slug, name: rd.name, difficulty: rd.difficulty, icon: rd.icon || '🕳',
            description: rd.description, levelReq: rd.levelReq || 1,
            floorCount: rd.floorCount || (Array.isArray(rd.floors) ? rd.floors.length : 0),
            floors: (Array.isArray(rd.floors) ? rd.floors : []).map(f => ({ name: f.name, floor: f.floor, bossName: f.boss?.name })),
            enemies: (rd.enemies || []).map(e => ({ slug: e.slug, name: e.name, level: e.level, hp: e.hp, description: e.description })),
          };
        }
      }
    } catch(e) {}
    // Build location metadata for codex
    const locationMeta = {};
    const matDrops = getContent().materialDrops || {};
    const bossRecDrops = getContent().bossRecipeDrops || {};
    for (const loc of getContent().locations) {
      const locEnemies = (getContent().enemies[loc.slug] || []).map(e => {
        const entry = { slug: e.slug, name: e.name, level: e.level, boss: !!e.boss };
        // Material drops
        if (matDrops[e.slug]) entry.materialDrops = matDrops[e.slug].map(d => ({ item: d.itemSlug, chance: d.chance }));
        // Boss recipe drops
        if (bossRecDrops[e.slug]) entry.recipeDrops = bossRecDrops[e.slug].map(d => ({ recipe: d.scrollItem, chance: d.chance }));
        return entry;
      });
      locationMeta[loc.slug] = {
        hasShop: !!(getContent().shopItems[loc.slug]?.length),
        hasInn: !!(getContent().innCost[loc.slug]),
        canExplore: loc.type === 'wild' || loc.type === 'dungeon',
        enemies: locEnemies,
        threatLevel: getContent().locationThreat[loc.slug] || null,
      };
    }

    // Build quest metadata for quest mode UI
    const allQuests = getContent().quests || [];
    const questDefs = allQuests.map(q => ({ slug: q.slug, title: q.title, location: q.location, locationName: (getContent().locations.find(l => l.slug === q.location) || {}).name || q.location, minLevel: q.minLevel }));
    const questStageCounts = {};
    for (const q of allQuests) { questStageCounts[q.slug] = (q.stages || []).length; }

    res.json({
      races: RACES, classes: CLASSES, racialPassives: GAME_CONFIG.racialPassives, locations: getContent().locations, items: getContent().items,
      classBonuses: GAME_CONFIG.classBonuses || {},
      enemyDefs, codexGuide, combos: GAME_CONFIG.combos || [],
      dungeonConfigs: getContent().dungeonConfig || {},
      raidDefs, locationMeta,
      realms: getContent().realms || [],
      questDefs, questStageCounts,
    });
  });

  app.get('/api/fantasy/admin/content/schema', requireAdmin, (_req, res) => {
    return res.json({
      ok: true,
      kinds: {
        item: { fields: ['slug', 'seed', 'data'] },
        recipe: { fields: ['slug', 'data'] },
        location: { fields: ['slug', 'data'] },
        enemy: { fields: ['locationSlug', 'slug', 'data'] },
        quest: { fields: ['slug', 'data'] },
        shop: { fields: ['locationSlug', 'items'] },
        inn: { fields: ['locationSlug', 'cost'] },
        dungeon: { fields: ['locationSlug', 'data'] },
        'material-drop': { fields: ['enemySlug', 'drops'] },
        'boss-recipe-drop': { fields: ['bossSlug', 'drops'] },
      },
    });
  });

  app.get('/api/fantasy/admin/content/export', requireAdmin, (_req, res) => {
    return res.json({ ok: true, contentSeed: CONTENT_SEED, craftingSeed: CRAFTING_SEED });
  });

  app.post('/api/fantasy/admin/content/upsert', requireAdmin, validate(schemas.contentUpsert), async (req, res) => {
    try {
      const kind = String(req.body.kind || '').trim();
      const payload = req.body.payload || {};
      if (!kind) return res.status(400).json({ error: 'kind is required.' });
      applyContentMutation(kind, payload);
      await syncFantasyContent(db);
      return res.json({ ok: true, kind, payload });
    } catch (e) {
      console.error(e);
      return res.status(400).json({ error: e.message || 'Failed to upsert content.' });
    }
  });

  app.post('/api/fantasy/admin/content/sync', requireAdmin, async (_req, res) => {
    try {
      reloadSeedContent();
      await syncFantasyContent(db);
      return res.json({ ok: true });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: 'Failed to sync content.' });
    }
  });

  // ── DEV-ONLY: Test multi-entity combat ──
  app.post('/api/fantasy/admin/test-combat', requireAdmin, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Already in combat.' });
      const { enemyCount = 2, withAlly = true } = req.body || {};
      const locEnemies = getContent().enemies[char.location] || Object.values(getContent().enemies)[0] || [];
      const pool = locEnemies.filter(e => !e.boss);
      if (!pool.length) return res.status(400).json({ error: 'No enemies at this location.' });
      const enemies = [];
      for (let i = 0; i < Math.min(enemyCount, 4); i++) {
        const pick = pool[rand(0, pool.length - 1)];
        const scaled = buildScaledEnemy(pick, char.level, char.location);
        scaled.id = 'e' + i;
        scaled.effects = [];
        enemies.push(scaled);
      }
      let allies = [];
      // Spawn real companion if character has one
      const comp = buildCompanionAlly(char);
      if (comp) allies.push(comp);
      // Also add test ally if requested and no real companion
      if (withAlly && !comp) {
        allies.push({
          id: 'a0', name: 'Test Wolf Companion', hp: Math.floor(char.max_hp * 0.4),
          maxHp: Math.floor(char.max_hp * 0.4), attack: Math.floor(char.level * 2 + 5),
          defense: Math.floor(char.level + 2), effects: [], aiProfile: 'pet-aggressive',
          bleedChance: 15,
        });
      }
      const cs = {
        enemies, allies, turn: 1, playerBuffs: [], playerEffects: [],
        playerTempPassives: [], cooldowns: {},
        log: [`⚔ TEST COMBAT: ${enemies.map(e => e.name).join(', ')} appear!${withAlly ? ` Your wolf companion joins the fight!` : ''}`],
      };
      await db.query('UPDATE fantasy_characters SET in_combat=TRUE, combat_state=$1 WHERE id=$2', [JSON.stringify(cs), char.id]);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Test combat failed.' }); }
  });

  // ═══════════════════════════════════════════════════════════════
  // SUBSYSTEM MODULES — Guild, Academy, Auction House
  // ═══════════════════════════════════════════════════════════════

  const guildModule = require('./systems/guild');
  const { BOUNTY_CONFIG, GUILD_REGISTRATION_COST, getGuildRankInfo, MAX_ACTIVE_BOUNTIES } = guildModule;

  // Record a kill for bounty progress — registered as event listener
  async function recordBountyKill(charId, enemySlug, log) {
    const rows = await q(
      `SELECT bp.*, b.kill_target, b.town_slug, b.tier
       FROM fantasy_bounty_progress bp
       JOIN fantasy_bounties b ON b.id = bp.bounty_id
       WHERE bp.char_id = $1 AND b.enemy_slug = $2 AND bp.claimed = FALSE`,
      [charId, enemySlug]
    );
    for (const row of rows) {
      const newKills = Math.min(row.kills + 1, row.kill_target);
      const nowComplete = newKills >= row.kill_target;
      await db.query(
        'UPDATE fantasy_bounty_progress SET kills = $1, completed = $2 WHERE char_id = $3 AND bounty_id = $4',
        [newKills, nowComplete, charId, row.bounty_id]
      );
      if (nowComplete && !row.completed) {
        if (log) log.push(`📋 Bounty complete: ${row.tier} bounty fulfilled! Return to town to claim rewards.`);
      } else if (!nowComplete) {
        if (log) log.push(`📋 Bounty progress: ${newKills}/${row.kill_target}`);
      }
      await gameEvents.emit('bounty-progress', {
        charId, enemySlug, kills: newKills, killTarget: row.kill_target,
        tier: row.tier, completed: nowComplete, townSlug: row.town_slug,
      });
    }
  }

  // ── Register event listeners ──
  gameEvents.on('enemy-killed', async (data) => {
    await recordBountyKill(data.charId, data.enemySlug, data.log);
  });

  // Check if a location has crafting/forge facilities (any realm hub town)
  function hasCraftingAccess(locationSlug) {
    return (getContent().realms || []).some(r => r.hub === locationSlug);
  }

  // Get the hub town for the realm a location belongs to (for death respawn)
  function getRespawnLocation(locationSlug) {
    const loc = getContent().locations.find(l => l.slug === locationSlug);
    const realm = loc?.realm;
    if (realm) {
      const realmDef = (getContent().realms || []).find(r => r.slug === realm);
      if (realmDef?.hub) return realmDef.hub;
    }
    return 'thornwall'; // fallback
  }

  const moduleCtx = {
    db, q, q1, withTransaction, getChar, getCharList, addLog, addItem, removeItem, buildState, buildPatch, getContent, gameEvents,
    RACES, CLASSES, ABILITY_INDEX, EQUIPMENT_SLOTS, HOME_LOCATION, rand, getRespawnLocation, hasCraftingAccess,
    getCharAbilities, MAX_ACTIVE_ABILITIES, getEquipment, computeStats,
    getPerkPrefix, getMaxDurability, rollPerks, enrichItemStacks,
    getActiveQuests, getCompletedQuests, getInventory, getLog,
    getHomeStorage, addHomeItem, removeHomeItem, getKnownRecipes,
    getRecipeBySlug, isRecipeUnlockedForChar, unlockRecipe, consumeCraftingIngredients,
    getHomeStorageCapacity, getHomeStorageUpgradeCost, getQuestStorageBonus,
    buildItemCountMap, buildRecipeState, checkLevelUp, isExploreGated,
    pickEncounterForLocation, buildScaledEnemy, buildCompanionAlly, getRecipeScrollItemSlug,
    awardExploreMaterials, awardBossRecipe, recordBountyKill,
    applyEffect, removeEffect, getEffectStatMods, tickEffects, isStunned,
    applyDefenseReduction, applyDamagePassives, applyTurnRegenPassives,
    addTempPassive, applyConsumableUse, cureEffect,
    calcDodgeChance, calcEnemyDodgeChance, calcCritChance, calcEnemyCritChance,
    getCombatPassives, getEquipmentPassives, getEquipmentPerkBonuses,
    STATUS_EFFECTS, ENEMY_ABILITIES, xpForLevel,
    getVault, addVaultItem, removeVaultItem, VAULT_CAPACITY,
    getRacialPassive, applyRacialDamageBonus, RACIAL_PASSIVES, getAbilityRankCost,
  };

  // ═══════════════════════════════════════════════════════════════
  // REGISTER ALL SYSTEM MODULES
  // ═══════════════════════════════════════════════════════════════
  guildModule.register(app, requireAuth, moduleCtx);
  require('./systems/academy').register(app, requireAuth, moduleCtx);
  require('./systems/auction').register(app, requireAuth, moduleCtx);
  require('./systems/arena').register(app, requireAuth, moduleCtx);
  require('./systems/forge').register(app, requireAuth, moduleCtx);
  require('./systems/combat').register(app, requireAuth, moduleCtx);
  require('./systems/exploration').register(app, requireAuth, moduleCtx);
  require('./systems/quests').register(app, requireAuth, moduleCtx);
  require('./systems/shop').register(app, requireAuth, moduleCtx);
  require('./systems/home').register(app, requireAuth, moduleCtx);
  require('./systems/characters').register(app, requireAuth, moduleCtx);
  require('./systems/class-trainer').register(app, requireAuth, moduleCtx);
  require('./systems/progression').register(app, requireAuth, moduleCtx);
  require('./systems/raid').register(app, requireAuth, moduleCtx);
  require('./systems/friends').register(app, requireAuth, moduleCtx);
  require('./systems/party-combat').register(app, requireAuth, moduleCtx);
  require('./systems/party').register(app, requireAuth, moduleCtx);
  require('./systems/sse').register(app, requireAuth, moduleCtx);

  // Expose shutdown for SSE cleanup
  registerFantasyRoutes._shutdown = () => {
    if (moduleCtx.sseCloseAll) moduleCtx.sseCloseAll();
  };
}

module.exports = { initFantasyDb, registerFantasyRoutes, getContent, gameEvents };