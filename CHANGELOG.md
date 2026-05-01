# Changelog

## v2.0 — 2026-05-01

### Realtime party + raid (the headline)
- **Server-Sent Events** stream at `/api/fantasy/party/stream` pushes party, raid, and combat state to all members in real time. PostgreSQL `LISTEN/NOTIFY` bus; 30s heartbeats; auto-reconnect.
- **Polling kept as failsafe** (20s when SSE is connected, 5s if it isn't) — works through proxies and networks that drop SSE.
- **Combat timer** uses server-side `setTimeout` for round deadlines instead of polling. Round expirations fire instantly and push to all members.

### Raids
- Separate **Raid loadout slot** alongside PvE and PvP — pre-configure your raid ability set.
- **No consumables mid-raid** — raids are designed around in-raid recovery choices.
- **Best-time tracking** per raid; per-character clear stats include best clear time.
- Richer pre-raid lobby flow: select raid → ready check → start, with live updates to every member.

### Combat
- **Class spec engine** rewritten as a single source of truth. Solo and party combat now share the same spec hooks (`onHit`, `onKill`, `mpCost`, `critChance`, `dmgDealt`, `dmgTaken`, etc.). Adding a new spec is one entry; both engines pick it up.
- **Ability ranks rebalanced cheaper** — higher ranks now cost ~10-15% less MP across the board.
- 158 total abilities across 5 classes; 12 class specializations with 4 tiers each.
- Internal combat balance pass (~230 lines of tweaks across damage, status, scaling).

### Quality of life
- **Quest stat checks** now show the dice breakdown (`d20:14+5=19 vs DC 12`) instead of just the total. Fixes a long-standing display bug.
- **Friend requests over realtime** — accepts and incoming requests push instantly.
- **Inventory scroll position** preserved when refreshing the modal mid-session.
- **Audio system** for ambient music with per-track fade and mute toggle.

### Database
- 28 additive migrations apply automatically on server boot; 22 new performance indexes. Existing players carry forward; no manual migration step required.

### Upgrade notes
- **Recommended:** fresh clone + `./setup.sh --defaults` against a fresh database for the cleanest install.
- **In-place upgrade**: `git pull && node server.js` will work — DB migrations are additive and idempotent. **Back up your DB first** (`pg_dump -Fc thunderpattyrpg > rpg-backup.dump`).
- Class balance changes (ability rank cost curve, spec engine reworks) may invalidate optimal builds from v1; characters and progression carry forward intact.

---

## v1 — initial release

Initial public release of the Realms Engine — content-driven fantasy RPG with combat, crafting, quests, guild bounties, auction house, PvP duels, arena, forge, party raids, and a multi-region world.
