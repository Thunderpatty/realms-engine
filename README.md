# Realms Engine

A full-featured text-based fantasy RPG with a web interface. Content-driven
architecture — swap out the JSON files to create your own world.

## Features

- **4 realms** with 36 locations (towns, wilderness, dungeons)
- **5 classes** with 157 abilities, ability ranks, momentum, and 35 combos
- **5 races** with unique racial passives and abilities
- **179 enemies** with balanced stats and multi-enemy group encounters
- **58 quests** with branching narratives and stat checks
- **5 raids** (party-only, 2-5 players) with exclusive loot
- **Crafting** with 110 recipes and a forge system (gems, enchants, crystals)
- **Arena** wave survival mode with leaderboard
- **Auction house**, guild system with bounties, PvP duels
- **Achievement system** (48 achievements), daily login rewards, weekly quests
- **Multiplayer** friends list, party system, party combat
- **Image support** for enemy portraits and location backgrounds
- **Guided tutorial** for new players
- **Responsive** web UI — works on desktop and mobile

## Requirements

- **Node.js** 18+ (24 recommended)
- **PostgreSQL** 16+
- A modern web browser

## Quick Start

```bash
git clone https://github.com/Thunderpatty/realms-engine.git
cd realms-engine
chmod +x setup.sh
./setup.sh
```

The setup script will:
1. Install Node.js 20 and PostgreSQL if missing (Ubuntu/Debian)
2. Prompt for database credentials (or use `--defaults` for unattended install)
3. Create the database and user
4. Generate your `.env` configuration
5. Install dependencies
6. Verify the database connection

For fully unattended install (uses all defaults):
```bash
./setup.sh --defaults
```

Then start the server:
```bash
node server.js
```

Open `http://localhost:8080` in your browser.

## Making It Your Own

The game is designed to be re-lored. See **[CONTENT-GUIDE.md](CONTENT-GUIDE.md)**
for a complete guide to replacing the world, characters, enemies, quests,
and art with your own.

**Quick version:**
1. Edit `content/realms.json` — your world regions
2. Edit `content/zones/*.json` — your locations, enemies, events
3. Edit `content/quests/*.json` — your stories
4. Edit `content/items/*.json` — your gear and loot
5. Edit `game-config.json` — your classes, races, abilities
6. Drop art in `public/enemies/` and `public/locations/`
7. Restart the server

## Project Structure

```
├── setup.sh              # One-step installer (deps + DB + config)
├── .env.example          # Configuration template
├── server.js             # Express server, auth, sessions
├── fantasy-rpg.js        # Game engine core
├── game-config.json      # Classes, abilities, races, system config
├── content/              # ← YOUR WORLD GOES HERE
│   ├── realms.json       # World regions
│   ├── zones/            # Locations (1 file per zone)
│   ├── quests/           # Quests (1 file per location)
│   ├── items/            # Items by category
│   ├── raids/            # Raid definitions
│   ├── recipes.json      # Crafting recipes
│   └── ...
├── public/               # Frontend
│   ├── enemies/          # Enemy portrait PNGs
│   ├── locations/        # Location background PNGs
│   ├── fantasy-rpg.html  # Main game page
│   └── fantasy-rpg-app.js # Client-side JS
├── systems/              # Server subsystems
├── shared/               # Shared game logic
├── db/                   # Database schema
└── tests/                # Test suite (195 tests)
```

## Running Tests

```bash
npm test
```

Unit tests (stats, combat, content validation) run without a database.
Integration tests require a running server instance.

## Production Deployment

```bash
npm install -g pm2
pm2 start server.js --name my-rpg
pm2 save
pm2 startup
```

## AI Agent Support

If using a Pi agent, copy `SKILL.md` to your skills directory for
full engine documentation. The agent can help add content, debug
issues, balance enemies, and extend game systems.

## License

This is a personal project shared for educational and creative use.
