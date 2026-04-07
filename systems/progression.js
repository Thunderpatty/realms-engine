// ═══════════════════════════════════════════════════════════════
// PROGRESSION — Achievements, Codex, Titles, World Feed, Weekly Quests, Daily Login
// ═══════════════════════════════════════════════════════════════

const path = require('path');
const fs = require('fs');
const ACHIEVEMENTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'achievements.json'), 'utf8'));

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, getChar, addLog, buildState, buildPatch, getContent, rand, gameEvents,
  } = ctx;

  // ═══════════════════════════════════════════════════════════
  //  CODEX — Track discoveries
  // ═══════════════════════════════════════════════════════════
  async function recordCodex(charId, category, entrySlug) {
    await db.query(
      `INSERT INTO fantasy_codex (char_id, category, entry_slug, count) VALUES ($1, $2, $3, 1)
       ON CONFLICT (char_id, category, entry_slug) DO UPDATE SET count = fantasy_codex.count + 1`,
      [charId, category, entrySlug]
    );
  }

  async function getCodexCounts(charId) {
    const rows = await q('SELECT category, COUNT(*) as cnt FROM fantasy_codex WHERE char_id=$1 GROUP BY category', [charId]);
    const counts = {};
    for (const r of rows) counts[r.category] = parseInt(r.cnt);
    return counts;
  }

  // ═══════════════════════════════════════════════════════════
  //  ACHIEVEMENTS — Check + award
  // ═══════════════════════════════════════════════════════════
  async function getUnlockedAchievements(charId) {
    const rows = await q('SELECT achievement_slug FROM fantasy_achievements WHERE char_id=$1', [charId]);
    return new Set(rows.map(r => r.achievement_slug));
  }

  async function checkAndAwardAchievements(charId, triggerType, currentValue, extraContext = {}) {
    const unlocked = await getUnlockedAchievements(charId);
    const newAchievements = [];

    for (const ach of ACHIEVEMENTS.achievements) {
      if (unlocked.has(ach.slug)) continue;
      if (ach.trigger !== triggerType) continue;
      if (currentValue >= ach.threshold) {
        // Award achievement
        try {
          await db.query('INSERT INTO fantasy_achievements (char_id, achievement_slug) VALUES ($1, $2) ON CONFLICT DO NOTHING', [charId, ach.slug]);
          newAchievements.push(ach);
          // Award rewards
          if (ach.reward) {
            if (ach.reward.gold) await db.query('UPDATE fantasy_characters SET gold = gold + $1 WHERE id = $2', [ach.reward.gold, charId]);
            if (ach.reward.tokens) await db.query('UPDATE fantasy_characters SET arcane_tokens = arcane_tokens + $1 WHERE id = $2', [ach.reward.tokens, charId]);
          }
          const rewardText = [];
          if (ach.reward?.gold) rewardText.push(`+${ach.reward.gold}g`);
          if (ach.reward?.tokens) rewardText.push(`+${ach.reward.tokens} ✦`);
          if (ach.reward?.title) rewardText.push(`Title: "${ach.reward.title}"`);
          await addLog(charId, 'achievement', `🏆 Achievement Unlocked: ${ach.icon} ${ach.name}! ${rewardText.join(', ')}`);

          // World feed for notable achievements
          if (ach.reward?.title) {
            const char = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [charId]);
            if (char) {
              await db.query('INSERT INTO fantasy_world_feed (char_name, event_type, message) VALUES ($1, $2, $3)',
                [char.name, 'achievement', `🏆 ${char.name} earned "${ach.name}"!`]);
            }
          }
        } catch (e) { /* duplicate, ignore */ }
      }
    }
    return newAchievements;
  }

  // ═══════════════════════════════════════════════════════════
  //  CODEX STAT COUNTERS — Helper to get aggregate counts
  // ═══════════════════════════════════════════════════════════
  async function getCodexCount(charId, category) {
    const row = await q1('SELECT COALESCE(SUM(count), 0) as total FROM fantasy_codex WHERE char_id=$1 AND category=$2', [charId, category]);
    return parseInt(row?.total || 0);
  }

  async function getCodexDistinctCount(charId, category) {
    const row = await q1('SELECT COUNT(*) as cnt FROM fantasy_codex WHERE char_id=$1 AND category=$2', [charId, category]);
    return parseInt(row?.cnt || 0);
  }

  // ═══════════════════════════════════════════════════════════
  //  EVENT LISTENERS — Hook into game events for tracking
  // ═══════════════════════════════════════════════════════════
  gameEvents.on('enemy-killed', async ({ charId, enemySlug, isBoss, xpGain, location }) => {
    try {
      await recordCodex(charId, 'enemy', enemySlug);
      // Track location visits
      if (location) {
        await recordCodex(charId, 'location', location);
        const locCount = await getCodexDistinctCount(charId, 'location');
        await checkAndAwardAchievements(charId, 'locations-visited', locCount);
      }
      const totalKills = await getCodexCount(charId, 'enemy');
      await checkAndAwardAchievements(charId, 'enemies-killed', totalKills);
      if (isBoss) {
        const bossKills = await getCodexCount(charId, 'boss');
        await recordCodex(charId, 'boss', enemySlug);
        await checkAndAwardAchievements(charId, 'bosses-killed', bossKills + 1);
      }
      // Check elite kills
      // (elite flag is on the enemy object — we track via codex category)
    } catch (e) { console.error('Progression event error (enemy-killed):', e.message); }
  });

  gameEvents.on('boss-killed', async ({ charId, enemySlug }) => {
    try { await recordCodex(charId, 'boss', enemySlug); } catch (e) { /* already tracked above */ }
  });

  gameEvents.on('item-looted', async ({ charId, itemSlug, source, perks }) => {
    try {
      await recordCodex(charId, 'item', itemSlug);
      const item = getContent().items[itemSlug];
      if (item?.rarity === 'mythic') {
        const mythicCount = await getCodexDistinctCount(charId, 'mythic');
        await recordCodex(charId, 'mythic', itemSlug);
        await checkAndAwardAchievements(charId, 'mythics-found', mythicCount + 1);
        // World feed
        const char = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [charId]);
        if (char) {
          await db.query('INSERT INTO fantasy_world_feed (char_name, event_type, message) VALUES ($1, $2, $3)',
            [char.name, 'mythic', `🔴 ${char.name} found ${item.name}!`]);
        }
      }
    } catch (e) { console.error('Progression event error (item-looted):', e.message); }
  });

  gameEvents.on('quest-completed', async ({ charId, questSlug }) => {
    try {
      await recordCodex(charId, 'quest', questSlug);
      const questCount = await getCodexDistinctCount(charId, 'quest');
      await checkAndAwardAchievements(charId, 'quests-completed', questCount);
    } catch (e) { console.error('Progression event error (quest-completed):', e.message); }
  });

  gameEvents.on('dungeon-cleared', async ({ charId, dungeonSlug, dungeonName }) => {
    try {
      await recordCodex(charId, 'dungeon', dungeonSlug);
      const dungeonCount = await getCodexCount(charId, 'dungeon');
      await checkAndAwardAchievements(charId, 'dungeons-cleared', dungeonCount);
      // World feed
      const char = await q1('SELECT name FROM fantasy_characters WHERE id=$1', [charId]);
      if (char) {
        await db.query('INSERT INTO fantasy_world_feed (char_name, event_type, message) VALUES ($1, $2, $3)',
          [char.name, 'dungeon', `🏰 ${char.name} conquered ${dungeonName}!`]);
      }
    } catch (e) { console.error('Progression event error (dungeon-cleared):', e.message); }
  });

  gameEvents.on('level-up', async ({ charId, newLevel }) => {
    try {
      await checkAndAwardAchievements(charId, 'level', newLevel);
      const char = await q1('SELECT gold FROM fantasy_characters WHERE id=$1', [charId]);
      if (char) await checkAndAwardAchievements(charId, 'gold-total', char.gold);
      // Track location visits
      const charFull = await q1('SELECT location FROM fantasy_characters WHERE id=$1', [charId]);
      if (charFull) {
        await recordCodex(charId, 'location', charFull.location);
        const locCount = await getCodexDistinctCount(charId, 'location');
        await checkAndAwardAchievements(charId, 'locations-visited', locCount);
      }
    } catch (e) { console.error('Progression event error (level-up):', e.message); }
  });

  gameEvents.on('player-died', async ({ charId }) => {
    try {
      await recordCodex(charId, 'death', 'death');
      const deaths = await getCodexCount(charId, 'death');
      await checkAndAwardAchievements(charId, 'deaths', deaths);
    } catch (e) { console.error('Progression event error (player-died):', e.message); }
  });

  gameEvents.on('combo-discovered', async ({ charId, comboSlug }) => {
    try {
      await recordCodex(charId, 'combo', comboSlug);
    } catch (e) { console.error('Progression event error (combo-discovered):', e.message); }
  });

  // ═══════════════════════════════════════════════════════════
  //  API ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  // ── GET ACHIEVEMENTS ──
  app.post('/api/fantasy/achievements', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const unlocked = await q('SELECT achievement_slug, unlocked_at FROM fantasy_achievements WHERE char_id=$1 ORDER BY unlocked_at DESC', [char.id]);
      const unlockedSet = new Set(unlocked.map(r => r.achievement_slug));
      const all = ACHIEVEMENTS.achievements.map(a => ({
        ...a,
        unlocked: unlockedSet.has(a.slug),
        unlockedAt: unlocked.find(r => r.achievement_slug === a.slug)?.unlocked_at || null,
      }));
      res.json({ ok: true, achievements: all, totalUnlocked: unlocked.length, totalAvailable: ACHIEVEMENTS.achievements.length });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load achievements.' }); }
  });

  // ── GET CODEX ──
  app.post('/api/fantasy/codex', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const entries = await q('SELECT category, entry_slug, count, first_seen FROM fantasy_codex WHERE char_id=$1 ORDER BY category, first_seen', [char.id]);
      // Enrich with names
      const codex = {};
      for (const e of entries) {
        if (!codex[e.category]) codex[e.category] = [];
        let name = e.entry_slug;
        if (e.category === 'enemy' || e.category === 'boss') {
          for (const locEnemies of Object.values(getContent().enemies)) {
            const found = locEnemies.find(en => en.slug === e.entry_slug);
            if (found) { name = found.name; break; }
          }
        } else if (e.category === 'item' || e.category === 'mythic') {
          name = getContent().items[e.entry_slug]?.name || e.entry_slug;
        } else if (e.category === 'quest') {
          const quest = getContent().quests.find(q => q.slug === e.entry_slug);
          name = quest?.title || e.entry_slug;
        }
        codex[e.category].push({ slug: e.entry_slug, name, count: e.count, firstSeen: e.first_seen });
      }
      // Raid runs
      const raidRuns = await q(
        'SELECT raid_slug, COUNT(*) as attempts, COUNT(*) FILTER (WHERE completed) as clears, MAX(floors_reached) as best_floor, MIN(ended_at) FILTER (WHERE completed) as first_clear FROM fantasy_raid_runs WHERE char_id=$1 GROUP BY raid_slug',
        [char.id]
      );
      // Totals
      const totalEnemies = Object.values(getContent().enemies).flat().length;
      const totalItems = Object.keys(getContent().items).length;
      res.json({ ok: true, codex, raidRuns, totals: { enemies: totalEnemies, items: totalItems } });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load codex.' }); }
  });

  // ── SET TITLE ──
  app.post('/api/fantasy/set-title', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { title } = req.body;
      if (title === null || title === '') {
        // Clear title
        await db.query('UPDATE fantasy_characters SET active_title=NULL WHERE id=$1', [char.id]);
        const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character']);
        return res.json({ ok: true, patch, messages: ['Title cleared.'] });
      }
      // Verify title is unlocked
      const unlocked = await q('SELECT a.achievement_slug FROM fantasy_achievements a WHERE a.char_id=$1', [char.id]);
      const unlockedSlugs = new Set(unlocked.map(r => r.achievement_slug));
      const earnedTitles = ACHIEVEMENTS.achievements.filter(a => a.reward?.title && unlockedSlugs.has(a.slug)).map(a => a.reward.title);
      if (!earnedTitles.includes(title)) return res.status(400).json({ error: 'Title not earned.' });
      await db.query('UPDATE fantasy_characters SET active_title=$1 WHERE id=$2', [title, char.id]);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character']);
      res.json({ ok: true, patch, messages: [`Title set: "${title}"`] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to set title.' }); }
  });

  // ── WORLD FEED ──
  app.get('/api/fantasy/world-feed', requireAuth, async (_req, res) => {
    try {
      const rows = await q('SELECT char_name, event_type, message, created_at FROM fantasy_world_feed ORDER BY created_at DESC LIMIT 15');
      res.json({ ok: true, feed: rows });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load world feed.' }); }
  });

  // ── WEEKLY QUESTS ──
  function getWeekKey() {
    const d = new Date();
    const jan1 = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
    return `${d.getFullYear()}-W${week}`;
  }

  async function ensureWeeklyQuests() {
    const weekKey = getWeekKey();
    const existing = await q('SELECT quest_slug FROM fantasy_weekly_quests WHERE week_key=$1', [weekKey]);
    if (existing.length >= 3) return;
    // Generate 3 weekly quests
    const allEnemies = Object.entries(getContent().enemies);
    const locations = getContent().locations.filter(l => l.type === 'wild' || l.type === 'dungeon');
    for (let i = 0; i < 3; i++) {
      const loc = locations[rand(0, locations.length - 1)];
      const locEnemies = (getContent().enemies[loc.slug] || []).filter(e => !e.boss);
      if (!locEnemies.length) continue;
      const enemy = locEnemies[rand(0, locEnemies.length - 1)];
      const killTarget = 3 + rand(0, 4);
      const slug = `weekly-${weekKey}-${i}`;
      const rewardGold = 50 + killTarget * 15;
      const rewardXp = 30 + killTarget * 10;
      try {
        await db.query(
          `INSERT INTO fantasy_weekly_quests (quest_slug, location, enemy_slug, kill_target, description, reward_gold, reward_xp, reward_tokens, week_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
          [slug, loc.slug, enemy.slug, killTarget, `Defeat ${killTarget} ${enemy.name} in ${loc.name}.`, rewardGold, rewardXp, 1, weekKey]
        );
      } catch (e) { /* conflict */ }
    }
  }

  app.post('/api/fantasy/weekly-quests', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      await ensureWeeklyQuests();
      const weekKey = getWeekKey();
      const quests = await q('SELECT * FROM fantasy_weekly_quests WHERE week_key=$1', [weekKey]);
      const progress = await q('SELECT * FROM fantasy_weekly_progress WHERE char_id=$1 AND week_key=$2', [char.id, weekKey]);
      const progressMap = {};
      for (const p of progress) progressMap[p.quest_slug] = p;
      const result = quests.map(wq => {
        const prog = progressMap[wq.quest_slug] || { kills: 0, completed: false, claimed: false };
        const enemyDef = Object.values(getContent().enemies).flat().find(e => e.slug === wq.enemy_slug);
        return {
          slug: wq.quest_slug, location: wq.location, enemySlug: wq.enemy_slug,
          enemyName: enemyDef?.name || wq.enemy_slug, killTarget: wq.kill_target,
          description: wq.description, rewardGold: wq.reward_gold, rewardXp: wq.reward_xp,
          rewardTokens: wq.reward_tokens, kills: prog.kills, completed: prog.completed, claimed: prog.claimed,
          locationName: getContent().locations.find(l => l.slug === wq.location)?.name || wq.location,
        };
      });
      res.json({ ok: true, weeklyQuests: result, weekKey });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load weekly quests.' }); }
  });

  app.post('/api/fantasy/weekly-quests/claim', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { questSlug } = req.body;
      const weekKey = getWeekKey();
      const wq = await q1('SELECT * FROM fantasy_weekly_quests WHERE quest_slug=$1 AND week_key=$2', [questSlug, weekKey]);
      if (!wq) return res.status(400).json({ error: 'Weekly quest not found.' });
      const prog = await q1('SELECT * FROM fantasy_weekly_progress WHERE char_id=$1 AND quest_slug=$2 AND week_key=$3', [char.id, questSlug, weekKey]);
      if (!prog || !prog.completed) return res.status(400).json({ error: 'Not completed yet.' });
      if (prog.claimed) return res.status(400).json({ error: 'Already claimed.' });
      await db.query('UPDATE fantasy_weekly_progress SET claimed=TRUE WHERE id=$1', [prog.id]);
      await db.query('UPDATE fantasy_characters SET gold=gold+$1, xp=xp+$2, arcane_tokens=arcane_tokens+$3 WHERE id=$4',
        [wq.reward_gold, wq.reward_xp, wq.reward_tokens, char.id]);
      await addLog(char.id, 'quest', `📋 Weekly quest claimed! +${wq.reward_gold}g, +${wq.reward_xp} XP, +${wq.reward_tokens} ✦`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, messages: [`📋 Claimed: +${wq.reward_gold}g, +${wq.reward_xp} XP, +${wq.reward_tokens} ✦`] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to claim.' }); }
  });

  // Weekly quest kill tracking via enemy-killed event
  gameEvents.on('enemy-killed', async ({ charId, enemySlug, location }) => {
    try {
      const weekKey = getWeekKey();
      const quests = await q('SELECT quest_slug, enemy_slug, kill_target FROM fantasy_weekly_quests WHERE week_key=$1 AND enemy_slug=$2', [weekKey, enemySlug]);
      for (const wq of quests) {
        await db.query(
          `INSERT INTO fantasy_weekly_progress (char_id, quest_slug, week_key, kills) VALUES ($1, $2, $3, 1)
           ON CONFLICT (char_id, quest_slug, week_key) DO UPDATE SET kills = LEAST(fantasy_weekly_progress.kills + 1, $4)`,
          [charId, wq.quest_slug, weekKey, wq.kill_target]
        );
        const prog = await q1('SELECT kills FROM fantasy_weekly_progress WHERE char_id=$1 AND quest_slug=$2 AND week_key=$3', [charId, wq.quest_slug, weekKey]);
        if (prog && prog.kills >= wq.kill_target) {
          await db.query('UPDATE fantasy_weekly_progress SET completed=TRUE WHERE char_id=$1 AND quest_slug=$2 AND week_key=$3', [charId, wq.quest_slug, weekKey]);
        }
      }
    } catch (e) { /* non-critical */ }
  });

  // ── DAILY LOGIN ──
  app.post('/api/fantasy/daily-login', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const today = new Date().toISOString().slice(0, 10);
      const login = char.daily_login || { lastDate: null, streak: 0, totalDays: 0 };
      if (login.lastDate === today) return res.json({ ok: true, alreadyClaimed: true, streak: login.streak, totalDays: login.totalDays });
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const isConsecutive = login.lastDate === yesterday;
      login.streak = isConsecutive ? login.streak + 1 : 1;
      login.totalDays = (login.totalDays || 0) + 1;
      login.lastDate = today;
      // Escalating rewards
      const day = Math.min(login.streak, 30);
      const goldReward = 10 + day * 5;
      const xpReward = 5 + day * 3;
      const tokenReward = day >= 7 && day % 7 === 0 ? 2 : 0;
      await db.query('UPDATE fantasy_characters SET daily_login=$1, gold=gold+$2, xp=xp+$3, arcane_tokens=arcane_tokens+$4 WHERE id=$5',
        [JSON.stringify(login), goldReward, xpReward, tokenReward, char.id]);
      await addLog(char.id, 'login', `📅 Day ${login.streak} login! +${goldReward}g, +${xpReward} XP${tokenReward ? `, +${tokenReward} ✦` : ''}`);
      await checkAndAwardAchievements(char.id, 'login-streak', login.streak);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'log']);
      res.json({ ok: true, patch, streak: login.streak, totalDays: login.totalDays, goldReward, xpReward, tokenReward,
        messages: [`📅 Day ${login.streak}! +${goldReward}g, +${xpReward} XP${tokenReward ? `, +${tokenReward} ✦` : ''}`] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to process login.' }); }
  });

  // ── Level-up achievement check (called externally after checkLevelUp) ──
  async function checkLevelAchievements(charId, level) {
    await checkAndAwardAchievements(charId, 'level', level);
    // Gold total check
    const char = await q1('SELECT gold FROM fantasy_characters WHERE id=$1', [charId]);
    if (char) await checkAndAwardAchievements(charId, 'gold-total', char.gold);
  }

  // ── Expose for other systems ──
  ctx.recordCodex = recordCodex;
  ctx.checkAndAwardAchievements = checkAndAwardAchievements;
  ctx.checkLevelAchievements = checkLevelAchievements;
}

module.exports = { register };
