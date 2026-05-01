'use strict';
// ═══════════════════════════════════════════════════════════════
// Combat Timer Manager — reliable setTimeout-based round deadlines
// Replaces poll-based timeout detection for party combat
// ═══════════════════════════════════════════════════════════════

class CombatTimerManager {
  constructor() {
    this._timers = new Map(); // partyId -> { timer, deadline }
  }

  /**
   * Schedule a timeout callback for a party's combat round.
   * Clears any existing timer for this party first.
   */
  schedule(partyId, deadlineIso, onTimeout) {
    this.cancel(partyId);
    const deadline = new Date(deadlineIso).getTime();
    const delay = Math.max(0, deadline - Date.now());
    const timer = setTimeout(async () => {
      this._timers.delete(partyId);
      try {
        await onTimeout(partyId);
      } catch (err) {
        console.error(`[combat-timer] Timeout handler error for party ${partyId}:`, err.message);
      }
    }, delay);
    this._timers.set(partyId, { timer, deadline });
  }

  /** Cancel a pending timer for a party. */
  cancel(partyId) {
    const entry = this._timers.get(partyId);
    if (entry) {
      clearTimeout(entry.timer);
      this._timers.delete(partyId);
    }
  }

  /** Cancel all timers (for graceful shutdown). */
  cancelAll() {
    for (const [, entry] of this._timers) {
      clearTimeout(entry.timer);
    }
    this._timers.clear();
  }

  /** Check if a timer is active for a party. */
  has(partyId) {
    return this._timers.has(partyId);
  }

  /** Number of active timers. */
  get size() {
    return this._timers.size;
  }
}

module.exports = { CombatTimerManager };
