# Realms of Ash & Iron — Fantasy RPG

A persistent-world text fantasy RPG with turn-based combat, crafting, PvP duels, an auction house, guild bounties, multi-floor party raids, an arena horde mode, and a class spec engine. Designed to be re-skinned with your own lore.

## Quick Start

```bash
git clone https://github.com/Thunderpatty/realms-engine.git
cd realms-engine
./setup.sh --defaults   # installs Node, Postgres, and seeds the DB
node server.js          # starts the game on port 8080
```

Then open `http://127.0.0.1:8080` in a browser.

The installer prompts for DB credentials and writes them to `.env`. Run `./setup.sh` without `--defaults` to step through the prompts interactively.

## Re-loring the World

The engine is content-driven — almost everything the player sees comes from JSON in `content/` and `game-config.json`. To replace the default fantasy world with your own lore, locations, enemies, items, and quests, see **[CONTENT-GUIDE.md](CONTENT-GUIDE.md)** — it walks through every file you'll touch, with examples.

## Architecture (the short version)

- **Node.js + Express 5** server, single process
- **PostgreSQL** for game state, sessions, characters, inventory, auctions, parties, raids
- **Server-Sent Events** push real-time party/raid/combat updates; polling fallback for proxies that drop SSE
- **Class spec engine** (`shared/class-specs.js`) is a single source of truth for specialization mechanics — solo combat and party combat call the same hooks
- **Content loader** reads from `content/` (canonical) or falls back to legacy seed files

### File layout

```
server.js                # Express app, auth, startup
fantasy-rpg.js           # RPG router: content loading, admin routes, game data API
fantasy-duel.js          # PvP duels: lobby, turn-based combat, wagers
postgres-runtime.js      # Embedded Postgres bootstrap

shared/
  game-logic.js          # Pure combat/stat/perk/scaling functions (testable, no DB)
  game-config.js         # Shared require() for game-config.json
  class-specs.js         # Specialization hook points used by both combat engines

systems/
  combat.js              # Solo combat engine
  party.js               # Party formation, lobby, invites, ready check
  party-combat.js        # Group combat engine
  raid.js                # Multi-floor raid runs, completion stats, best times
  combat-timer.js        # setTimeout-based round deadline manager
  sse.js                 # Server-Sent Events stream + PG LISTEN/NOTIFY bus
  arena.js               # Arena horde mode
  forge.js               # Gem socketing, enchanting, crystal application
  guild.js               # Adventurer's Guild, bounties, vendor
  class-trainer.js       # Learn/swap abilities, ability ranks, PvE/PvP/Raid loadouts
  auction.js             # Player-to-player auction house
  shop.js / quests.js / friends.js / characters.js / progression.js
  exploration.js / home.js / academy.js (legacy)

content/                 # Canonical game content (zones, items, quests, raids, recipes, codex)
db/schema.js             # Schema + additive migrations + indexes (auto-applied on boot)
public/                  # SPA shell, client JS, images, audio, leaderboard
tests/                   # vitest suites
```

## Server Operations

Start the server:
```bash
node server.js
# or daemonized:
nohup node server.js > server.log 2>&1 &
```

Stop:
```bash
pkill -f "node server.js"
```

Backup the database:
```bash
pg_dump -Fc thunderpattyrpg > backup-$(date +%Y%m%d).dump
```

The server re-runs additive DB migrations on every boot — they're idempotent, so restarting after a `git pull` is safe.

## Configuration

Configuration lives in `.env` (created by `setup.sh`). Key vars:

| Var | Purpose |
|-----|---------|
| `PORT` | HTTP port (default 8080) |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | DB connection |
| `SESSION_SECRET` | Express session signing key |
| `SESSION_NAME` | Session cookie name (set differently for dev/prod if running both) |
| `RATE_LIMIT_AUTH` / `RATE_LIMIT_GAME` / `RATE_LIMIT_POLL` | Per-route rate limits (auth/game/polling endpoints have separate buckets) |

See `.env.example` for the full list with defaults.

## License

This repository contains the game engine and a default fantasy content set. The content is provided as a starting template — you're encouraged to replace it with your own world. See `CONTENT-GUIDE.md`.
