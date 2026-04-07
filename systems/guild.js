// ═══════════════════════════════════════════════════════════════
// GUILD — Bounty Board, Registration, Vendor, Abandon
// ═══════════════════════════════════════════════════════════════

const GAME_CONFIG = require('../shared/game-config');

const GUILD_REGISTRATION_COST = GAME_CONFIG.guildRegistrationCost;
const GUILD_RANKS = GAME_CONFIG.guildRanks;
const BOUNTY_CONFIG = GAME_CONFIG.bountyConfig;
const GUILD_VENDOR_ITEMS = GAME_CONFIG.guildVendorItems;
const BOUNTY_RESET_HOUR_UTC_CST = GAME_CONFIG.bountyResetHourUtcCst;
const BOUNTY_RESET_HOUR_UTC_CDT = GAME_CONFIG.bountyResetHourUtcCdt;
const MAX_ACTIVE_BOUNTIES = GAME_CONFIG.maxActiveBounties;
const { validate, schemas } = require('../validation');

function getGuildRankInfo(guildXp) {
  let current = GUILD_RANKS[0];
  for (const r of GUILD_RANKS) {
    if (guildXp >= r.xpNeeded) current = r;
    else break;
  }
  const next = GUILD_RANKS[current.rank + 1] || null;
  return { ...current, xpToNext: next ? next.xpNeeded - guildXp : 0, nextRank: next };
}

function getBountyDay() {
  const now = new Date();
  const chicagoStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago', hour12: false });
  const chicagoDate = new Date(chicagoStr);
  const offsetMs = now.getTime() - chicagoDate.getTime();
  const offsetHours = Math.round(offsetMs / 3600000);
  const isCDT = offsetHours === 5;
  const resetHourUTC = isCDT ? BOUNTY_RESET_HOUR_UTC_CDT : BOUNTY_RESET_HOUR_UTC_CST;
  const shifted = new Date(now.getTime() - resetHourUTC * 3600000);
  return shifted.toISOString().slice(0, 10);
}

function register(app, requireAuth, ctx) {
  const { db, q, q1, getChar, addLog, addItem, buildState, getContent, rand, gameEvents } = ctx;

  async function ensureDailyBounties(townSlug) {
    const today = getBountyDay();
    const existing = await q('SELECT * FROM fantasy_bounties WHERE town_slug = $1 AND generated_date = $2', [townSlug, today]);
    if (existing.length >= 3) return existing;

    const config = BOUNTY_CONFIG[townSlug];
    if (!config) return [];

    const baseSeed = [...(today + townSlug)].reduce((a, c) => a + c.charCodeAt(0), 0);
    let callCount = 0;
    const seededRand = (min, max) => {
      callCount++;
      const x = Math.sin(baseSeed * 9301 + callCount * 49297 + callCount * callCount * 233) * 10000;
      return min + Math.floor((x - Math.floor(x)) * (max - min + 1));
    };

    const bounties = [];
    const usedEnemySlugs = new Set(existing.map(e => e.enemy_slug));

    for (const tier of ['easy', 'medium', 'hard']) {
      if (existing.some(e => e.tier === tier)) continue;
      const tc = config.tiers[tier];

      let areaSlug = null;
      let enemies = [];
      const shuffledAreas = [...config.areas];
      for (let i = shuffledAreas.length - 1; i > 0; i--) {
        const j = seededRand(0, i);
        [shuffledAreas[i], shuffledAreas[j]] = [shuffledAreas[j], shuffledAreas[i]];
      }
      for (const candidateArea of shuffledAreas) {
        const pool = (getContent().enemies[candidateArea] || []).filter(e => tc.bossOnly ? e.boss : !e.boss);
        const uniquePool = pool.filter(e => !usedEnemySlugs.has(e.slug));
        if (uniquePool.length > 0) { areaSlug = candidateArea; enemies = uniquePool; break; }
        if (!areaSlug && pool.length > 0) { areaSlug = candidateArea; enemies = pool; }
      }
      if (!areaSlug || enemies.length === 0) continue;

      const enemy = enemies[seededRand(0, enemies.length - 1)];
      usedEnemySlugs.add(enemy.slug);
      const areaLoc = Object.values(getContent().locations).find(l => l.slug === areaSlug);
      const killTarget = tc.bossOnly ? 1 : seededRand(tc.killRange[0], tc.killRange[1]);
      const rewardGold = seededRand(tc.gold[0], tc.gold[1]);
      const rewardMarks = seededRand(tc.marks[0], tc.marks[1]);

      const row = await q1(
        `INSERT INTO fantasy_bounties (town_slug, tier, enemy_slug, enemy_name, area_slug, area_name, kill_target, reward_gold, reward_guild_marks, generated_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [townSlug, tier, enemy.slug, enemy.name, areaSlug, areaLoc?.name || areaSlug, killTarget, rewardGold, rewardMarks, today]
      );
      bounties.push(row);
    }
    return [...existing, ...bounties];
  }

  async function getBountyBoardState(charId, townSlug) {
    const bounties = await ensureDailyBounties(townSlug);
    const progress = await q('SELECT * FROM fantasy_bounty_progress WHERE char_id = $1 AND bounty_id = ANY($2)', [charId, bounties.map(b => b.id)]);
    const progressMap = {};
    for (const p of progress) progressMap[p.bounty_id] = p;
    return bounties.map(b => ({
      id: b.id, tier: b.tier, enemySlug: b.enemy_slug, enemyName: b.enemy_name,
      areaSlug: b.area_slug, areaName: b.area_name, killTarget: b.kill_target,
      rewardGold: b.reward_gold, rewardGuildMarks: b.reward_guild_marks,
      guildXp: BOUNTY_CONFIG[townSlug]?.tiers[b.tier]?.guildXp || 0,
      accepted: !!progressMap[b.id], kills: progressMap[b.id]?.kills || 0,
      completed: progressMap[b.id]?.completed || false, claimed: progressMap[b.id]?.claimed || false,
      isActive: false,
    }));
  }

  async function getActiveBounties(charId) {
    const rows = await q(
      `SELECT b.*, bp.kills, bp.completed, bp.claimed, bp.accepted_at
       FROM fantasy_bounty_progress bp JOIN fantasy_bounties b ON b.id = bp.bounty_id
       WHERE bp.char_id = $1 AND bp.claimed = FALSE ORDER BY bp.accepted_at DESC`, [charId]
    );
    return rows.map(r => ({
      id: r.id, tier: r.tier, enemySlug: r.enemy_slug, enemyName: r.enemy_name,
      areaSlug: r.area_slug, areaName: r.area_name, townSlug: r.town_slug,
      killTarget: r.kill_target, rewardGold: r.reward_gold, rewardGuildMarks: r.reward_guild_marks,
      guildXp: BOUNTY_CONFIG[r.town_slug]?.tiers[r.tier]?.guildXp || 0,
      accepted: true, kills: r.kills, completed: r.completed, claimed: false,
      isActive: true, acceptedAt: r.accepted_at,
    }));
  }

  // ── Bounty Board ──
  app.post('/api/fantasy/bounty/board', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.guild_registered) return res.status(400).json({ error: 'You must register with the Adventurer\'s Guild first.' });
      const townSlug = char.location;
      if (!BOUNTY_CONFIG[townSlug]) return res.status(400).json({ error: 'No bounty board at this location.' });
      const board = await getBountyBoardState(char.id, townSlug);
      const activeBounties = await getActiveBounties(char.id);
      res.json({ ok: true, board, activeBounties, maxActive: MAX_ACTIVE_BOUNTIES, guildRank: getGuildRankInfo(char.guild_xp) });
    } catch (e) { console.error('Bounty board error:', e); res.status(500).json({ error: 'Failed to load bounty board.' }); }
  });

  app.post('/api/fantasy/bounty/accept', requireAuth, validate(schemas.bountyAccept), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.guild_registered) return res.status(400).json({ error: 'Not registered.' });
      const { bountyId } = req.body;
      const bounty = await q1('SELECT * FROM fantasy_bounties WHERE id = $1', [bountyId]);
      if (!bounty) return res.status(400).json({ error: 'Bounty not found.' });
      const existing = await q1('SELECT * FROM fantasy_bounty_progress WHERE char_id = $1 AND bounty_id = $2', [char.id, bountyId]);
      if (existing) return res.status(400).json({ error: 'Already accepted.' });
      const activeCount = await q1('SELECT COUNT(*)::int AS cnt FROM fantasy_bounty_progress WHERE char_id = $1 AND claimed = FALSE', [char.id]);
      if (activeCount.cnt >= MAX_ACTIVE_BOUNTIES) return res.status(400).json({ error: `You can only have ${MAX_ACTIVE_BOUNTIES} active bounties. Claim or abandon one first.` });
      await db.query('INSERT INTO fantasy_bounty_progress (char_id, bounty_id) VALUES ($1, $2)', [char.id, bountyId]);
      await addLog(char.id, 'quest', `📋 Accepted bounty: Kill ${bounty.kill_target}× ${bounty.enemy_name} in ${bounty.area_name}.`);
      const board = await getBountyBoardState(char.id, bounty.town_slug);
      const activeBounties = await getActiveBounties(char.id);
      res.json({ ok: true, board, activeBounties, maxActive: MAX_ACTIVE_BOUNTIES });
    } catch (e) { console.error('Accept bounty error:', e); res.status(500).json({ error: 'Failed.' }); }
  });

  app.post('/api/fantasy/bounty/claim', requireAuth, validate(schemas.bountyClaim), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.guild_registered) return res.status(400).json({ error: 'Not registered.' });
      const { bountyId } = req.body;
      const progress = await q1('SELECT * FROM fantasy_bounty_progress WHERE char_id = $1 AND bounty_id = $2', [char.id, bountyId]);
      if (!progress || !progress.completed || progress.claimed) return res.status(400).json({ error: 'Cannot claim this bounty.' });
      const bounty = await q1('SELECT * FROM fantasy_bounties WHERE id = $1', [bountyId]);
      if (!bounty) return res.status(400).json({ error: 'Bounty not found.' });
      if (!BOUNTY_CONFIG[char.location]) return res.status(400).json({ error: 'Visit any town with an Adventurer\'s Guild to claim bounties.' });
      const townSlug = bounty.town_slug;
      const guildXp = BOUNTY_CONFIG[townSlug]?.tiers[bounty.tier]?.guildXp || 0;
      char.gold += bounty.reward_gold;
      char.guild_marks += bounty.reward_guild_marks;
      char.guild_xp += guildXp;
      const oldRank = getGuildRankInfo(char.guild_xp - guildXp);
      const newRank = getGuildRankInfo(char.guild_xp);
      let rankUpMsg = '';
      if (newRank.rank > oldRank.rank) { char.guild_rank = newRank.rank; rankUpMsg = ` 🎖 Guild rank up: ${newRank.name}!`; }
      await db.query('UPDATE fantasy_characters SET gold=$1, guild_marks=$2, guild_xp=$3, guild_rank=$4 WHERE id=$5',
        [char.gold, char.guild_marks, char.guild_xp, char.guild_rank, char.id]);
      await db.query('UPDATE fantasy_bounty_progress SET claimed = TRUE WHERE char_id = $1 AND bounty_id = $2', [char.id, bountyId]);
      await addLog(char.id, 'quest', `📋 Bounty claimed! +${bounty.reward_gold}g, +${bounty.reward_guild_marks} Guild Marks, +${guildXp} Guild XP.${rankUpMsg}`);
      // Achievement triggers: bounties-completed, guild-rank
      if (ctx.checkAndAwardAchievements) {
        const totalClaimed = await q1('SELECT COUNT(*)::int as cnt FROM fantasy_bounty_progress WHERE char_id=$1 AND claimed=TRUE', [char.id]);
        await ctx.checkAndAwardAchievements(char.id, 'bounties-completed', totalClaimed?.cnt || 0);
        await ctx.checkAndAwardAchievements(char.id, 'guild-rank', newRank.rank);
      }
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error('Claim bounty error:', e); res.status(500).json({ error: 'Failed.' }); }
  });

  app.post('/api/fantasy/bounty/abandon', requireAuth, validate(schemas.bountyAbandon), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.guild_registered) return res.status(400).json({ error: 'Not registered.' });
      const { bountyId } = req.body;
      const progress = await q1('SELECT * FROM fantasy_bounty_progress WHERE char_id = $1 AND bounty_id = $2', [char.id, bountyId]);
      if (!progress) return res.status(400).json({ error: 'Bounty not found in your active list.' });
      if (progress.claimed) return res.status(400).json({ error: 'Already claimed.' });
      await db.query('DELETE FROM fantasy_bounty_progress WHERE char_id = $1 AND bounty_id = $2', [char.id, bountyId]);
      const bounty = await q1('SELECT * FROM fantasy_bounties WHERE id = $1', [bountyId]);
      await addLog(char.id, 'quest', `📋 Abandoned bounty: ${bounty?.enemy_name || 'Unknown'} (${progress.kills}/${bounty?.kill_target || '?'} kills lost).`);
      const activeBounties = await getActiveBounties(char.id);
      res.json({ ok: true, activeBounties, maxActive: MAX_ACTIVE_BOUNTIES });
    } catch (e) { console.error('Abandon bounty error:', e); res.status(500).json({ error: 'Failed.' }); }
  });

  app.post('/api/fantasy/guild/register', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.guild_registered) return res.status(400).json({ error: 'Already registered.' });
      if (char.gold < GUILD_REGISTRATION_COST) return res.status(400).json({ error: `Registration costs ${GUILD_REGISTRATION_COST} gold.` });
      const regResult = await db.query('UPDATE fantasy_characters SET gold = gold - $1, guild_registered=TRUE, guild_rank=1, guild_xp=0 WHERE id=$2 AND gold >= $1 RETURNING gold', [GUILD_REGISTRATION_COST, char.id]);
      if (regResult.rowCount === 0) return res.status(400).json({ error: `Not enough gold.` });
      await addLog(char.id, 'story', `⚔ Registered with the Adventurer's Guild! Welcome, Initiate. (-${GUILD_REGISTRATION_COST}g)`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Registration failed.' }); }
  });

  app.post('/api/fantasy/guild/vendor', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.guild_registered) return res.status(400).json({ error: 'Not registered.' });
      const rank = getGuildRankInfo(char.guild_xp);
      const stock = GUILD_VENDOR_ITEMS.filter(i => rank.rank >= i.minRank);
      res.json({ ok: true, stock, guildMarks: char.guild_marks, guildRank: rank });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
  });

  app.post('/api/fantasy/guild/buy', requireAuth, validate(schemas.guildBuy), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char || !char.guild_registered) return res.status(400).json({ error: 'Not registered.' });
      const { itemSlug } = req.body;
      const gvItem = GUILD_VENDOR_ITEMS.find(i => i.slug === itemSlug);
      if (!gvItem) return res.status(400).json({ error: 'Item not found.' });
      const rank = getGuildRankInfo(char.guild_xp);
      if (rank.rank < gvItem.minRank) return res.status(400).json({ error: `Requires Guild Rank ${gvItem.minRank}.` });
      if (char.guild_marks < gvItem.cost) return res.status(400).json({ error: `Not enough Guild Marks (need ${gvItem.cost}).` });
      const mkResult = await db.query('UPDATE fantasy_characters SET guild_marks = guild_marks - $1 WHERE id=$2 AND guild_marks >= $1 RETURNING guild_marks', [gvItem.cost, char.id]);
      if (mkResult.rowCount === 0) return res.status(400).json({ error: `Not enough Guild Marks.` });
      if (gvItem.use?.storageDeed) {
        await db.query('UPDATE fantasy_characters SET home_storage_bonus = home_storage_bonus + 1 WHERE id=$1', [char.id]);
        await addLog(char.id, 'shop', `📦 Used Guild Storage Deed! Home storage expanded by 10 slots. (-${gvItem.cost} ⚔)`);
      } else {
        await addItem(char.id, itemSlug, 1);
        await addLog(char.id, 'shop', `🛒 Purchased ${gvItem.name} from Guild Vendor. (-${gvItem.cost} ⚔)`);
      }
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Purchase failed.' }); }
  });
}

module.exports = { register, BOUNTY_CONFIG, GUILD_REGISTRATION_COST, getGuildRankInfo, MAX_ACTIVE_BOUNTIES };
