// ═══════════════════════════════════════════════════════════════
// CLASS TRAINER — Unified class progression system
// Available at every realm hub town (Thornwall, Frosthollow,
// Cinderport, Nexus Bastion). Handles:
//   - Class quests (one per realm, gates ability rank upgrades)
//   - Ability learning (token cost)
//   - Ability loadout (PvE/PvP swap)
//   - Ability rank upgrades (token cost + rank cap from quests)
//   - Companion management
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');
const path = require('path');
const fs = require('fs');
const GAME_CONFIG = require('../shared/game-config');
const CLASS_QUESTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'content', 'class-quests.json'), 'utf8'));

const RANK_COSTS = [0, 5, 10, 18, 30]; // cost to go FROM rank N to N+1
const MAX_RANK = 5;
const RESPEC_COST = 100;

function register(app, requireAuth, ctx) {
  const {
    db, q, q1, getChar, addLog, buildState, buildPatch, getContent, rand,
    buildScaledEnemy, computeStats, getEquipment,
    CLASSES, getCharAbilities, MAX_ACTIVE_ABILITIES,
  } = ctx;

  // Check if location is a hub town (class trainer available)
  function isTrainerLocation(loc) {
    return (getContent().realms || []).some(r => r.hub === loc);
  }

  // Count completed class quests for this character (determines max ability rank)
  async function getCompletedClassQuestCount(charId, charClass) {
    const classQuests = CLASS_QUESTS[charClass] || [];
    if (classQuests.length === 0) return 0;
    const slugs = classQuests.map(q => q.slug);
    const result = await q(
      "SELECT COUNT(*)::int as cnt FROM fantasy_quests WHERE char_id=$1 AND quest_slug = ANY($2) AND status='completed'",
      [charId, slugs]
    );
    return result[0]?.cnt || 0;
  }

  // Max ability rank = 1 + completed class quests (base rank 1, each quest adds 1)
  async function getMaxAbilityRank(charId, charClass) {
    const completed = await getCompletedClassQuestCount(charId, charClass);
    return Math.min(MAX_RANK, 1 + completed);
  }

  // ══════════════════════════════════════════════════════════
  //  GET CLASS TRAINER INFO (combined academy + trainer data)
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/class-trainer', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isTrainerLocation(char.location)) return res.status(400).json({ error: 'Visit a realm hub town to find a Class Trainer.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot visit during combat.' });

      const classQuests = CLASS_QUESTS[char.class] || [];
      const companion = char.companion || null;

      // Quest status
      const questRows = await q('SELECT quest_slug, status FROM fantasy_quests WHERE char_id = $1', [char.id]);
      const questStatus = {};
      for (const r of questRows) questStatus[r.quest_slug] = r.status;

      const activeQuestRows = await q("SELECT quest_slug, stage FROM fantasy_quests WHERE char_id=$1 AND status='active'", [char.id]);
      const activeStages = {};
      for (const r of activeQuestRows) activeStages[r.quest_slug] = r.stage;

      const availableQuests = classQuests.map(quest => {
        const status = questStatus[quest.slug] || 'available';
        const meetsLevel = char.level >= quest.requiredLevel;
        const isActive = status === 'active';
        const currentStage = activeStages[quest.slug];
        const stageDef = isActive && currentStage !== undefined ? quest.stages[currentStage] : null;

        // Check if prerequisite quest is completed
        let prereqMet = true;
        if (quest.prerequisite) {
          prereqMet = questStatus[quest.prerequisite] === 'completed';
        }

        // Determine which realm this quest is for (by location)
        const questRealm = (getContent().realms || []).find(r => r.hub === quest.location);

        return {
          slug: quest.slug,
          title: quest.title,
          description: quest.description,
          requiredLevel: quest.requiredLevel,
          location: quest.location,
          locationName: getContent().locations.find(l => l.slug === quest.location)?.name || quest.location,
          realmName: questRealm?.name || null,
          realmIcon: questRealm?.icon || null,
          ranksUnlocked: quest.ranksUnlocked || null,
          status: status === 'completed' ? 'completed' : (isActive ? 'active' : (meetsLevel && prereqMet ? 'available' : 'locked')),
          rewards: quest.rewards,
          currentStage: isActive ? currentStage : undefined,
          stageText: stageDef?.text,
          stageChoices: stageDef?.choices,
        };
      });

      // Companion info
      let companionInfo = null;
      if (companion) {
        const def = GAME_CONFIG.companions[companion.type];
        if (def) {
          const level = companion.level || 1;
          const xp = companion.xp || 0;
          const xpNeeded = def.xpCurve[level] || 999;
          const unlockedAbilities = def.abilities.filter(a => a.unlock <= level);
          companionInfo = {
            type: companion.type,
            name: companion.name || def.name,
            icon: def.icon,
            level, xp, xpNeeded,
            activeAbility: companion.activeAbility || unlockedAbilities[0]?.slug,
            abilities: unlockedAbilities,
            allAbilities: def.abilities,
            cooldowns: companion.cooldowns || {},
            tiers: (def.tiers || []).map(t => ({ desc: t.desc })),
          };
        }
      }

      // Class bonus info
      let classBonusInfo = null;
      if (companion?.classBonus) {
        const def = GAME_CONFIG.classBonuses[companion.classBonus];
        if (def) {
          const tier = companion.specTier || 1;
          const tierData = def.tiers?.[tier - 1] || {};
          classBonusInfo = {
            slug: def.slug, name: def.name, icon: def.icon,
            description: tierData.desc || def.description,
            special: def.special,
            tiers: (def.tiers || []).map(t => ({ desc: t.desc })),
          };
        }
      }

      // Max ability rank based on class quest completion
      const maxRank = await getMaxAbilityRank(char.id, char.class);

      res.json({
        ok: true,
        classTrainer: {
          className: char.class,
          quests: availableQuests,
          companion: companionInfo,
          classBonus: classBonusInfo,
          companions: GAME_CONFIG.companions,
          classBonuses: GAME_CONFIG.classBonuses,
          maxAbilityRank: maxRank,
          currentLocation: char.location,
        },
      });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to load class trainer.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  ACCEPT CLASS QUEST
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/class-trainer/accept', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isTrainerLocation(char.location)) return res.status(400).json({ error: 'Visit a realm hub town.' });

      const { questSlug } = req.body;
      if (!questSlug) return res.status(400).json({ error: 'No quest specified.' });

      const classQuests = CLASS_QUESTS[char.class] || [];
      const quest = classQuests.find(q => q.slug === questSlug);
      if (!quest) return res.status(400).json({ error: 'Quest not available for your class.' });
      if (char.level < quest.requiredLevel) return res.status(400).json({ error: `Requires level ${quest.requiredLevel}.` });

      // Check location requirement
      if (quest.location && char.location !== quest.location) {
        const locName = getContent().locations.find(l => l.slug === quest.location)?.name || quest.location;
        return res.status(400).json({ error: `This quest must be accepted at ${locName}.` });
      }

      // Check prerequisite
      if (quest.prerequisite) {
        const prereq = await q1("SELECT status FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2", [char.id, quest.prerequisite]);
        if (!prereq || prereq.status !== 'completed') {
          return res.status(400).json({ error: 'You must complete the previous class quest first.' });
        }
      }

      const existing = await q1("SELECT * FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2", [char.id, questSlug]);
      if (existing) return res.status(400).json({ error: existing.status === 'completed' ? 'Already completed.' : 'Already accepted.' });

      await db.query("INSERT INTO fantasy_quests (char_id, quest_slug, stage, status) VALUES ($1, $2, 0, 'active')", [char.id, questSlug]);
      await addLog(char.id, 'quest', `📜 Accepted class quest: ${quest.title}`);

      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, messages: [`📜 Accepted: ${quest.title}`] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to accept quest.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  ADVANCE CLASS QUEST (choice)
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/class-trainer/choice', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });

      const { questSlug, choiceIndex } = req.body;
      if (!questSlug || choiceIndex === undefined) return res.status(400).json({ error: 'Missing params.' });

      const classQuests = CLASS_QUESTS[char.class] || [];
      const quest = classQuests.find(q => q.slug === questSlug);
      if (!quest) return res.status(400).json({ error: 'Unknown quest.' });

      const questRow = await q1("SELECT * FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2 AND status='active'", [char.id, questSlug]);
      if (!questRow) return res.status(400).json({ error: 'Quest not active.' });

      const stage = quest.stages[questRow.stage];
      if (!stage || !stage.choices) return res.status(400).json({ error: 'No choices at this stage.' });
      const choice = stage.choices[choiceIndex];
      if (!choice) return res.status(400).json({ error: 'Invalid choice.' });

      // Handle leave
      if (choice.next === -1) {
        await db.query("DELETE FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2", [char.id, questSlug]);
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state, messages: ['You step away from the quest.'] });
      }

      const nextStage = choice.successNext !== undefined ? choice.successNext : choice.next;
      const nextStageDef = quest.stages[nextStage];

      // Companion choice (ranger)
      if (choice.companionChoice) {
        const compType = choice.companionChoice;
        const compDef = GAME_CONFIG.companions[compType];
        if (!compDef) return res.status(400).json({ error: 'Unknown companion type.' });

        const companion = {
          type: compType, name: compDef.name, level: 1, xp: 0,
          activeAbility: compDef.abilities[0]?.slug || null, cooldowns: {},
          specTier: 1,
        };

        if (nextStageDef?.complete) {
          char.xp += quest.rewards.xp || 0;
          char.gold += quest.rewards.gold || 0;
          await db.query('UPDATE fantasy_characters SET companion=$1, xp=$2, gold=$3 WHERE id=$4',
            [JSON.stringify(companion), char.xp, char.gold, char.id]);
          await db.query("UPDATE fantasy_quests SET status='completed', stage=$1, completed_at=NOW() WHERE id=$2",
            [nextStage, questRow.id]);
          const messages = [nextStageDef.text, `🎉 Companion bonded: ${compDef.icon} ${compDef.name}!`, `+${quest.rewards.xp} XP`];
          if (quest.ranksUnlocked) messages.push(`⬆ Ability ranks now unlockable up to Rank ${quest.ranksUnlocked}!`);
          for (const m of messages) await addLog(char.id, 'quest', m);
          if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'class-quest-completed', 1);
          if (ctx.recordCodex) await ctx.recordCodex(char.id, 'class-quest', quest.slug);
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state, messages });
        }
      }

      // Class bonus choice (warrior/mage/cleric/rogue)
      if (choice.classBonusChoice) {
        const bonusSlug = choice.classBonusChoice;
        const bonusDef = GAME_CONFIG.classBonuses[bonusSlug];
        if (!bonusDef) return res.status(400).json({ error: 'Unknown class bonus.' });

        const companion = { classBonus: bonusSlug, specTier: 1 };

        if (nextStageDef?.complete) {
          char.xp += quest.rewards.xp || 0;
          char.gold += quest.rewards.gold || 0;
          await db.query('UPDATE fantasy_characters SET companion=$1, xp=$2, gold=$3 WHERE id=$4',
            [JSON.stringify(companion), char.xp, char.gold, char.id]);
          await db.query("UPDATE fantasy_quests SET status='completed', stage=$1, completed_at=NOW() WHERE id=$2",
            [nextStage, questRow.id]);
          const messages = [nextStageDef.text, `🎉 ${bonusDef.icon} ${bonusDef.name} unlocked! ${bonusDef.description}`, `+${quest.rewards.xp} XP`];
          if (quest.ranksUnlocked) messages.push(`⬆ Ability ranks now unlockable up to Rank ${quest.ranksUnlocked}!`);
          for (const m of messages) await addLog(char.id, 'quest', m);
          if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'class-quest-completed', 1);
          if (ctx.recordCodex) await ctx.recordCodex(char.id, 'class-quest', quest.slug);
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state, messages });
        }
      }

      // Realm advancement quest completion (realms 2-4: spec tier upgrade + rank unlock)
      if (nextStageDef?.complete && !choice.companionChoice && !choice.classBonusChoice) {
        char.xp += quest.rewards.xp || 0;
        char.gold += quest.rewards.gold || 0;
        if (quest.rewards.tokens) char.arcane_tokens = (char.arcane_tokens || 0) + (quest.rewards.tokens || 0);

        // Upgrade specialization tier
        const comp = char.companion || {};
        const newTier = (comp.specTier || 1) + 1;
        comp.specTier = Math.min(4, newTier);
        // Evolve companion name at tier 4
        if (comp.type && newTier === 4) {
          const compDef = GAME_CONFIG.companions[comp.type];
          const t4 = compDef?.tiers?.[3];
          if (t4?.bonuses?.evolvedName) comp.name = t4.bonuses.evolvedName;
        }

        await db.query('UPDATE fantasy_characters SET xp=$1, gold=$2, arcane_tokens=$3, companion=$4 WHERE id=$5',
          [char.xp, char.gold, char.arcane_tokens, JSON.stringify(comp), char.id]);
        await db.query("UPDATE fantasy_quests SET status='completed', stage=$1, completed_at=NOW() WHERE id=$2",
          [nextStage, questRow.id]);

        // Build descriptive messages
        const specName = comp.classBonus
          ? (GAME_CONFIG.classBonuses[comp.classBonus]?.name || comp.classBonus)
          : (GAME_CONFIG.companions[comp.type]?.name || 'companion');
        const tierDesc = comp.classBonus
          ? GAME_CONFIG.classBonuses[comp.classBonus]?.tiers?.[newTier - 1]?.desc
          : GAME_CONFIG.companions[comp.type]?.tiers?.[newTier - 1]?.desc;

        const messages = [nextStageDef.text];
        messages.push(`⬆ ${specName} advanced to Tier ${newTier}!`);
        if (tierDesc) messages.push(`✨ ${tierDesc}`);
        if (quest.rewards.xp) messages.push(`+${quest.rewards.xp} XP`);
        if (quest.rewards.gold) messages.push(`+${quest.rewards.gold} gold`);
        if (quest.rewards.tokens) messages.push(`+${quest.rewards.tokens} ✦ Arcane Tokens`);
        if (quest.ranksUnlocked) messages.push(`⬆ Ability ranks now unlockable up to Rank ${quest.ranksUnlocked}!`);
        for (const m of messages) await addLog(char.id, 'quest', m);
        if (ctx.checkAndAwardAchievements) await ctx.checkAndAwardAchievements(char.id, 'class-quest-completed', 1);
        if (ctx.recordCodex) await ctx.recordCodex(char.id, 'class-quest', quest.slug);
        const state = await buildState(req.session.userId, req.session.activeCharId);
        return res.json({ ok: true, state, messages });
      }

      // Regular stage advance
      await db.query('UPDATE fantasy_quests SET stage=$1 WHERE id=$2', [nextStage, questRow.id]);
      const messages = [];
      if (nextStageDef?.text) messages.push(nextStageDef.text);
      for (const m of messages) await addLog(char.id, 'quest', m);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, messages });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Quest choice failed.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  COMPANION ABILITY
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/class-trainer/set-ability', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!char.companion) return res.status(400).json({ error: 'No companion.' });
      const { abilitySlug } = req.body;
      const compDef = GAME_CONFIG.companions[char.companion.type];
      if (!compDef) return res.status(400).json({ error: 'Unknown companion.' });
      const ability = compDef.abilities.find(a => a.slug === abilitySlug && a.unlock <= (char.companion.level || 1));
      if (!ability) return res.status(400).json({ error: 'Ability not unlocked.' });
      char.companion.activeAbility = abilitySlug;
      await db.query('UPDATE fantasy_characters SET companion=$1 WHERE id=$2', [JSON.stringify(char.companion), char.id]);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character']);
      res.json({ ok: true, patch, messages: [`${compDef.icon} ${char.companion.name}'s active ability set to ${ability.name}.`] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to set ability.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  RESPEC
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/class-trainer/respec', requireAuth, async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isTrainerLocation(char.location)) return res.status(400).json({ error: 'Visit a realm hub town.' });
      if (!char.companion) return res.status(400).json({ error: 'Nothing to respec.' });
      if ((char.arcane_tokens || 0) < RESPEC_COST) return res.status(400).json({ error: `Respec costs ${RESPEC_COST} Arcane Tokens.` });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot respec during combat.' });

      // Reset ALL class quests (they're a chain — can't keep later ones without earlier ones)
      const classQuests = CLASS_QUESTS[char.class] || [];
      const questSlugs = classQuests.map(q => q.slug);
      char.arcane_tokens -= RESPEC_COST;
      // Reset companion, ability ranks back to 1 (all rank upgrades lost)
      await db.query('UPDATE fantasy_characters SET companion=NULL, arcane_tokens=$1, ability_ranks=$2 WHERE id=$3',
        [char.arcane_tokens, JSON.stringify({}), char.id]);
      // Delete all class quests
      for (const slug of questSlugs) {
        await db.query("DELETE FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2", [char.id, slug]);
      }

      const oldName = char.companion.classBonus
        ? (GAME_CONFIG.classBonuses[char.companion.classBonus]?.name || 'class bonus')
        : (GAME_CONFIG.companions[char.companion.type]?.name || 'companion');

      await addLog(char.id, 'quest', `🔄 Full respec: ${oldName} removed, all ability ranks reset, class quests reset. -${RESPEC_COST} ✦`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, messages: [`🔄 Full respec complete. Companion/specialization removed, ability ranks reset to 1, all class quests reset. Start your class journey again at Thornwall. (-${RESPEC_COST} ✦)`] });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Respec failed.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  ABILITY LEARNING (absorbed from Academy)
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/academy/learn', requireAuth, validate(schemas.academyLearn), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isTrainerLocation(char.location)) return res.status(400).json({ error: 'Visit a realm hub town to learn abilities.' });
      const { abilitySlug } = req.body;
      const cls = CLASSES.find(c => c.slug === char.class);
      const ability = cls?.abilities.find(a => a.slug === abilitySlug);
      if (!ability || ability.starter) return res.status(400).json({ error: 'Cannot learn that ability.' });
      if (!ability.tokenCost) return res.status(400).json({ error: 'This ability cannot be learned.' });
      const abils = getCharAbilities(char);
      if (abils.learned.includes(abilitySlug)) return res.status(400).json({ error: 'Already learned.' });
      if ((char.arcane_tokens || 0) < ability.tokenCost) return res.status(400).json({ error: `Not enough Arcane Tokens (need ${ability.tokenCost}).` });
      const newLearned = [...abils.learned, abilitySlug];
      const atResult = await db.query('UPDATE fantasy_characters SET arcane_tokens = arcane_tokens - $1, learned_abilities=$2 WHERE id=$3 AND arcane_tokens >= $1 RETURNING arcane_tokens', [ability.tokenCost, JSON.stringify(newLearned), char.id]);
      if (atResult.rowCount === 0) return res.status(400).json({ error: `Not enough Arcane Tokens.` });
      await addLog(char.id, 'story', `✦ Learned ${ability.name}! (-${ability.tokenCost} ✦)`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Learn failed.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  ABILITY LOADOUT (absorbed from Academy)
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/academy/equip', requireAuth, validate(schemas.academyEquip), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isTrainerLocation(char.location)) return res.status(400).json({ error: 'Visit a realm hub town to change loadout.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot change abilities during combat.' });
      const { activeAbilities, mode } = req.body;
      const loadoutMode = mode === 'pvp' ? 'pvp' : mode === 'raid' ? 'raid' : 'pve';
      if (!Array.isArray(activeAbilities) || activeAbilities.length < 1 || activeAbilities.length > MAX_ACTIVE_ABILITIES) {
        return res.status(400).json({ error: `Select 1-${MAX_ACTIVE_ABILITIES} abilities.` });
      }
      const abils = getCharAbilities(char);
      for (const slug of activeAbilities) {
        if (!abils.learned.includes(slug)) return res.status(400).json({ error: `You haven't learned ${slug}.` });
      }
      const col = loadoutMode === 'pvp' ? 'active_abilities_pvp' : loadoutMode === 'raid' ? 'active_abilities_raid' : 'active_abilities';
      await db.query(`UPDATE fantasy_characters SET ${col}=$1 WHERE id=$2`, [JSON.stringify(activeAbilities), char.id]);
      const modeLabel = loadoutMode === 'pvp' ? 'PvP' : loadoutMode === 'raid' ? 'Raid' : 'PvE';
      await addLog(char.id, 'story', `📖 Updated ${modeLabel} ability loadout.`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Equip failed.' }); }
  });

  // ══════════════════════════════════════════════════════════
  //  ABILITY RANK UPGRADE (absorbed from Academy, now rank-capped)
  // ══════════════════════════════════════════════════════════
  app.post('/api/fantasy/academy/upgrade', requireAuth, validate(schemas.academyUpgrade), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (!isTrainerLocation(char.location)) return res.status(400).json({ error: 'Visit a realm hub town to upgrade abilities.' });
      const { abilitySlug } = req.body;
      const cls = CLASSES.find(c => c.slug === char.class);
      const ability = cls?.abilities.find(a => a.slug === abilitySlug);
      if (!ability) return res.status(400).json({ error: 'Unknown ability.' });
      const abils = getCharAbilities(char);
      if (!ability.starter && !abils.learned.includes(abilitySlug)) return res.status(400).json({ error: 'You haven\'t learned this ability.' });
      if (!ability.ranks || ability.ranks.length < 2) return res.status(400).json({ error: 'This ability cannot be upgraded.' });

      const ranks = char.ability_ranks || {};
      const currentRank = ranks[abilitySlug] || 1;
      if (currentRank >= MAX_RANK) return res.status(400).json({ error: 'Already at max rank.' });

      // Check rank cap from class quests
      const maxRank = await getMaxAbilityRank(char.id, char.class);
      if (currentRank >= maxRank) {
        return res.status(400).json({ error: `Complete more class quests to unlock Rank ${currentRank + 1}. Current cap: Rank ${maxRank}.` });
      }

      const cost = RANK_COSTS[currentRank];
      if (!cost) return res.status(400).json({ error: 'Invalid rank.' });
      if ((char.arcane_tokens || 0) < cost) return res.status(400).json({ error: `Not enough Arcane Tokens (need ${cost}✦, have ${char.arcane_tokens || 0}✦).` });

      const newRanks = { ...ranks, [abilitySlug]: currentRank + 1 };
      const result = await db.query('UPDATE fantasy_characters SET arcane_tokens = arcane_tokens - $1, ability_ranks = $2 WHERE id = $3 AND arcane_tokens >= $1 RETURNING arcane_tokens', [cost, JSON.stringify(newRanks), char.id]);
      if (result.rowCount === 0) return res.status(400).json({ error: 'Not enough Arcane Tokens.' });
      await addLog(char.id, 'story', `⬆ Upgraded ${ability.name} to Rank ${currentRank + 1}! (-${cost}✦)`);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Upgrade failed.' }); }
  });
}

module.exports = { register };
