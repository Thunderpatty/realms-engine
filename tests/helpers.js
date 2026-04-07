'use strict';
// ═══════════════════════════════════════════════════════════════
// TEST HELPERS — Utilities for integration tests
//
// Tests run against the DEV server (port 8181) which must be
// running before tests start. This keeps tests simple and avoids
// booting a second server process.
// ═══════════════════════════════════════════════════════════════

const DEV_URL = process.env.TEST_URL || 'http://127.0.0.1:8181';

/**
 * Extract game state from API response — handles both full state and patch responses.
 * Use this instead of directly accessing res.data.state.
 */
function stateOf(res) {
  return res.data.state || res.data.patch || {};
}

/**
 * Create an agent (cookie jar) for a test session.
 * Each agent maintains its own session cookies.
 */
function createAgent() {
  let cookies = [];

  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookies.length) {
      headers['Cookie'] = cookies.join('; ');
    }

    const opts = { method, headers };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${DEV_URL}${path}`, opts);

    // Capture set-cookie headers
    const setCookies = res.headers.getSetCookie?.() || [];
    for (const sc of setCookies) {
      const name = sc.split('=')[0];
      // Replace existing cookie with same name
      cookies = cookies.filter(c => !c.startsWith(name + '='));
      cookies.push(sc.split(';')[0]);
    }

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    return { status: res.status, data, headers: res.headers };
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    cookies: () => cookies,
  };
}

/**
 * Register a new user and return the agent.
 */
async function registerUser(handle, password = 'testpass123') {
  const agent = createAgent();
  const res = await agent.post('/api/register', {
    handle,
    password,
    confirmPassword: password,
  });
  if (!res.data.ok && !res.data.error?.includes('already taken')) {
    throw new Error(`Register failed: ${JSON.stringify(res.data)}`);
  }
  // If already exists, login instead
  if (res.data.error?.includes('already taken')) {
    const loginRes = await agent.post('/api/login', { handle, password });
    if (!loginRes.data.ok) throw new Error(`Login failed: ${JSON.stringify(loginRes.data)}`);
  }
  return agent;
}

/**
 * Create a character on the given agent.
 */
async function createCharacter(agent, name, race = 'human', cls = 'warrior') {
  const res = await agent.post('/api/fantasy/create', { name, race, class: cls });
  if (!res.data.ok) throw new Error(`Create character failed: ${JSON.stringify(res.data)}`);
  return stateOf(res);
}

/**
 * Get full game state.
 */
async function getState(agent) {
  const res = await agent.get('/api/fantasy/state');
  return res.data.state || res.data;
}

/**
 * Travel to a destination.
 */
async function travel(agent, destination) {
  return agent.post('/api/fantasy/travel-path', { destination });
}

/**
 * Explore current location.
 */
async function explore(agent) {
  return agent.post('/api/fantasy/explore');
}

/**
 * Combat action.
 */
async function combatAction(agent, action, extra = {}) {
  return agent.post('/api/fantasy/combat/action', { action, ...extra });
}

/**
 * Fight until combat ends (win or die). Returns final state.
 * maxTurns prevents infinite loops.
 */
async function fightToEnd(agent, maxTurns = 200) {
  for (let i = 0; i < maxTurns; i++) {
    const state = await getState(agent);
    if (!state.character.in_combat) return state;
    await combatAction(agent, 'attack');
  }
  throw new Error('Combat did not end within maxTurns');
}

/**
 * Explore until we get into combat. Returns state with in_combat=true.
 * maxTries prevents infinite loops if zone has no enemies.
 */
async function exploreUntilCombat(agent, maxTries = 20) {
  for (let i = 0; i < maxTries; i++) {
    const res = await explore(agent);
    const state = stateOf(res);
    if (state.character?.in_combat) return state;
  }
  throw new Error('Could not trigger combat within maxTries');
}

/**
 * Give gold to a character via a direct DB update (test-only cheat).
 * Only works against the dev database.
 */
async function giveGold(agent, amount) {
  // Buy/sell loop is too fragile. Instead, we'll earn gold by exploring.
  // For tests that need specific gold amounts, we use the state directly.
  // This is a no-op placeholder — tests should set up gold via gameplay.
}

/**
 * Delete a character (reset).
 */
async function resetCharacter(agent) {
  return agent.post('/api/fantasy/reset');
}

/**
 * Generate a unique handle for test isolation.
 */
function uniqueHandle() {
  return 'test-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

module.exports = {
  DEV_URL,
  createAgent,
  registerUser,
  createCharacter,
  getState,
  stateOf,
  travel,
  explore,
  combatAction,
  fightToEnd,
  exploreUntilCombat,
  resetCharacter,
  uniqueHandle,
};
