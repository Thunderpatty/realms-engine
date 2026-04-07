// ═══════════════════════════════════════════════════════════════
// GAME CONFIG — Single shared instance of game-config.json
// Import this instead of reading the file separately.
// ═══════════════════════════════════════════════════════════════
'use strict';

const path = require('path');
const fs = require('fs');

const GAME_CONFIG = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'game-config.json'), 'utf8')
);

module.exports = GAME_CONFIG;
