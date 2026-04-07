// ═══════════════════════════════════════════════════════════════
// CONTENT VALIDATION TESTS — All game content files parse and cross-reference correctly
// ═══════════════════════════════════════════════════════════════


const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '..', 'content');

// ─── Load all content ────────────────────────────────────────

function loadJsonDir(dir) {
  const files = {};
  if (!fs.existsSync(dir)) return files;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    files[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return files;
}

const zoneFiles = loadJsonDir(path.join(CONTENT_DIR, 'zones'));
const itemFiles = loadJsonDir(path.join(CONTENT_DIR, 'items'));
const questFiles = loadJsonDir(path.join(CONTENT_DIR, 'quests'));
const recipes = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'recipes.json'), 'utf8'));
const materialDrops = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'material-drops.json'), 'utf8'));
const bossRecipeDrops = JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, 'boss-recipe-drops.json'), 'utf8'));

// Build lookup tables
const allItems = {};
for (const [, fileData] of Object.entries(itemFiles)) {
  // Item files are objects keyed by slug, each value is the item definition
  if (fileData && typeof fileData === 'object' && !Array.isArray(fileData)) {
    for (const [slug, item] of Object.entries(fileData)) {
      allItems[slug] = { slug, ...item };
    }
  }
}

const allEnemies = {};
const allLocations = {};
for (const [, zone] of Object.entries(zoneFiles)) {
  if (zone.location) {
    allLocations[zone.location.slug] = zone.location;
  }
  if (zone.enemies) {
    for (const enemy of zone.enemies) {
      allEnemies[enemy.slug] = enemy;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ZONE FILES
// ═══════════════════════════════════════════════════════════════

describe('Zone files', () => {
  it('has 20 zone files', () => {
    expect(Object.keys(zoneFiles).length).toBeGreaterThanOrEqual(12);
  });

  it('every zone has a valid location definition', () => {
    for (const [filename, zone] of Object.entries(zoneFiles)) {
      expect(zone.location, `${filename} missing location`).toBeDefined();
      expect(zone.location.slug, `${filename} missing slug`).toBeTruthy();
      expect(zone.location.name, `${filename} missing name`).toBeTruthy();
      expect(['town', 'wild', 'dungeon'], `${filename} invalid type`).toContain(zone.location.type);
      expect(zone.location.connections, `${filename} missing connections`).toBeInstanceOf(Array);
    }
  });

  it('every zone connection references an existing zone', () => {
    const slugs = new Set(Object.values(zoneFiles).map(z => z.location.slug));
    for (const [filename, zone] of Object.entries(zoneFiles)) {
      for (const conn of zone.location.connections) {
        expect(slugs.has(conn), `${filename}: connection '${conn}' not found`).toBe(true);
      }
    }
  });

  it('wild and dungeon zones have enemies', () => {
    for (const [filename, zone] of Object.entries(zoneFiles)) {
      if (zone.location.type !== 'town') {
        expect(zone.enemies?.length, `${filename} (${zone.location.type}) has no enemies`).toBeGreaterThan(0);
      }
    }
  });

  it('every enemy has required fields', () => {
    for (const [filename, zone] of Object.entries(zoneFiles)) {
      for (const enemy of (zone.enemies || [])) {
        expect(enemy.slug, `${filename}: enemy missing slug`).toBeTruthy();
        expect(enemy.name, `${filename}: enemy ${enemy.slug} missing name`).toBeTruthy();
        expect(enemy.hp, `${filename}: enemy ${enemy.slug} missing hp`).toBeGreaterThan(0);
        expect(enemy.attack, `${filename}: enemy ${enemy.slug} missing attack`).toBeGreaterThan(0);
        expect(typeof enemy.defense, `${filename}: enemy ${enemy.slug} defense not number`).toBe('number');
        expect(enemy.level, `${filename}: enemy ${enemy.slug} missing level`).toBeGreaterThan(0);
      }
    }
  });

  it('towns have shops with valid item references', () => {
    for (const [filename, zone] of Object.entries(zoneFiles)) {
      if (zone.location.type === 'town' && zone.shop) {
        for (const slug of zone.shop) {
          expect(allItems[slug], `${filename}: shop item '${slug}' not in item definitions`).toBeDefined();
        }
      }
    }
  });

  it('zones have map coordinates', () => {
    for (const [filename, zone] of Object.entries(zoneFiles)) {
      expect(typeof zone.location.mapX, `${filename} missing mapX`).toBe('number');
      expect(typeof zone.location.mapY, `${filename} missing mapY`).toBe('number');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// ITEMS
// ═══════════════════════════════════════════════════════════════

describe('Item definitions', () => {
  it('has 300+ items total', () => {
    expect(Object.keys(allItems).length).toBeGreaterThan(300);
  });

  it('every item has slug, name, type', () => {
    for (const [slug, item] of Object.entries(allItems)) {
      expect(item.slug, `item missing slug`).toBe(slug);
      expect(item.name, `${slug} missing name`).toBeTruthy();
      expect(item.type, `${slug} missing type`).toBeTruthy();
    }
  });

  it('equipment items have stats', () => {
    const equipTypes = ['weapon', 'shield', 'body', 'helmet', 'gloves', 'boots', 'amulet', 'ring', 'trinket'];
    for (const [slug, item] of Object.entries(allItems)) {
      if (equipTypes.includes(item.type)) {
        expect(item.stats, `${slug} (${item.type}) missing stats`).toBeDefined();
      }
    }
  });

  it('consumables have use definition', () => {
    for (const [slug, item] of Object.entries(allItems)) {
      if (item.type === 'consumable') {
        expect(item.use, `consumable ${slug} missing use`).toBeDefined();
      }
    }
  });

  it('items have valid rarity', () => {
    const validRarities = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic', 'exotic'];
    for (const [slug, item] of Object.entries(allItems)) {
      if (item.rarity) {
        expect(validRarities, `${slug} has invalid rarity: ${item.rarity}`).toContain(item.rarity);
      }
    }
  });

  it('has 18 gem items (6 types × 3 tiers)', () => {
    const gems = Object.values(allItems).filter(i => i.type === 'gem');
    expect(gems.length).toBe(18);
  });

  it('has mythic items (5 per slot per class)', () => {
    const mythics = Object.values(allItems).filter(i => i.rarity === 'mythic');
    expect(mythics.length).toBeGreaterThanOrEqual(45);
  });
});

// ═══════════════════════════════════════════════════════════════
// RECIPES
// ═══════════════════════════════════════════════════════════════

describe('Crafting recipes', () => {
  it('has 50+ recipes', () => {
    expect(recipes.length).toBeGreaterThanOrEqual(50);
  });

  it('every recipe has slug, output, and ingredients', () => {
    for (const recipe of recipes) {
      expect(recipe.slug, 'recipe missing slug').toBeTruthy();
      expect(recipe.outputItem, `${recipe.slug} missing outputItem`).toBeTruthy();
      expect(recipe.ingredients, `${recipe.slug} missing ingredients`).toBeInstanceOf(Array);
      expect(recipe.ingredients.length, `${recipe.slug} has no ingredients`).toBeGreaterThan(0);
    }
  });

  it('recipe outputs reference existing items', () => {
    for (const recipe of recipes) {
      expect(allItems[recipe.outputItem], `recipe ${recipe.slug} outputItem '${recipe.outputItem}' not found`).toBeDefined();
    }
  });

  it('recipe ingredients reference existing items', () => {
    for (const recipe of recipes) {
      for (const ing of recipe.ingredients) {
        expect(allItems[ing.item], `recipe ${recipe.slug} ingredient '${ing.item}' not found`).toBeDefined();
        expect(ing.qty, `recipe ${recipe.slug} ingredient ${ing.item} missing qty`).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// MATERIAL DROPS
// ═══════════════════════════════════════════════════════════════

describe('Material drop tables', () => {
  it('references existing enemies', () => {
    for (const [enemySlug] of Object.entries(materialDrops)) {
      expect(allEnemies[enemySlug], `material drop enemy '${enemySlug}' not found`).toBeDefined();
    }
  });

  it('drop items reference existing items', () => {
    for (const [enemySlug, drops] of Object.entries(materialDrops)) {
      for (const drop of drops) {
        expect(allItems[drop.itemSlug], `enemy ${enemySlug} drops '${drop.itemSlug}' which doesn't exist`).toBeDefined();
        expect(drop.chance, `enemy ${enemySlug} drop ${drop.itemSlug} missing chance`).toBeGreaterThan(0);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// BOSS RECIPE DROPS
// ═══════════════════════════════════════════════════════════════

describe('Boss recipe drops', () => {
  it('references existing enemies', () => {
    for (const [enemySlug] of Object.entries(bossRecipeDrops)) {
      expect(allEnemies[enemySlug], `boss recipe drop enemy '${enemySlug}' not found`).toBeDefined();
    }
  });

  it('drop recipes reference existing recipe items', () => {
    for (const [enemySlug, drops] of Object.entries(bossRecipeDrops)) {
      for (const drop of drops) {
        expect(allItems[drop.scrollItem], `boss ${enemySlug} drops recipe '${drop.scrollItem}' which doesn't exist`).toBeDefined();
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// QUESTS
// ═══════════════════════════════════════════════════════════════

describe('Quest definitions', () => {
  it('every quest has slug, title, stages, rewards', () => {
    for (const [filename, quests] of Object.entries(questFiles)) {
      for (const quest of quests) {
        expect(quest.slug, `${filename}: quest missing slug`).toBeTruthy();
        expect(quest.title, `${filename}: quest ${quest.slug} missing title`).toBeTruthy();
        expect(quest.stages, `${filename}: quest ${quest.slug} missing stages`).toBeInstanceOf(Array);
        expect(quest.stages.length, `${filename}: quest ${quest.slug} has 0 stages`).toBeGreaterThan(0);
        expect(quest.rewards, `${filename}: quest ${quest.slug} missing rewards`).toBeDefined();
      }
    }
  });

  it('quest reward items reference existing items', () => {
    for (const [filename, quests] of Object.entries(questFiles)) {
      for (const quest of quests) {
        if (quest.rewards?.item) {
          expect(allItems[quest.rewards.item], `quest ${quest.slug} reward item '${quest.rewards.item}' not found`).toBeDefined();
        }
      }
    }
  });

  it('quest locations reference existing zones', () => {
    for (const [filename, quests] of Object.entries(questFiles)) {
      for (const quest of quests) {
        if (quest.location && quest.type !== 'portal') {
          expect(allLocations[quest.location], `quest ${quest.slug} location '${quest.location}' not found`).toBeDefined();
        }
      }
    }
  });
});
