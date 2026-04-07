// ═══════════════════════════════════════════════════════════════
// GAME EVENTS — Async event emitter for cross-system hooks
// ═══════════════════════════════════════════════════════════════
//
// Usage:
//   gameEvents.on('enemy-killed', async (data) => { ... });
//   await gameEvents.emit('enemy-killed', { charId, enemySlug, ... });
//
// Events:
//   enemy-killed    { charId, enemySlug, enemyName, isBoss, location, isDungeon, isQuestCombat, xpGain, goldGain }
//   boss-killed     { charId, enemySlug, enemyName, location, isDungeon, tokens }
//   player-died     { charId, goldLost, location }
//   player-fled     { charId, location, isDungeon }
//   quest-completed { charId, questSlug, questTitle, xpGain, goldGain, rewardItem }
//   level-up        { charId, oldLevel, newLevel }
//   item-looted     { charId, itemSlug, source, perks }
//   dungeon-cleared { charId, dungeonSlug, dungeonName, bonusGold }
//   bounty-progress { charId, enemySlug, kills, killTarget, tier, completed }
//   bounty-claimed  { charId, tier, rewardGold, rewardMarks, guildXp }
//
// Listeners are called sequentially (awaited) so they can do DB work.
// Errors in listeners are caught and logged, never propagated to the emitter.

class GameEventEmitter {
  constructor() {
    this._listeners = {};
  }

  on(event, listener) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(listener);
    return this; // chainable
  }

  off(event, listener) {
    if (!this._listeners[event]) return;
    this._listeners[event] = this._listeners[event].filter(l => l !== listener);
  }

  async emit(event, data) {
    const listeners = this._listeners[event];
    if (!listeners || listeners.length === 0) return;
    // Run listeners in parallel, fire-and-forget — don't block the caller
    // Each listener is wrapped in try/catch to prevent leaked connections
    const promises = listeners.map(async (listener) => {
      try {
        await listener(data);
      } catch (e) {
        console.error(`[GameEvent] Error in '${event}' listener:`, e.message || e);
      }
    });
    // Wait for all but with a timeout to prevent hanging
    await Promise.race([
      Promise.allSettled(promises),
      new Promise(resolve => setTimeout(resolve, 5000)), // 5s max for all listeners
    ]);
  }

  // Return count of listeners for an event
  listenerCount(event) {
    return (this._listeners[event] || []).length;
  }
}

// Singleton instance
const gameEvents = new GameEventEmitter();

module.exports = gameEvents;
