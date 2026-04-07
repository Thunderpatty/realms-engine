---
name: realms-engine
description: Work on a content-driven fantasy RPG engine with PostgreSQL-backed game state, modular server architecture, content APIs, combat/status systems, crafting, raids, multiplayer party combat, and home UI. Use for feature work, bugfixes, balancing, content changes, and safe server/database handling in this specific codebase.
---

# Thunderpatty RPG Skill

## When to use

Use this skill when working on:
- `~/realms-engine` (production) or `~/realms-engine` (development)
- Fantasy RPG systems: combat, quests, crafting, shops, guilds, bounties, class trainer, auction house, duels, arena, forge, raids, parties, friends
- Shared auth/login
- PostgreSQL-backed content and progression
- Content expansion through admin content API or seed files
- Server start/restart and live-instance debugging


---

## Project Layout

**Install directory:** `~/realms-engine` (port 8080 by default)
Configuration via `.env` file. See `setup.sh` for installation.

### Core Server Files
| File | Purpose | Lines |
|------|---------|-------|
| `server.js` | Main Express app, auth, startup, gzip compression. Session cookie name configurable via `SESSION_NAME` env var. Rate limits: `RATE_LIMIT_AUTH` (auth), `RATE_LIMIT_GAME` (game), `RATE_LIMIT_POLL` (polling endpoints — separate generous limit for party/combat polls). | ~377 |
| `fantasy-rpg.js` | Fantasy RPG thin router: content loading, helper definitions, buildState/buildPatch, admin routes, module registration. Serves codex guide + enemy defs + raid defs + realms via /api/fantasy/data. Stale party/raid auto-cleanup in buildState. Realm-aware services. Game log auto-pruning (keeps last 500 per character). `getRespawnLocation()` for realm-aware death respawn. `hasCraftingAccess()` for hub-town crafting/forge. | ~1736 |
| `shared/game-logic.js` | Pure functions extracted for testability: computeStats, combat formulas, status effects, passives, perk generation, enemy scaling, consumable use, `getAbilityRankCost()` for rank-based MP scaling. XP curve: `120*level^1.8`. No DB, no Express. | ~531 |
| `shared/game-config.js` | Single shared `require()` for `game-config.json`. All system modules import this instead of reading the file separately. | ~14 |
| `validation.js` | Zod v4 schemas for all API endpoints + `validate()` middleware factory. Includes class-trainer, raid, party, friends schemas. | ~420 |
| `fantasy-duel.js` | PvP duel module: lobby, turn-based PvP combat, wager system, ability ranks, momentum, combos | ~1117 |
| `postgres-runtime.js` | PostgreSQL pool manager (pool creation, auto-reconnect, graceful shutdown, `withTransaction()` helper) | ~155 |
| `db/schema.js` | Database table definitions (34 CREATE TABLE), incremental migrations (28 ALTER TABLE), and 22 performance indexes (CREATE INDEX IF NOT EXISTS). Called by `initFantasyDb()`. | ~417 |
| `game-config.json` | Centralized game configuration: status effects, guild ranks, bounty config, AH settings, class defs (157 abilities), PvE cooldowns, guild vendor items, socket slots, enchant costs, gem extraction costs, material lists, ability ranks (5 per ability), 35 combos, durability, perk pools (including exotic), racial passives (5 races), racial abilities (5 races) | ~7102 |

### System Modules (`systems/`)
Extracted subsystems that register their own Express routes. Each receives a `ctx` object with shared DB helpers.

| File | Purpose | Lines |
|------|---------|-------|
| `systems/guild.js` | Adventurer's Guild: bounty board, guild registration, guild vendor, bounty accept/claim/abandon. Achievement triggers for bounties-completed and guild-rank. | ~260 |
| `systems/academy.js` | DEPRECATED — Routes now handled by class-trainer.js. Kept as no-op for backward compatibility. | ~12 |
| `systems/auction.js` | Auction House: browse, list, buy, cancel listings, lazy expiry | ~191 |
| `systems/content-loader.js` | Content loader: reads from `content/` directory OR legacy seed files. Also loads `realms.json`. | ~103 |
| `systems/game-events.js` | Async event emitter for cross-system hooks (enemy-killed, bounty-progress, etc.) | ~68 |
| `systems/arena.js` | Arena horde mode: wave combat, AP rewards, between-wave choices, arena store, per-slot reroll, leaderboard, gem drops. Dynamic enemy pools from connected zones (works in any realm town). Achievement trigger for arena-best-wave. | ~388 |
| `systems/forge.js` | The Forge: gem socketing, gem extraction, enchanting (perk rolling), perk extraction → crystals, crystal application. Available at any realm hub town. Achievement triggers for gems-socketed and items-enchanted. | ~289 |
| `systems/combat.js` | PvE solo combat action handler: abilities (all types incl. party support as solo fallback), status effects, victory/death/flee, arena/raid combat, durability, ability ranks with rank-scaled MP costs, momentum (0-10), combos (35), racial passives. Achievement triggers for elites-killed, group-victory, low-hp-victory, companion-level, arena-best-wave. Death respawns at current realm's hub town. | ~1365 |
| `systems/exploration.js` | Explore (wild + dungeon), exploration events, event resolution/dismiss. Uses shared `checkLevelUp()`. Achievement trigger for events-encountered. Death respawns at realm hub. | ~374 |
| `systems/quests.js` | Quest accept, quest choice (stat checks, combat triggers, completion). Portal quest realm unlock on completion. | ~150 |
| `systems/shop.js` | Shop buy/sell/buyback, equip/unequip (with classReq enforcement), repair/repair-all, rest, mark-junk, use-item | ~291 |
| `systems/home.js` | Home storage (Thornwall only), account vault, crafting (any hub town), upgrades, recipe learning. Achievement triggers for items-crafted and recipes-learned. | ~232 |
| `systems/characters.js` | Character create (120g start, class weapon auto-equipped, 3 HP + 2 MP potions), reset (full orphan cleanup across 15+ tables), switch, travel (single + multi-hop BFS with portal connections), static pages. Party/raid/realm guards on travel. | ~296 |
| `systems/class-trainer.js` | Unified class progression system at every realm hub town. Absorbs former Academy functionality. Handles: class quests (4 per class, one per realm, gates ability rank upgrades), ability learning (token cost), ability loadout (PvE/PvP swap), ability rank upgrades (token cost + rank cap from quest completion), companion management, respec. | ~463 |
| `systems/progression.js` | Achievements (48, all triggers wired), codex/collection log (incl. raid runs), titles, weekly quests, daily login rewards, world feed. Event listeners for enemy-killed, boss-killed, item-looted, quest-completed, dungeon-cleared, level-up, player-died, combo-discovered. | ~414 |
| `systems/raid.js` | Solo raid tower system (legacy, UI removed — raids are party-only now). Raid content loading, solo advance/choice/boss/completion. | ~693 |
| `systems/party.js` | Party system: create/invite/join/ready/kick/leave/start. Party formation at any realm's raidTown (dynamic, not hardcoded). Party raid flow: advance, vote-based choices, pre-boss recovery, dismiss. | ~742 |
| `systems/party-combat.js` | Party combat engine: simultaneous action submission, 30s timeout with auto-defend, round resolution in DEX order, enemy scaling for party size, victory/wipe handling, raid-exclusive drops. Rank-scaled ability MP costs. | ~870 |
| `systems/friends.js` | Friends list: add/accept/remove friends by name, online status tracking (5-min threshold), auto-accept mutual requests. | ~176 |

### Content Data
```
content/
├── realms.json          # Realm definitions (4 realms with level ranges, portal config, hub towns)
├── zones/               # One file per location (location def, enemies, shops, inn, dungeon config, events, enemy groups)
│   └── ... (36 zone files across 4 realms)
├── items/               # Item definitions by slot category
│   ├── weapons.json, shields.json, armor.json, helmets.json
│   ├── gloves.json, boots.json, amulets.json, rings.json, trinkets.json
│   ├── consumables.json, materials.json, crafting-extras.json
│   ├── gems.json              # 18 gem items (6 types × 3 tiers)
│   ├── mythics.json           # 50 mythic items (5 per slot, 1 per class)
│   ├── raid-depths.json       # 9 raid-exclusive items (4 mythic, 5 legendary)
│   ├── raid-depths-exotic.json       # 5 exotic items (1 per class)
│   ├── raid-crucible.json, raid-crucible-exotic.json
│   ├── raid-frozen-throne.json, raid-frozen-throne-exotic.json
│   ├── raid-infernal-sanctum.json, raid-infernal-sanctum-exotic.json
│   └── raid-unraveling.json, raid-unraveling-exotic.json
├── raids/               # Raid definitions
│   ├── the-depths.json        # The Depths of Ashenmaw (3F easy, lv5+)
│   ├── the-iron-crucible.json # The Iron Crucible (5F medium, lv8+)
│   ├── frozen-throne.json     # The Frozen Throne (4F medium, lv14+)
│   ├── infernal-sanctum.json  # The Infernal Sanctum (4F hard, lv25+)
│   └── the-unraveling.json    # The Unraveling (5F hard, lv40+)
├── quests/              # Quest definitions by location (57 quests)
├── recipes.json         # 110 crafting recipes (15 boss-exclusive)
├── material-drops.json  # 178 enemy material drop entries
├── boss-recipe-drops.json # 19 boss recipe drop entries
├── class-quests.json    # 20 class quests (4 per class × 5 classes, one per realm)
├── achievements.json    # 48 achievements across 6 categories
└── codex-guide.json     # 17 static guide pages for the Game Codex
```

### Frontend Files
| File | Purpose | Lines |
|------|---------|-------|
| `public/fantasy-rpg.html` | Fantasy RPG SPA — HTML structure + CSS (includes exotic rarity teal styling, connection banner, responsive breakpoints, quest mode styling, tutorial banner, enemy/ally gallery, location banner, combat background) | ~1520 |
| `public/fantasy-rpg-app.js` | Fantasy RPG client-side JS — all rendering, state management, API calls, `esc()` HTML escaping, `getAbilityRankCost()` for rank-scaled display, Codex modal (8 sections), party UI, party combat UI (with target selection, AFK/DC indicators, vote-kick), friends overlay, graph-based world map with realm tabs, connection loss detection with banner, `isRaidTown()` for dynamic party/service checks, quest mode (full takeover + pacing + outcomes + completion overlay), guided tutorial system (12-step quest + 5-step combat spotlight), image asset system (enemy portraits, location backgrounds) | ~6900 |
| `public/duel.html` | PvP duel page (standalone) | ~790 |
| `public/leaderboard.html` | Public leaderboard page | ~150 |

### Image Assets
```
public/
├── enemies/           # Enemy portrait images (512×768 PNG, named {slug}.png)
│   ├── 70 Ashlands enemies (lv1-10)
│   ├── player-placeholder.png    # Placeholder for player portrait
│   └── companion-placeholder.png # Placeholder for companion portrait
└── locations/         # Location background banners (1200×480 PNG, named {slug}.png)
    └── 36 location backgrounds (all zones covered)
```
- **Enemy portraits**: Displayed in horizontal combat gallery above HP bars. `onerror` hides gracefully if image missing.
- **Location backgrounds**: Shown as banner at top of location view with dark gradient fade. Also used at 30% opacity as combat box background.
- **Static serving**: `/assets` route maps to `public/` directory. URLs: `/assets/enemies/{slug}.png`, `/assets/locations/{slug}.png`.

### Tests (`tests/`)
| File | Tests | Type | Purpose |
|------|-------|------|--------|
| `tests/stats.test.js` | 64 | Unit | Config integrity, XP curve, computeStats, level scaling, equipment/perk/socket bonuses, combat formulas, racial passives |
| `tests/combat.test.js` | 35 | Unit | Status effects, lifesteal, regen passives, consumables, perk generation |
| `tests/content.test.js` | 25 | Unit | All zones, items (incl. exotic rarity), recipes, drop tables, quests |
| `tests/api-gameplay.test.js` | 39 | Integration | Auth, char creation (auto-equipped weapon), travel, combat, shop, equip, consumables, storage, vault |
| `tests/api-systems.test.js` | 26 | Integration | Guild, arena, AH, class-trainer, forge, inn, quests, crafting, leaderboard |
| `tests/api-transactions.test.js` | 6 | Integration | Race conditions: concurrent buy/sell/equip/AH, gold never negative |

**Total: 195 tests, ~20 seconds.** Run with `npm test` or `npx vitest run`.

---

## Database

### Connection
- **Engine**: PostgreSQL 16 (system install, not embedded)
- **Host**: `127.0.0.1`, **Port**: `5432` (configurable in `.env`)
- **Database**: `realms_game` (configurable in `.env`)
- **User/Password**: Set during `setup.sh` or in `.env`

### Tables (34 total)

**Player:** `fantasy_characters`, `fantasy_inventory`, `fantasy_equipment`, `fantasy_home_storage`, `fantasy_quests`, `fantasy_game_log`, `fantasy_known_recipes`

**Guild/Bounty:** `fantasy_bounties`, `fantasy_bounty_progress`

**Auction:** `fantasy_auction_listings`, `fantasy_auction_history`

**Arena:** `fantasy_arena_runs`, `fantasy_arena_store`

**Duel:** `fantasy_duels`, `fantasy_duel_lobby`, `fantasy_duel_history`

**Progression:** `fantasy_achievements`, `fantasy_codex`, `fantasy_weekly_quests`, `fantasy_weekly_progress`, `fantasy_world_feed`

**Multiplayer:** `fantasy_parties`, `fantasy_party_members`, `fantasy_party_invites`, `fantasy_friends`, `fantasy_raid_runs`

**Content:** `fantasy_content_locations`, `fantasy_content_enemies`, `fantasy_content_items`, `fantasy_content_quest_defs`, `fantasy_content_shops`, `fantasy_content_inns`, `fantasy_content_dungeons`, `fantasy_content_recipes`, `fantasy_content_explore_materials`, `fantasy_content_boss_recipe_drops`

### Performance Indexes (22)
Created idempotently on every startup via `CREATE INDEX IF NOT EXISTS`. Covers: `char_id` on all player-scoped tables, `state+expires_at` on auction listings (partial), friends (both directions), party members/invites, weekly progress, world feed (created_at DESC), content enemies (location_slug), account vault (user_id).

### Key Character Columns (migrations)
```
guild_registered, guild_rank, guild_xp, guild_marks, arcane_tokens,
learned_abilities JSONB, active_abilities JSONB, active_abilities_pvp JSONB,
home_storage_bonus, event_state JSONB, arena_points, arena_state JSONB,
dungeon_state JSONB, companion JSONB, active_title, daily_login JSONB,
ability_ranks JSONB, raid_state JSONB, party_id INTEGER, unlocked_realms JSONB DEFAULT '["ashlands"]'
```

---

## Game Systems

### Classes (5 classes, 157 abilities total)
- **Warrior** (STR, baseHp 162, baseMp 12): 31 abilities (incl. Rallying Defense, Taunt). 7 combos.
- **Mage** (INT, baseHp 112, baseMp 40): 32 abilities (incl. Arcane Shield, Mana Font). 7 combos.
- **Rogue** (DEX, baseHp 120, baseMp 20): 31 abilities (incl. Smoke Screen, Expose Weakness). 7 combos.
- **Cleric** (WIS, baseHp 130, baseMp 35): 33 abilities (incl. Heal Other, Mass Heal, Resurrect Ally). 7 combos.
- **Ranger** (DEX/WIS, baseHp 130, baseMp 22): 32 abilities (incl. Hunter's Mark, Nature's Ward). 7 combos.

### Ability Rank Cost Scaling
Higher ranks = more powerful but more expensive MP. Formula: `max(baseCost × multiplier, baseCost + floor)`.

| Rank | Multiplier | Floor Add | 3 MP base → | 10 MP base → |
|------|-----------|-----------|-------------|--------------|
| 1 | ×1.0 | +0 | 3 MP | 10 MP |
| 2 | ×1.15 | +1 | 4 MP | 11 MP |
| 3 | ×1.35 | +2 | 5 MP | 13 MP |
| 4 | ×1.6 | +4 | 7 MP | 16 MP |
| 5 | ×2.0 | +5 | 8 MP | 20 MP |

The floor add ensures cheap abilities (1-3 MP base) still have meaningful cost increases at high ranks. This prevents infinite MP sustain through gear regen stacking.

### Ability Types
`physical, magic, heal, buff, restore, purify` — standard solo types
`party-buff, ally-heal, party-heal, ally-restore, ally-revive, party-debuff, taunt` — party support types (fall back to self-buff/self-heal in solo)

### 18 AoE Abilities (hit all enemies)
- Warrior: Cleave, Whirlwind, Ground Slam, War Stomp, Intimidate
- Mage: Chain Lightning (scales hits with rank: 2→4), Frost Nova, Meteor, Blizzard, Arcane Torrent
- Rogue: Fan of Knives, Blade Storm
- Cleric: Holy Nova, Divine Storm
- Ranger: Volley, Multi-Shot, Arrow Rain, Barrage

### Item Rarity Tiers (7)
`common, uncommon, rare, epic, legendary, mythic, exotic`

| Rarity | Socket Slots | Durability | Perks | Source |
|--------|-------------|-----------|-------|--------|
| common | 0 | 60 | — | Shops, drops |
| uncommon | 0 | 120 | — | Shops, drops |
| rare | 1 | 200 | 1 | Drops, Frosthollow+ shops |
| epic | 2 | 500 | 1-2 | Drops, Cinderport+ shops |
| legendary | 3 | 1000 | 2-3 | Drops only |
| mythic | 4 | 2000 | 3-4 | Dungeon bosses (1-3%), raid bosses |
| **exotic** | **5** | **3000** | **4-5** | **Party raid final boss only (18%)** |

Exotic items are **class-locked** (`classReq` field). Wrong class cannot equip.

### Shop Progression by Realm
- **Thornwall** (Ashlands): Common gear only
- **Ironhold** (Ashlands): Common + Uncommon gear
- **Sunspire** (Ashlands): Uncommon gear + consumables/materials (rares removed in balance pass)
- **Frosthollow** (Frostreach): Rare + Epic gear, realm-specific rare weapons/armor
- **Cinderport** (Emberveil): Rare (realm-specific) + Epic gear
- **Nexus Bastion** (Voidspire): Epic gear (realm-specific + general)

### Class Trainer (all realm hub towns)
Unified system replacing the former separate Academy and Class Trainer:
- **Available at**: Thornwall, Frosthollow, Cinderport, Nexus Bastion (any realm hub)
- **3 tabs**: Abilities (learn/loadout/upgrade), Quests, Specialization
- **Class quests**: 4 per class (one per realm), gate ability rank upgrades
  - Thornwall (lv5): Companion/class bonus choice → unlocks Rank 2
  - Frosthollow (lv12): Realm training → unlocks Rank 3
  - Cinderport (lv22): Advanced training → unlocks Rank 4
  - Nexus Bastion (lv38): Mastery quest → unlocks Rank 5
- **Max ability rank** = 1 + completed class quests (base rank 1, cap at 5)
- **Ability learning**: Costs Arcane Tokens (5-15 per ability)
- **Loadout**: Separate PvE and PvP loadouts, up to 6 abilities each
- **Respec**: 100 Arcane Tokens, resets Thornwall class quest only

### Crafting & Forge
- **Crafting** available at any realm hub town (not just Thornwall)
- **Forge** (socket, enchant, extract, apply crystal) available at any realm hub town
- **Home storage** (store, withdraw, upgrade) remains Thornwall-only
- Frontend shows "🏠 Return Home" at Thornwall, "🔨 Workshop & Forge" at other hubs

### Raid Tower (any realm's raidTown — Party Only)
- **Party formation**: At any realm's raidTown (Sunspire, Frosthollow, Cinderport, Nexus Bastion)
- **5 raids available**: See realm sections below
- **Locked-in**: No flee, no consumables, no travel during raids
- **Per-floor structure**: Lore → encounters (combat + choice events) → pre-boss recovery → boss
- **Choice events**: DC checks with real consequences (buffs/debuffs carry into combat)
- **Vote system**: All players vote on choices, majority wins, ties → leader
- **Loot**: Raid-exclusive legendary/mythic from bosses (25-30% chance, personal loot)
- **Exotic drops**: Final boss only, 18% per living player, class-locked
- **Death**: Player goes "down", auto-revives at 25% after combat. Full wipe = raid fails
- **Disconnect handling**: 3 missed rounds = auto-down, 60s no poll = disconnected badge, vote-kick

### Party System
- **Friends list**: Add/accept/remove by character name. Online status tracking (5-min threshold). 👥 button in nav panel opens slide-in overlay.
- **Party creation**: At any realm's raidTown (dynamic check via `isRaidTown()`). Leader creates, invites friends (must be at a raidTown).
- **Party size**: 2-5 players. All must be ready before leader can start.
- **Guards**: Party members cannot travel, explore, arena, or dungeon.
- **Stale cleanup**: On page load, buildState auto-clears party_id/raid_state if party is disbanded/gone.

### Party Combat Engine
- **Simultaneous submission**: All players submit actions per round, resolves when all are in
- **30s timeout**: Auto-defend for AFK players. 3s polling interval.
- **Resolution order**: Players (DEX order) → allies (pets/companions) → enemies
- **Enemy scaling**: HP × (1 + 0.5 × (partySize-1)), Boss HP × (1 + 0.6 × (partySize-1))
- **Rank-scaled MP costs**: Same formula as solo combat
- **Taunt system**: Warrior taunt redirects all enemy attacks to taunting player
- **Damage amp**: Expose Weakness / Hunter's Mark add % damage amplification to enemies
- **Combat state**: Lives on `fantasy_parties.combat_state`, not individual characters

### Realm System
- **4 realms** in `content/realms.json`: Ashlands (lv1-10), Frostreach (lv10-20), Emberveil (lv20-35), Voidspire (lv35-50)
- **All 4 realms fully populated** with zones, enemies, events, quests, shops, dungeons, raids
- **Portal quests**: Level-gated quests at each realm's hub town unlock the next realm
- **Realm-aware death respawn**: Players respawn at their current realm's hub town, not always Thornwall
- **Dynamic services**: Arena, AH, Raid Tower, Class Trainer, Crafting, Forge available at realm hub towns

### Realm 1: The Ashlands (Levels 1-10)
- 12 locations: 3 towns (Thornwall, Ironhold, Sunspire), 4 wild areas, 5 dungeons
- 2 raids: The Depths of Ashenmaw (3F easy, lv5+), The Iron Crucible (5F medium, lv8+)
- Portal quest: "The Northern Gate" at Sunspire (level 10) → unlocks Frostreach

### Realm 2: The Frostreach (Levels 10-20)
- 8 locations: 1 town (Frosthollow), 2 wild areas, 5 dungeons
- 30 enemies, 5 bosses, 8 materials, 42 events, 5 quests, 20 recipes
- 1 raid: The Frozen Throne (4F medium, lv14+)
- Portal quest: "The Ember Passage" at Frosthollow (level 20) → unlocks Emberveil

### Realm 3: The Emberveil (Levels 20-35)
- 8 locations: 1 town (Cinderport), 2 wild areas, 5 dungeons
- 30 enemies, 5 bosses, 8 materials, 42 events, 4 quests, 17 recipes
- 1 raid: The Infernal Sanctum (4F hard, lv25+)
- Portal quest: "The Rift Beyond" at Cinderport (level 35) → unlocks Voidspire

### Realm 4: The Voidspire (Levels 35-50)
- 8 locations: 1 town (Nexus Bastion), 2 wild areas, 5 dungeons
- 30 enemies, 5 bosses, 8 materials, 42 events, 4 quests, 16 recipes
- 1 raid: The Unraveling (5F hard, lv40+) — endgame raid with strongest items

### Enemy Balance (April 2026 rebalance)
All 179 enemies rebalanced with consistent formulas:
- **HP**: `lv^1.7 × 25 + 30` (boss: ×3.5), ±12% variety
- **ATK**: `lv × 2.2 + 6` (boss: ×1.3), ±10% variety
- **DEF**: `lv × 1.3 + 2` (boss: ×1.4), ±10% variety
- **XP**: `xpForLevel(lv) / targetKills` (boss: ×3.0), target 8→28 kills/level across lv1-50
- **Gold**: `XP × 0.45` (boss: ×2.5)
- **Enemy groups**: 60 groups across all 30 combat zones (2 per zone), 20% spawn chance

### Content Totals
- **534 items**: equipment (9 slots), consumables, materials (42 types), gems (18), crystals, recipes, raid-exclusive (52), exotic (25)
- **157 abilities**: 5 classes × ~31 each (incl. 11 party support abilities)
- **179 enemies** across 30 combat zones + raid-exclusive enemies across 5 raids
- **181 exploration events** across wild/dungeon zones (6+ per zone)
- **60 enemy groups** across 30 combat zones (multi-enemy encounters)
- **36 locations** across 4 realms: 6 towns, 8 wild areas, 20 dungeons, 2 boss dungeons
- **4 realms** fully populated: Ashlands (1-10), Frostreach (10-20), Emberveil (20-35), Voidspire (35-50)
- **5 raids**: The Depths (3F easy), Iron Crucible (5F medium), Frozen Throne (4F medium), Infernal Sanctum (4F hard), The Unraveling (5F hard)
- **110 crafting recipes** (15 boss-exclusive requiring scroll discovery)
- **58 location quests** + **20 class quests** (4 per class across 4 realms)
- **48 achievements** across 6 categories (all triggers wired)
- **35 ability combos** (7 per class)
- **17 codex guide pages**

---

## API Endpoints

### Auth
- `POST /api/register`, `POST /api/login`, `POST /api/logout`
- `POST /api/reset-password` — Resets password by handle (no email verification — accepted risk for playtest)

### Game State
- `GET /api/fantasy/state` — Full game state (incl. stale party cleanup). Separate poll rate limit.
- `GET /api/fantasy/data` — Static game data (classes, items, enemies, raids, combos, codex guide, realms, questDefs, questStageCounts)
- `POST /api/fantasy/create`, `POST /api/fantasy/switch-character`, `POST /api/fantasy/reset`

### Combat & Exploration
- `POST /api/fantasy/travel`, `POST /api/fantasy/travel-path`
- `POST /api/fantasy/explore`, `POST /api/fantasy/combat/action`
- `POST /api/fantasy/dungeon/leave`
- `POST /api/fantasy/event/resolve`, `POST /api/fantasy/event/dismiss`

### Class Trainer (absorbs former Academy endpoints)
- `POST /api/fantasy/class-trainer` — Get trainer state (quests, companion, abilities, maxAbilityRank)
- `POST /api/fantasy/class-trainer/accept` — Accept class quest (location-gated)
- `POST /api/fantasy/class-trainer/choice` — Advance class quest
- `POST /api/fantasy/class-trainer/set-ability` — Set companion active ability
- `POST /api/fantasy/class-trainer/respec` — Reset companion/class bonus (100 tokens)
- `POST /api/fantasy/academy/learn` — Learn ability (redirects through class-trainer)
- `POST /api/fantasy/academy/equip` — Swap loadout (redirects through class-trainer)
- `POST /api/fantasy/academy/upgrade` — Upgrade ability rank (rank-capped by class quests)

### Friends
- `GET /api/fantasy/friends` — List friends + incoming/outgoing requests + online status
- `POST /api/fantasy/friends/add`, `POST /api/fantasy/friends/accept`, `POST /api/fantasy/friends/remove`

### Party
- `POST /api/fantasy/party/create` — Create party at any raidTown
- `POST /api/fantasy/party/invite` — Invite friend (must be at a raidTown)
- `POST /api/fantasy/party/accept`, `POST /api/fantasy/party/decline`
- `POST /api/fantasy/party/leave`, `POST /api/fantasy/party/kick`
- `POST /api/fantasy/party/ready`, `POST /api/fantasy/party/start`
- `GET /api/fantasy/party/poll` — 5s poll (separate generous rate limit)

### Party Raid & Combat
- `POST /api/fantasy/party/raid/advance`, `POST /api/fantasy/party/raid/choice`
- `POST /api/fantasy/party/raid/floor-choice`, `POST /api/fantasy/party/raid/dismiss`
- `POST /api/fantasy/party/combat/action` — Submit action for current round
- `GET /api/fantasy/party/combat/poll` — 3s poll (separate generous rate limit)

### Tutorial
- `POST /api/fantasy/tutorial/complete` — Claims tutorial completion reward (200g + 1 arcane token, one-time via `daily_login.tutorialDone` flag)

### Items, Shop, Guild, Auction, Arena, Forge, Home, Progression, Admin
(All existing endpoints unchanged)

---

## Known Issues & Gotchas

1-16: (All previous gotchas still apply)

17. **Party state cleanup**: If a raid errors out or browser closes mid-raid, characters can get stuck with stale `party_id`/`raid_state`. `buildState()` auto-cleans this on page load.

18. **Party combat charId types**: After JSON serialization, player IDs become strings. All DB queries use `Number(p.charId)`.

19. **Non-leader raid visibility**: Party poll returns `raidState` and `combat` when `in_raid`. Frontend auto-starts combat polling for all members on transition.

20. **Exotic items class-lock**: Equip endpoint checks `classReq`. Wrong class gets error message.

21. **Raids are party-only**: Solo raid endpoints exist but frontend only shows "Create Raid Party".

22. **Realm travel guards**: Both single-hop and multi-hop travel check `dest.realm` against `unlocked_realms`. Portal connections injected into BFS from `realms.json`.

23. **Dynamic services**: Arena, AH at any town. Raid Tower, Class Trainer, Crafting, Forge at any hub town. No more hardcoded location checks.

24. **Enemy scaling**: `buildScaledEnemy()` applies level-based ATK floor (`charLevel * 1.8 + 4` for bosses, 70% for non-bosses) and diminishing-returns HP/ATK/DEF scaling based on level gap. NOTE: This can make low-level bosses extremely tanky when fought by high-level players — by design to prevent trivializing old content, but may need further tuning.

25. **Realm-aware death respawn**: Death in PvE combat or exploration events respawns at current realm's hub town via `getRespawnLocation()`. Falls back to Thornwall if realm data missing.

26. **Game log pruning**: `addLog()` auto-prunes every 50th insert, keeping last 500 entries per character. Runs outside transactions to avoid locks.

27. **Character deletion cleanup**: Reset endpoint now cleans 15+ tables including bounty_progress, arena_runs, codex, achievements, weekly_progress, raid_runs, friends, party data, arena_store, and cancels active auction listings.

28. **Academy merged into Class Trainer**: `systems/academy.js` is a no-op stub. All academy API endpoints (`/api/fantasy/academy/*`) are registered by `systems/class-trainer.js`. Frontend redirects `storyView='academy'` to class trainer.

29. **Ability rank cost scaling**: Higher ranks cost more MP via `getAbilityRankCost(base, rank)` in `shared/game-logic.js`. Applied in solo combat, party combat, and frontend display. Prevents infinite MP sustain through gear regen stacking.

30. **Connection loss detection**: Frontend tracks consecutive poll failures (`_pollFailures`). After 3 failures, shows red "Connection lost" banner. Auto-hides on recovery. Applied to both party and combat polling.

31. **Starting gold and gear**: New characters start with 120g (was 30g), class-appropriate weapon auto-equipped, 3 HP potions + 2 MP potions. Enough to buy body armor + shield + helmet at Thornwall.

32. **Explore gating**: Wild zones require completing available quests before free exploration. This is intentional — drives quest-driven progression. Dungeons are not gated.

33. **Quest presentation overhaul**: Quests use a full-takeover "quest mode" with stage pacing (text first, then choices), outcome weight (pass/fail visual moment), and a completion overlay. DC/combat tags hidden from choices — players read flavour text instead of min-maxing stats. Roll results still shown after choosing.

34. **Image asset system**: Enemy portraits and location backgrounds loaded from `public/enemies/` and `public/locations/` as PNGs named by slug. Frontend uses `onerror` to gracefully hide missing images. Combat UI shows enemies in a horizontal gallery with portraits, and location backgrounds at 30% opacity behind the combat box.

35. **Guided tutorial system**: 12-step non-blocking tutorial banner that guides new characters through: market → filter by class → buy → equip → durability → travel to Whispering Woods → accept quest → complete quest → return to Thornwall → rest at inn → repair tab → completion. Progress stored in `localStorage` (`tutorial_guided_{charId}`). Grants 200g + 1 arcane token on completion via `/api/fantasy/tutorial/complete`. Separate 5-step combat spotlight tutorial triggers on first combat (attack, defend, momentum, abilities, flee). Old system-tip banners removed.

36. **Tutorial quest**: "The Lost Woodcutter" (lv1) at Whispering Woods — 4-stage rescue quest with forced wolf combat at the end to trigger the combat tutorial. Low DCs (7-8) suitable for fresh characters.

---

## Build Roadmap

### Completed ✅
- Phase 0-3: Quick wins, UX, Arena, Forge (March 2026)
- Tier 1-2D: Production readiness, architecture, combat overhaul, progression, onboarding (March 2026)
- Combat Enrichment: Ability ranks, momentum, combos (April 2026)
- Game Codex: 8 sections including Raids (April 2026)
- **Raid Tower**: 5 raids across 4 realms, party-only (April 2026)
- **Multiplayer**: Friends list, party system, party combat engine (April 2026)
- **Party Support Abilities**: 11 new abilities across 5 classes (April 2026)
- **Exotic Rarity**: Class-locked party-only drops, 25 items across 5 raids (April 2026)
- **AoE Audit**: 18 abilities converted to AoE, purify/restore rank scaling fixed (April 2026)
- **Target Selection UI**: Click enemies/allies to target in party combat (April 2026)
- **Enemy Damage Tuning**: ATK floor scaling + offense multiplier increase (April 2026)
- **Multi-Realm System**: 4 realms fully populated, portal quests, realm-aware travel/map/services (April 2026)
- **Graph-based Map System**: Force-directed auto-layout, icon-only minimap, realm switcher (April 2026)
- **Disconnect Handling**: AFK auto-down (3 rounds), disconnect detection, vote-kick (April 2026)
- **Racial Passives**: 5 unique passives + racial abilities (April 2026)
- **Game Audit & Fixes**: Combat bug fix (racial passive scoping), death respawn fix, 13 achievement triggers wired, DB indexes (22), game log pruning, character deletion cleanup, inline level-up fix (April 2026)
- **System Consolidation**: Academy merged into Class Trainer, party formation at any raidTown, crafting/forge at all hub towns, XSS escaping, centralized GAME_CONFIG, class-appropriate starter gear (April 2026)
- **Class Quest Expansion**: 20 class quests (4 per class, one per realm) gating ability rank upgrades (April 2026)
- **Enemy Rebalance**: All 179 enemies rebalanced with consistent formulas, smooth XP curve (8→28 kills/level), Ashlands lv6-8 enemy stats normalized, Frostreach/Emberveil/Voidspire XP boosted 4-8x (April 2026)
- **Ability Rank Cost Scaling**: `max(base × mult, base + floor)` formula prevents infinite MP sustain at high ranks (April 2026)
- **QoL**: Enemy groups for all 30 combat zones, rate limit fix for party polling, connection loss detection, 120g starting gold, auto-equipped starter weapon (April 2026)

- **Polish Phase**: DC tag removal, quest presentation overhaul, image system (locations + enemies), guided tutorial, combat tutorial (April 2026)

### Active / Next
- **More enemy portraits** — 70/179 done (all Ashlands except Witch's Tower and Dragon Peak). Frostreach, Emberveil, Voidspire still needed.
- **Player/companion portraits** — Currently using placeholders (bandit/wolf). Need per-class and per-companion-type images.
- **Sound system** — Architecture planned in `~/polish.txt`. Combat SFX, ambient zones, UI sounds, music.
- **Combat UI redesign** — Deferred until images phase complete. Layout spec needed for enemy sprites with animations.

### Future (Unscheduled)
- Sounds, WebSocket migration, crafting system redo, PvP improvements
- Combat.js decomposition (1365-line function → smaller modules)
- Shared combat core between solo and party combat
- Map upgrade with illustrated realm backgrounds and fog of war

---

## Content Addition Patterns

### Adding a New Realm
1. Add realm entry to `content/realms.json` (slug, name, levelRange, portalFrom/To, hub, raidTown)
2. Run `node scripts/gen-realm.js --slug <slug> --town <town> --levels <min>-<max> ...` to generate zone skeletons
3. Fill in `[FILL]` placeholders in generated zone files (enemies, descriptions, events, boss lore)
4. Add portal quest to `content/quests/portals.json` (type: 'portal', portalUnlocks: '<slug>')
5. Add realm-specific items to `content/items/`
6. Add class quests for the realm to `content/class-quests.json` (prerequisite chain, location, ranksUnlocked)
7. Restart server — everything auto-loads

### Adding Raids
Create `content/raids/<slug>.json` with: slug, name, difficulty, floorCount, levelReq, icon, description, loreIntro, rewards, enemies[], floors[] (each with lore, encounters, boss), completionLore. Raid-exclusive items go in `content/items/raid-<slug>.json` and `content/items/raid-<slug>-exotic.json`. Server auto-loads from `content/raids/` directory.

### Adding Items
Edit the appropriate file in `content/items/`, then restart server (auto-syncs from content/ directory).

### Adding Enemies
Edit `content/zones/<location>.json`, add to the `enemies` array. Use the balance formulas for consistent stats:
- HP: `lv^1.7 × 25 + 30` (boss ×3.5)
- ATK: `lv × 2.2 + 6` (boss ×1.3)
- DEF: `lv × 1.3 + 2` (boss ×1.4)
- XP: `xpForLevel(lv) / (12 + lv × 0.36)` (boss ×3.0)
- Gold: XP × 0.45 (boss ×2.5)
Add ±10-15% variety. Add `enemyGroups` array for multi-enemy encounters (20% spawn chance).

### Adding Quests
Add to `content/quests/<location>.json`. Follow the 6-stage linear structure with DC checks.

### Adding Images
- **Enemy portraits**: Save as `public/enemies/{slug}.png` (512×768, portrait orientation, dark background). Frontend auto-detects via `onerror` fallback.
- **Location backgrounds**: Save as `public/locations/{slug}.png` (1200×480, wide landscape, bottom fading to dark). Used as location banner and combat backdrop.
- **Prompt generation**: Enemy/location prompts can be generated from content data. See `~/image-prompts-prototype.txt` and `~/monster-list.txt` for format.
- **Style**: Dark fantasy, painterly, muted tones, no text/watermarks. Consistent across all images.

### Adding Class Quests
Add to `content/class-quests.json` under the class key. Required fields: `slug`, `title`, `class`, `requiredLevel`, `location` (hub town slug), `prerequisite` (slug of previous quest or null), `ranksUnlocked` (2-5), `description`, `stages[]`, `rewards`. The class trainer UI auto-discovers quests and shows location/prerequisite requirements.
