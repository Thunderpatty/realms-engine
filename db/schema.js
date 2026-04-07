// ═══════════════════════════════════════════════════════════════════
// DATABASE SCHEMA — Table definitions and migrations
// Extracted from fantasy-rpg.js for modularity (Tier 2A.1)
// ═══════════════════════════════════════════════════════════════════

/**
 * All CREATE TABLE statements for the fantasy RPG.
 * Order matters for foreign key references.
 */
const TABLES = [
  `CREATE TABLE IF NOT EXISTS fantasy_characters (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    race TEXT NOT NULL,
    class TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 1,
    xp INTEGER NOT NULL DEFAULT 0,
    hp INTEGER NOT NULL,
    max_hp INTEGER NOT NULL,
    mp INTEGER NOT NULL,
    max_mp INTEGER NOT NULL,
    gold INTEGER NOT NULL DEFAULT 30,
    location TEXT NOT NULL DEFAULT 'thornwall',
    in_combat BOOLEAN NOT NULL DEFAULT FALSE,
    combat_state JSONB,
    quest_state JSONB,
    dungeon_state JSONB,
    home_storage_bonus INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_inventory (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    item_slug TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_equipment (
    char_id INTEGER NOT NULL,
    slot TEXT NOT NULL,
    item_slug TEXT NOT NULL,
    durability INTEGER NOT NULL DEFAULT 20,
    PRIMARY KEY (char_id, slot)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_quests (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    quest_slug TEXT NOT NULL,
    stage INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    bonus_gold INTEGER NOT NULL DEFAULT 0,
    bonus_xp INTEGER NOT NULL DEFAULT 0,
    accepted_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    UNIQUE(char_id, quest_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_game_log (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    tone TEXT NOT NULL DEFAULT 'info',
    entry TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_locations (
    slug TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    connections JSONB NOT NULL DEFAULT '[]'::jsonb,
    threat INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_items (
    slug TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_enemies (
    slug TEXT PRIMARY KEY,
    location_slug TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_quest_defs (
    slug TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    location_slug TEXT NOT NULL,
    min_level INTEGER NOT NULL DEFAULT 1,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_shops (
    location_slug TEXT NOT NULL,
    item_slug TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (location_slug, item_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_inns (
    location_slug TEXT PRIMARY KEY,
    cost INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_dungeons (
    location_slug TEXT PRIMARY KEY,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_home_storage (
    char_id INTEGER NOT NULL,
    item_slug TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (char_id, item_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_account_vault (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    item_slug TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    perks JSONB DEFAULT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_known_recipes (
    char_id INTEGER NOT NULL,
    recipe_slug TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'discovery',
    learned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (char_id, recipe_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_recipes (
    slug TEXT PRIMARY KEY,
    sort_order INTEGER NOT NULL DEFAULT 0,
    unlock_level INTEGER NOT NULL DEFAULT 1,
    output_item_slug TEXT NOT NULL,
    output_qty INTEGER NOT NULL DEFAULT 1,
    requires_discovery BOOLEAN NOT NULL DEFAULT FALSE,
    data JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_explore_materials (
    enemy_slug TEXT NOT NULL,
    item_slug TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    chance INTEGER NOT NULL DEFAULT 100,
    min_qty INTEGER NOT NULL DEFAULT 1,
    max_qty INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (enemy_slug, item_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_content_boss_recipe_drops (
    boss_slug TEXT NOT NULL,
    recipe_slug TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    chance INTEGER NOT NULL DEFAULT 10,
    PRIMARY KEY (boss_slug, recipe_slug)
  )`,
  // ── Auction House ──
  `CREATE TABLE IF NOT EXISTS fantasy_auction_listings (
    id SERIAL PRIMARY KEY,
    seller_id INTEGER NOT NULL,
    seller_name TEXT NOT NULL,
    item_slug TEXT NOT NULL,
    item_name TEXT NOT NULL,
    item_rarity TEXT NOT NULL,
    item_type TEXT NOT NULL,
    item_perks JSONB DEFAULT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    price INTEGER NOT NULL,
    listing_fee INTEGER NOT NULL DEFAULT 0,
    inventory_id INTEGER DEFAULT NULL,
    listed_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours'),
    state TEXT NOT NULL DEFAULT 'active',
    buyer_id INTEGER DEFAULT NULL,
    buyer_name TEXT DEFAULT NULL,
    sold_at TIMESTAMPTZ DEFAULT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_auction_history (
    id SERIAL PRIMARY KEY,
    item_slug TEXT NOT NULL,
    item_rarity TEXT NOT NULL,
    price INTEGER NOT NULL,
    sold_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  // ── Bounty Board ──
  `CREATE TABLE IF NOT EXISTS fantasy_bounties (
    id SERIAL PRIMARY KEY,
    town_slug TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'easy',
    enemy_slug TEXT NOT NULL,
    enemy_name TEXT NOT NULL,
    area_slug TEXT NOT NULL,
    area_name TEXT NOT NULL,
    kill_target INTEGER NOT NULL DEFAULT 3,
    reward_gold INTEGER NOT NULL DEFAULT 0,
    reward_guild_marks INTEGER NOT NULL DEFAULT 0,
    generated_date DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE(town_slug, tier, generated_date)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_bounty_progress (
    char_id INTEGER NOT NULL,
    bounty_id INTEGER NOT NULL REFERENCES fantasy_bounties(id) ON DELETE CASCADE,
    kills INTEGER NOT NULL DEFAULT 0,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    claimed BOOLEAN NOT NULL DEFAULT FALSE,
    accepted_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (char_id, bounty_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_arena_runs (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    wave_reached INTEGER NOT NULL DEFAULT 0,
    ap_earned INTEGER NOT NULL DEFAULT 0,
    location_slug TEXT NOT NULL,
    started_at TIMESTAMPTZ DEFAULT NOW(),
    ended_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_arena_store (
    char_id INTEGER NOT NULL PRIMARY KEY,
    slots JSONB NOT NULL DEFAULT '[]'::jsonb,
    last_reroll TIMESTAMPTZ DEFAULT NOW(),
    free_reroll_used BOOLEAN NOT NULL DEFAULT FALSE
  )`,
];

/**
 * Incremental migrations for existing databases.
 * Each is an ALTER TABLE that may already have been applied.
 * Error code 42701 (duplicate_column) is expected and silently ignored.
 */
const MIGRATIONS = [
  'ALTER TABLE fantasy_characters ADD COLUMN dungeon_state JSONB',
  'ALTER TABLE fantasy_equipment ADD COLUMN durability INTEGER NOT NULL DEFAULT 20',
  'ALTER TABLE fantasy_characters ADD COLUMN home_storage_bonus INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE fantasy_inventory ADD COLUMN junk BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE fantasy_inventory ADD COLUMN perks JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_equipment ADD COLUMN perks JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_home_storage ADD COLUMN perks JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN guild_marks INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE fantasy_characters ADD COLUMN arcane_tokens INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE fantasy_characters DROP CONSTRAINT IF EXISTS fantasy_characters_user_id_key',
  'ALTER TABLE fantasy_characters ADD COLUMN learned_abilities JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN active_abilities JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN guild_registered BOOLEAN NOT NULL DEFAULT FALSE',
  'ALTER TABLE fantasy_characters ADD COLUMN guild_rank INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE fantasy_characters ADD COLUMN guild_xp INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE fantasy_characters ADD COLUMN active_abilities_pvp JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN event_state JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN arena_points INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE fantasy_characters ADD COLUMN arena_state JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_equipment ADD COLUMN sockets JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN companion JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN active_title TEXT DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN daily_login JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN ability_ranks JSONB DEFAULT \'{}\'',
  'ALTER TABLE fantasy_characters ADD COLUMN raid_state JSONB DEFAULT NULL',
  'ALTER TABLE fantasy_characters ADD COLUMN party_id INTEGER DEFAULT NULL',
  "ALTER TABLE fantasy_characters ADD COLUMN unlocked_realms JSONB DEFAULT '[\"ashlands\"]'",
];

const TABLES_V2 = [
  `CREATE TABLE IF NOT EXISTS fantasy_achievements (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    achievement_slug TEXT NOT NULL,
    unlocked_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(char_id, achievement_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_codex (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    entry_slug TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(char_id, category, entry_slug)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_weekly_quests (
    id SERIAL PRIMARY KEY,
    quest_slug TEXT NOT NULL,
    location TEXT NOT NULL,
    enemy_slug TEXT,
    kill_target INTEGER DEFAULT 0,
    description TEXT,
    reward_gold INTEGER DEFAULT 0,
    reward_xp INTEGER DEFAULT 0,
    reward_tokens INTEGER DEFAULT 0,
    week_key TEXT NOT NULL,
    UNIQUE(quest_slug, week_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_weekly_progress (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    quest_slug TEXT NOT NULL,
    week_key TEXT NOT NULL,
    kills INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    claimed BOOLEAN DEFAULT FALSE,
    UNIQUE(char_id, quest_slug, week_key)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_world_feed (
    id SERIAL PRIMARY KEY,
    char_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_parties (
    id SERIAL PRIMARY KEY,
    leader_id INTEGER NOT NULL,
    state TEXT DEFAULT 'forming',
    raid_slug TEXT,
    raid_state JSONB,
    combat_state JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_party_members (
    party_id INTEGER NOT NULL,
    char_id INTEGER NOT NULL,
    ready BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'alive',
    last_poll TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (party_id, char_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_party_invites (
    id SERIAL PRIMARY KEY,
    party_id INTEGER NOT NULL,
    from_char_id INTEGER NOT NULL,
    to_char_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_friends (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    friend_char_id INTEGER NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(char_id, friend_char_id)
  )`,
  `CREATE TABLE IF NOT EXISTS fantasy_raid_runs (
    id SERIAL PRIMARY KEY,
    char_id INTEGER NOT NULL,
    raid_slug TEXT NOT NULL,
    floors_reached INTEGER DEFAULT 0,
    completed BOOLEAN DEFAULT FALSE,
    ended_at TIMESTAMPTZ DEFAULT NOW()
  )`,
];

/**
 * Performance indexes for high-traffic query patterns.
 * CREATE INDEX IF NOT EXISTS is idempotent — safe to run on every startup.
 */
const INDEXES = [
  // Player-scoped tables (queried on every state load)
  'CREATE INDEX IF NOT EXISTS idx_inventory_char ON fantasy_inventory (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_equipment_char ON fantasy_equipment (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_game_log_char ON fantasy_game_log (char_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_home_storage_char ON fantasy_home_storage (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_quests_char ON fantasy_quests (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_known_recipes_char ON fantasy_known_recipes (char_id)',
  // Codex & achievements
  'CREATE INDEX IF NOT EXISTS idx_codex_char ON fantasy_codex (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_achievements_char ON fantasy_achievements (char_id)',
  // Bounties
  'CREATE INDEX IF NOT EXISTS idx_bounty_progress_char ON fantasy_bounty_progress (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_bounties_town_date ON fantasy_bounties (town_slug, generated_date)',
  // Auction House
  'CREATE INDEX IF NOT EXISTS idx_auction_state ON fantasy_auction_listings (state, expires_at) WHERE state = \'active\'',
  'CREATE INDEX IF NOT EXISTS idx_auction_seller ON fantasy_auction_listings (seller_id) WHERE state = \'active\'',
  // Arena
  'CREATE INDEX IF NOT EXISTS idx_arena_runs_char ON fantasy_arena_runs (char_id)',
  // Friends & multiplayer
  'CREATE INDEX IF NOT EXISTS idx_friends_char ON fantasy_friends (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_friends_friend ON fantasy_friends (friend_char_id)',
  'CREATE INDEX IF NOT EXISTS idx_party_members_char ON fantasy_party_members (char_id)',
  'CREATE INDEX IF NOT EXISTS idx_party_invites_to ON fantasy_party_invites (to_char_id) WHERE status = \'pending\'',
  // Raid runs
  'CREATE INDEX IF NOT EXISTS idx_raid_runs_char ON fantasy_raid_runs (char_id)',
  // Weekly progress
  'CREATE INDEX IF NOT EXISTS idx_weekly_progress_char ON fantasy_weekly_progress (char_id, week_key)',
  // World feed (recent entries)
  'CREATE INDEX IF NOT EXISTS idx_world_feed_created ON fantasy_world_feed (created_at DESC)',
  // Content tables (queried on startup/sync)
  'CREATE INDEX IF NOT EXISTS idx_content_enemies_location ON fantasy_content_enemies (location_slug)',
  // Vault
  'CREATE INDEX IF NOT EXISTS idx_vault_user ON fantasy_account_vault (user_id)',
];

/**
 * Create all tables and run migrations.
 * @param {object} db - PostgreSQL pool or client with .query()
 */
async function createSchema(db) {
  for (const sql of TABLES) {
    await db.query(sql);
  }
  for (const sql of TABLES_V2) {
    await db.query(sql);
  }
  for (const sql of MIGRATIONS) {
    try {
      await db.query(sql);
    } catch (e) {
      // 42701 = duplicate_column (migration already applied)
      if (e.code !== '42701') {
        console.error('Migration failed:', sql, e.message);
        throw e;
      }
    }
  }
  // Create performance indexes (idempotent)
  for (const sql of INDEXES) {
    try {
      await db.query(sql);
    } catch (e) {
      console.error('Index creation failed:', sql, e.message);
    }
  }
}

module.exports = { createSchema, TABLES, MIGRATIONS };
