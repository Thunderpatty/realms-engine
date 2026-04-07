// ═══════════════════════════════════════════════════════════════
// ACADEMY — DEPRECATED: Routes now handled by class-trainer.js
// This module is kept as a no-op to avoid breaking the require()
// in fantasy-rpg.js. The actual endpoints are registered by
// class-trainer.js using the same /api/fantasy/academy/* paths.
// ═══════════════════════════════════════════════════════════════

function register(_app, _requireAuth, _ctx) {
  // All academy endpoints are now registered by class-trainer.js
}

module.exports = { register };
