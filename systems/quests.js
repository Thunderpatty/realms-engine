// ═══════════════════════════════════════════════════════════════
// QUESTS — Accept, Choice, Combat progression
// Extracted from fantasy-rpg.js (Tier 2A.5)
// ═══════════════════════════════════════════════════════════════

const { validate, schemas } = require('../validation');

function register(app, requireAuth, ctx) {
  const {
    db, q1, getChar, addLog, addItem, buildState, buildPatch, getContent,
    getEquipment, computeStats, getCharAbilities, checkLevelUp,
    buildScaledEnemy, buildCompanionAlly, gameEvents, rand,
  } = ctx;

  app.post('/api/fantasy/quest/accept', requireAuth, validate(schemas.questAccept), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      const { questSlug } = req.body;
      const quest = getContent().quests.find(q => q.slug === questSlug);
      if (!quest) return res.status(400).json({ error: 'Unknown quest.' });
      if (quest.minLevel > char.level) return res.status(400).json({ error: 'Level too low.' });
      const activeQuest = await q1("SELECT * FROM fantasy_quests WHERE char_id=$1 AND status='active'", [char.id]);
      if (activeQuest) return res.status(400).json({ error: 'Complete your current active quest first.' });
      const existing = await q1('SELECT * FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2', [char.id, questSlug]);
      if (existing) return res.status(400).json({ error: 'Quest already accepted or completed.' });
      await db.query('INSERT INTO fantasy_quests (char_id, quest_slug) VALUES ($1, $2)', [char.id, questSlug]);
      await addLog(char.id, 'quest', `📜 Quest accepted: ${quest.title} — ${quest.description}`);
      const patch = await buildPatch(req.session.userId, req.session.activeCharId, ['character', 'quests', 'log']);
      res.json({ ok: true, patch });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Failed to accept quest.' }); }
  });

  app.post('/api/fantasy/quest/choice', requireAuth, validate(schemas.questChoice), async (req, res) => {
    try {
      const char = await getChar(req.session.userId, req.session.activeCharId);
      if (!char) return res.status(400).json({ error: 'No character.' });
      if (char.in_combat) return res.status(400).json({ error: 'Cannot advance quest during combat.' });
      const { questSlug, choiceIndex } = req.body;
      const questRow = await q1("SELECT * FROM fantasy_quests WHERE char_id=$1 AND quest_slug=$2 AND status='active'", [char.id, questSlug]);
      if (!questRow) return res.status(400).json({ error: 'Quest not active.' });
      const quest = getContent().quests.find(q => q.slug === questSlug);
      if (!quest) return res.status(400).json({ error: 'Unknown quest.' });
      const stage = quest.stages[questRow.stage];
      if (!stage || !stage.choices || choiceIndex < 0 || choiceIndex >= stage.choices.length) {
        return res.status(400).json({ error: 'Invalid choice.' });
      }
      const choice = stage.choices[choiceIndex];
      const equipment = await getEquipment(char.id);
      const stats = computeStats(char, equipment);
      const messages = [];

      if (choice.check) {
        const statMod = Math.floor(((stats[choice.check.stat] || 10) - 10) / 2);
        const d20 = rand(1, 20);
        const roll = d20 + statMod;
        const dc = choice.check.dc;
        const modSign = statMod >= 0 ? '+' : '';
        if (roll < dc) {
          const failXp = Math.floor(dc * 0.5);
          messages.push(`⚠ Stat check failed! (${choice.check.stat.toUpperCase()} d20:${d20}${modSign}${statMod}=${roll} vs DC ${dc}). You stumble forward regardless.`);
          const dmg = rand(3, 8);
          char.hp = Math.max(1, char.hp - dmg);
          await db.query('UPDATE fantasy_characters SET hp=$1 WHERE id=$2', [char.hp, char.id]);
          messages.push(`You take ${dmg} damage from the failed attempt. (+${failXp} XP)`);
          await db.query('UPDATE fantasy_quests SET bonus_xp=bonus_xp+$1 WHERE id=$2', [failXp, questRow.id]);
        } else {
          const passXp = dc * 2;
          messages.push(`✓ Stat check passed! (${choice.check.stat.toUpperCase()} d20:${d20}${modSign}${statMod}=${roll} vs DC ${dc}) +${passXp} XP`);
          await db.query('UPDATE fantasy_quests SET bonus_xp=bonus_xp+$1 WHERE id=$2', [passXp, questRow.id]);
        }
      }

      if (choice.combat) {
        const enemySlug = choice.combat;
        let enemyDef = null;
        for (const locEnemies of Object.values(getContent().enemies)) {
          enemyDef = locEnemies.find(e => e.slug === enemySlug);
          if (enemyDef) break;
        }
        if (enemyDef) {
          const scaledQuestEnemy = buildScaledEnemy(enemyDef, char.level, quest.location);
          scaledQuestEnemy.id = 'e0';
          scaledQuestEnemy.effects = [];
          const combatState = {
            enemies: [scaledQuestEnemy],
            allies: buildCompanionAlly(char) ? [buildCompanionAlly(char)] : [],
            turn: 1,
            playerBuffs: [],
            playerEffects: [],
            playerTempPassives: [],
            cooldowns: {},
            log: [`⚔ ${enemyDef.name} attacks! (Quest combat)`],
            questCombat: { questSlug, nextStage: choice.next },
          };
          await db.query('UPDATE fantasy_characters SET in_combat=TRUE, combat_state=$1 WHERE id=$2',
            [JSON.stringify(combatState), char.id]);
          messages.push(`⚔ A ${enemyDef.name} appears! Defeat it to continue the quest.`);
          for (const m of messages) await addLog(char.id, 'quest', m);
          const state = await buildState(req.session.userId, req.session.activeCharId);
          return res.json({ ok: true, state, messages });
        }
      }

      const nextStage = choice.next;
      const nextStageDef = quest.stages[nextStage];
      let bonusGold = stage.bonusGold || 0;
      let bonusXp = stage.bonusXp || 0;

      if (nextStageDef && nextStageDef.complete) {
        const totalGold = quest.rewards.gold + questRow.bonus_gold + bonusGold;
        const totalXp = quest.rewards.xp + questRow.bonus_xp + bonusXp;
        char.xp += totalXp;
        char.gold += totalGold;
        messages.push(nextStageDef.text);
        messages.push(`🏆 Quest complete: ${quest.title}! +${totalXp} XP, +${totalGold} gold.`);
        if (quest.rewards.item) {
          await addItem(char.id, quest.rewards.item);
          const item = getContent().items[quest.rewards.item];
          messages.push(`📦 Received: ${item?.name || quest.rewards.item}`);
        }
        await db.query("UPDATE fantasy_quests SET status='completed', stage=$1, completed_at=NOW() WHERE id=$2", [nextStage, questRow.id]);
        await db.query('UPDATE fantasy_characters SET xp=$1, gold=$2 WHERE id=$3', [char.xp, char.gold, char.id]);

        // Portal quest: unlock new realm
        if (quest.portalUnlocks) {
          const currentRealms = char.unlocked_realms || ['ashlands'];
          if (!currentRealms.includes(quest.portalUnlocks)) {
            currentRealms.push(quest.portalUnlocks);
            await db.query('UPDATE fantasy_characters SET unlocked_realms=$1 WHERE id=$2', [JSON.stringify(currentRealms), char.id]);
            const realmDef = (getContent().realms || []).find(r => r.slug === quest.portalUnlocks);
            messages.push(`🌀 NEW REALM UNLOCKED: ${realmDef?.name || quest.portalUnlocks}! ${realmDef?.description || ''}`);
          }
        }

        await gameEvents.emit('quest-completed', { charId: char.id, questSlug: quest.slug, questTitle: quest.title, xpGain: totalXp, goldGain: totalGold, rewardItem: quest.rewards.item });
        const levelUp = await checkLevelUp(char);
        if (levelUp.messages.length) messages.push(...levelUp.messages);
      } else {
        await db.query('UPDATE fantasy_quests SET stage=$1, bonus_gold=bonus_gold+$2, bonus_xp=bonus_xp+$3 WHERE id=$4',
          [nextStage, bonusGold, bonusXp, questRow.id]);
        if (nextStageDef) messages.push(nextStageDef.text);
      }

      for (const m of messages) await addLog(char.id, 'quest', m);
      const state = await buildState(req.session.userId, req.session.activeCharId);
      res.json({ ok: true, state, messages });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Quest choice failed.' }); }
  });
}

module.exports = { register };
