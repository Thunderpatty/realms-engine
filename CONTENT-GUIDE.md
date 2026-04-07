# Content Guide — How to Re-Lore Your World

This guide explains how to replace the default fantasy world with your own
lore, characters, locations, and stories. The game engine is content-driven —
almost everything the player sees comes from JSON files in the `content/`
directory and `game-config.json`.

---

## Quick Start: What to Change

| What | Where | Impact |
|------|-------|--------|
| **World map & locations** | `content/zones/*.json` | Towns, wilds, dungeons |
| **Enemies & bosses** | `content/zones/*.json` | Creatures players fight |
| **Quests & stories** | `content/quests/*.json` | Narrative content |
| **Items & equipment** | `content/items/*.json` | Gear, consumables, materials |
| **Exploration events** | `content/zones/*.json` (events) | Random encounters |
| **Raids (group dungeons)** | `content/raids/*.json` | Multi-floor party content |
| **Crafting recipes** | `content/recipes.json` | What players can craft |
| **Realms (world regions)** | `content/realms.json` | Overworld structure |
| **Classes & abilities** | `game-config.json` | Player classes, skills |
| **Races** | `game-config.json` | Player race options |
| **Images** | `public/enemies/`, `public/locations/` | Art assets |
| **Game title** | `server.js`, `public/fantasy-rpg.html` | Displayed name |
| **Tutorial** | `public/fantasy-rpg-app.js` | New player guidance |

---

## File-by-File Guide

### content/realms.json
Defines the world's regions. Each realm has a level range and connects
to others via portal quests.

```json
[
  {
    "slug": "ashlands",           // Unique ID (no spaces, lowercase)
    "name": "The Ashlands",       // Display name
    "description": "A harsh frontier...",
    "icon": "🏔",
    "order": 1,                   // Display order
    "levelRange": [1, 10],        // Suggested levels
    "hub": "thornwall",           // Main town slug
    "raidTown": "sunspire",       // Town where raids launch
    "portalFrom": null,           // Slug of realm you come from
    "portalTo": "frostreach"      // Slug of realm you go to
  }
]
```

**To re-lore:** Change names, descriptions, icons. Keep the slug structure.
If you rename slugs, update all references in zone files and quest files.

---

### content/zones/*.json
Each file defines ONE location. This is where most of your world lives.

```json
{
  "location": {
    "slug": "thornwall",
    "name": "Thornwall Village",
    "type": "town",              // "town", "wild", or "dungeon"
    "description": "A humble frontier village...",
    "connections": ["whispering-woods", "kings-road", "ironhold"],
    "realm": "ashlands"
  },
  "shopItems": ["iron-sword", "leather-armor"],   // Item slugs sold here
  "innCost": 10,                                   // null if no inn
  "enemies": [],                                   // Empty for towns
  "events": [],                                    // Exploration events
  "enemyGroups": [],                               // Multi-enemy encounters
  "dungeonConfig": null                            // Only for dungeons
}
```

**For wild/dungeon zones with enemies:**
```json
"enemies": [
  {
    "slug": "timber-wolf",
    "name": "Timber Wolf",
    "level": 1,
    "hp": 45,
    "attack": 8,
    "defense": 3,
    "xp": 15,
    "gold": 7,
    "boss": false
  }
]
```

**Enemy stat formulas (for balance):**
- HP: `level^1.7 × 25 + 30` (boss: ×3.5)
- ATK: `level × 2.2 + 6` (boss: ×1.3)
- DEF: `level × 1.3 + 2` (boss: ×1.4)
- XP: Enough so players need 8-28 kills per level
- Gold: XP × 0.45 (boss: ×2.5)

**Enemy groups (multi-enemy encounters, 20% chance):**
```json
"enemyGroups": [
  { "name": "Wolf Pack", "enemies": ["timber-wolf", "timber-wolf", "rabid-fox"] },
  { "name": "Forest Ambush", "enemies": ["bandit-scout", "bandit-scout"] }
]
```

**Exploration events:**
```json
"events": [
  {
    "slug": "old-campfire",
    "name": "Abandoned Campfire",
    "icon": "🔥",
    "type": "discovery",
    "rarity": "common",
    "text": "You find the remains of a campfire...",
    "choices": [
      {
        "label": "Search the ashes",
        "check": { "stat": "wis", "dc": 8 },
        "success": { "text": "You find coins!", "xp": 10, "gold": 15 },
        "failure": { "text": "Nothing but soot.", "xp": 5 }
      }
    ]
  }
]
```

**Dungeon config:**
```json
"dungeonConfig": {
  "name": "Dark Hollow",
  "rooms": 5,
  "mechanic": "darkness",       // "darkness", "arcane-disruption", "scorching-heat", "cursed-ground", "cave-ins"
  "bossRoom": true
}
```

---

### content/quests/*.json
One file per location. Each file is an array of quests.

```json
[
  {
    "slug": "wolves-of-thornwall",
    "title": "Wolves at the Gate",
    "location": "thornwall",       // Must match a zone slug
    "minLevel": 1,
    "description": "Short description shown before accepting.",
    "stages": [
      {
        "text": "The story text for this stage...",
        "choices": [
          {
            "next": 1,                              // Index of next stage
            "label": "What the player sees",
            "check": { "stat": "str", "dc": 8 }     // Optional stat check
          },
          {
            "next": 1,
            "label": "Fight the wolf",
            "combat": "timber-wolf"                  // Optional: triggers combat
          }
        ]
      },
      {
        "text": "The quest is complete!",
        "complete": true                             // Marks final stage
      }
    ],
    "rewards": { "xp": 40, "gold": 25, "item": "iron-sword" }
  }
]
```

**Tips:**
- Stats for checks: `str`, `dex`, `int`, `wis`, `con`, `cha`
- DC 7-8 is easy, 10-12 is medium, 14+ is hard
- `combat` value must match an enemy slug from any zone
- Players see choices WITHOUT knowing the DC or stat — they choose by flavour text
- Keep 3-6 stages per quest for good pacing

---

### content/items/*.json
Items are organized by slot. Each file is a `{ "slug": { ... } }` object.

```json
{
  "iron-sword": {
    "name": "Iron Sword",
    "type": "weapon",            // weapon, shield, body, helmet, gloves, boots, amulet, ring, trinket, consumable, material
    "rarity": "common",         // common, uncommon, rare, epic, legendary, mythic, exotic
    "buy": 30,                   // Shop price (null = not sold)
    "sell": 15,                  // Sell price
    "stats": { "attack": 5 },
    "description": "A sturdy iron blade."
  }
}
```

**Consumables:**
```json
{
  "hp-potion": {
    "name": "HP Potion",
    "type": "consumable",
    "rarity": "common",
    "buy": 15, "sell": 5,
    "use": { "heal": 30 },
    "description": "Restores 30 HP."
  }
}
```

---

### game-config.json
The big one. Contains classes, abilities, races, combos, and system config.

**Key sections to re-lore:**
- `classes[]` — Name, description, primary stat, base HP/MP, abilities
- `racialPassives` — Race bonuses
- `combos[]` — Ability combo chains
- `classBonuses` — Companion class bonuses
- `homeLocation` — Slug of the starting/home town

**You probably DON'T need to change:**
- `statusEffects` — Engine mechanics
- `guildRanks` — Progression tiers
- `perkPools` — Random perk generation
- `gemTypes`, `enchantCosts`, etc. — System mechanics

---

### content/raids/*.json
Multi-floor party dungeons. Complex but powerful.

```json
{
  "slug": "the-depths",
  "name": "The Depths of Ashenmaw",
  "difficulty": "easy",
  "levelReq": 5,
  "floorCount": 3,
  "icon": "🕳",
  "description": "A dark cave system...",
  "enemies": [ { "slug": "cave-horror", "name": "Cave Horror", "level": 6, ... } ],
  "floors": [
    {
      "floor": 1,
      "name": "The Entry",
      "lore": "You descend into darkness...",
      "encounters": [ ... ],
      "boss": { "slug": "cave-horror-alpha", ... }
    }
  ]
}
```

Raid-exclusive items go in `content/items/raid-{slug}.json`.

---

## Images

### Enemy Portraits
- **Location:** `public/enemies/{slug}.png`
- **Size:** 512×768 pixels (portrait orientation)
- **Format:** PNG
- **Style:** Dark background, centered creature
- The game auto-detects images by slug. Missing images gracefully fall back to text-only.

### Location Backgrounds
- **Location:** `public/locations/{slug}.png`
- **Size:** 1200×480 pixels (wide landscape)
- **Format:** PNG
- **Style:** Dark fantasy landscape, bottom edge fading to darkness
- Shown as a banner at the top of each location and at 30% opacity behind combat.

### Generating with AI
If you use Stable Diffusion or similar:
- Use a consistent style prefix across all images
- Enemy prompt: `[style], [creature description], dark background`
- Location prompt: `[style], wide panoramic, [place description], bottom fading to darkness`
- Generate 4-8 per prompt, pick the best

### Placeholder Images
- `player-placeholder.png` — Shown for the player in combat
- `companion-placeholder.png` — Shown for companions
- Replace these with class-specific or companion-specific portraits

---

## Re-Loring Checklist

1. **Choose your world name** — Update `<title>` in `public/fantasy-rpg.html` and the server startup message in `server.js`
2. **Design your realms** — Edit `content/realms.json` with your world regions
3. **Create your locations** — One JSON file per zone in `content/zones/`
4. **Write your enemies** — Add to each zone file's `enemies` array
5. **Write your quests** — One JSON file per location in `content/quests/`
6. **Create your items** — Edit files in `content/items/`
7. **Add exploration events** — In each zone file's `events` array
8. **Rename classes/races** — Edit `game-config.json` (keep the mechanical structure)
9. **Update the tutorial** — Edit `GUIDED_TUTORIAL` and `COMBAT_TUTORIAL_STEPS` in `public/fantasy-rpg-app.js` to reference your starting locations
10. **Add your art** — Drop PNGs in `public/enemies/` and `public/locations/`
11. **Update `homeLocation`** — In `game-config.json`, set to your starting town slug
12. **Test!** — Create a character and play through the first hour

---

## Gotchas

- **Slug consistency**: Enemy slugs in quests (`"combat": "timber-wolf"`) must match an enemy defined in some zone file
- **Location connections**: Every zone must be reachable via connections from another zone. Test by traveling the map
- **Starting realm**: The default unlocked realm is `ashlands` (hardcoded in DB default). Change in `db/schema.js` if you rename it
- **Home location**: Set `homeLocation` in `game-config.json`. The home storage system only works at this location
- **Item slugs in shops**: `shopItems` arrays reference item slugs — they must exist in `content/items/`
- **Restart required**: After editing content files, restart the server. Content auto-syncs to the database on startup
- **Balance**: Use the stat formulas above for enemies. The game is tuned for 8-28 kills per level. Wildly different stats will break progression

---

## Using Pi (AI Agent)

If you have a Pi agent instance, copy `SKILL.md` to your Pi skills directory:
```
cp SKILL.md ~/.pi/agent/skills/your-game-name/SKILL.md
```

Edit the skill name and description to match your world. The skill file
documents the full engine architecture, all API endpoints, database tables,
and content patterns. Your Pi agent can then help you:

- Add new zones, enemies, quests, items, and raids
- Debug server issues
- Balance enemy stats
- Generate image prompts for your art style
- Extend game systems
