// ═══════════════════════════════════════════════════════════════
// CONTENT LOADER — Reads from content/ directory OR legacy seed files
// ═══════════════════════════════════════════════════════════════
//
// Directory structure:
//   content/zones/<slug>.json     — location, enemies, shopItems, innCost, dungeonConfig, locationThreat
//   content/quests/<location>.json — array of quest definitions
//   content/items/<category>.json  — item definitions keyed by slug
//   content/recipes.json           — array of recipe definitions
//   content/material-drops.json    — materialDrops keyed by enemy slug
//   content/boss-recipe-drops.json — bossRecipeDrops keyed by boss slug
//
// Falls back to legacy seed files if content/ directory doesn't exist.

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'content');

function loadJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadJsonDir(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ name: f.replace('.json', ''), data: loadJsonFile(path.join(dirPath, f)) }))
    .filter(f => f.data !== null);
}

/**
 * Build content from the split content/ directory.
 * Returns the same shape as buildStaticFantasyContent() in the main module.
 */
function buildContentFromDirectory() {
  const zones = loadJsonDir(path.join(CONTENT_DIR, 'zones'));
  const questFiles = loadJsonDir(path.join(CONTENT_DIR, 'quests'));
  const itemFiles = loadJsonDir(path.join(CONTENT_DIR, 'items'));

  const locations = [];
  const enemies = {};
  const shopItems = {};
  const innCost = {};
  const dungeonConfig = {};
  const locationThreat = {};
  const exploreEvents = {};
  const enemyGroups = {};

  for (const { data } of zones) {
    if (data.location) {
      locations.push(data.location);
      const slug = data.location.slug;
      if (data.enemies?.length) enemies[slug] = data.enemies;
      if (data.shopItems) shopItems[slug] = data.shopItems;
      if (data.innCost !== undefined) innCost[slug] = data.innCost;
      if (data.dungeonConfig) dungeonConfig[slug] = data.dungeonConfig;
      if (data.locationThreat !== undefined) locationThreat[slug] = data.locationThreat;
      if (data.events?.length) exploreEvents[slug] = data.events;
      if (data.enemyGroups?.length) enemyGroups[slug] = data.enemyGroups;
    }
  }

  // Sort locations by a stable order (match legacy seed order)
  // Use the zone file order which was generated from the original seed

  const items = {};
  for (const { data } of itemFiles) {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      Object.assign(items, data);
    }
  }

  const quests = [];
  for (const { data } of questFiles) {
    if (Array.isArray(data)) quests.push(...data);
  }

  const recipes = loadJsonFile(path.join(CONTENT_DIR, 'recipes.json')) || [];
  const materialDrops = loadJsonFile(path.join(CONTENT_DIR, 'material-drops.json')) || {};
  const bossRecipeDrops = loadJsonFile(path.join(CONTENT_DIR, 'boss-recipe-drops.json')) || {};
  const realms = loadJsonFile(path.join(CONTENT_DIR, 'realms.json')) || [];

  return {
    locations, enemies, items, quests,
    shopItems, innCost, dungeonConfig, locationThreat, exploreEvents, enemyGroups,
    recipes, materialDrops, bossRecipeDrops, realms,
  };
}

/**
 * Check if the content/ directory exists and has zone files.
 */
function hasContentDirectory() {
  const zonesDir = path.join(CONTENT_DIR, 'zones');
  return fs.existsSync(zonesDir) && fs.readdirSync(zonesDir).some(f => f.endsWith('.json'));
}

module.exports = { buildContentFromDirectory, hasContentDirectory, CONTENT_DIR };
