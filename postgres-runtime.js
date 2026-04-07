// ═══════════════════════════════════════════════════════════════
// PostgreSQL Connection Manager
// Connects to a real PostgreSQL instance via DATABASE_URL or
// individual connection parameters. No embedded Postgres.
// ═══════════════════════════════════════════════════════════════

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL || null;
const host = process.env.POSTGRES_HOST || '127.0.0.1';
const port = Number(process.env.POSTGRES_PORT || 5432);
const user = process.env.POSTGRES_USER || 'realms';
const password = process.env.POSTGRES_PASSWORD || 'realms-password';
const database = process.env.POSTGRES_DB || 'realms_game';

let pool = null;
let startupPromise = null;
let isShuttingDown = false;

// Pool config: use DATABASE_URL if available, otherwise individual params
const POOL_CONFIG = DATABASE_URL
  ? {
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DATABASE_SSL === 'false' ? false : (DATABASE_URL.includes('sslmode=') ? undefined : { rejectUnauthorized: false }),
    }
  : {
      host,
      port,
      user,
      password,
      database,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };

/**
 * Recreate the pool after a fatal connection loss.
 * Retries up to 5 times with backoff.
 */
async function recreatePool() {
  if (isShuttingDown) return;
  console.error('[postgres] Pool unhealthy, recreating...');
  try {
    if (pool) {
      pool.removeAllListeners();
      await pool.end().catch(() => {});
    }
  } catch (_) {}

  for (let attempt = 1; attempt <= 5; attempt++) {
    if (isShuttingDown) return;
    try {
      pool = new Pool(POOL_CONFIG);
      pool.on('error', handlePoolError);
      await pool.query('SELECT 1');
      console.error(`[postgres] Pool recreated successfully (attempt ${attempt})`);
      return;
    } catch (err) {
      console.error(`[postgres] Pool recreate attempt ${attempt}/5 failed: ${err.message}`);
      if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  console.error('[postgres] FATAL: Could not recreate pool after 5 attempts');
}

let recreating = null;
function handlePoolError(err) {
  if (isShuttingDown) return;
  console.error('Postgres pool error (non-fatal):', err.message);
  if (err?.code === '57P01' || err?.message?.includes('terminating connection') || err?.message?.includes('Connection terminated')) {
    if (!recreating) {
      recreating = recreatePool().finally(() => { recreating = null; });
    }
  }
}

/**
 * Start the database connection pool and verify connectivity.
 */
async function startDatabase() {
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const connDesc = DATABASE_URL
      ? 'DATABASE_URL'
      : `${host}:${port}/${database}`;
    console.log(`[postgres] Connecting to PostgreSQL at ${connDesc}`);

    pool = new Pool(POOL_CONFIG);
    pool.on('error', handlePoolError);

    // Verify connection with retries
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await pool.query('SELECT 1');
        break;
      } catch (err) {
        if (attempt === 10) throw new Error(`PostgreSQL not reachable after 10 attempts: ${err.message}`);
        console.log(`[postgres] Waiting for connection (attempt ${attempt}/10)...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }

    console.log(`[postgres] Database ready (${connDesc})`);
    return { pool, config: DATABASE_URL ? { connectionString: DATABASE_URL } : { host, port, user, password, database } };
  })();
  return startupPromise;
}

function getPool() {
  if (!pool) throw new Error('Postgres pool not started yet.');
  return pool;
}

function getConfig() {
  if (DATABASE_URL) return { connectionString: DATABASE_URL };
  return { host, port, user, password, database };
}

/**
 * Run a callback inside a database transaction.
 * Acquires a dedicated client, runs BEGIN, executes the callback,
 * then COMMIT on success or ROLLBACK on error.
 *
 * The callback receives a `client` object with the same .query() interface
 * as the pool, but all queries run inside the transaction.
 *
 * Usage:
 *   const result = await withTransaction(async (client) => {
 *     await client.query('UPDATE ... SET gold = gold - $1 WHERE ...', [cost]);
 *     await client.query('INSERT INTO ... VALUES ...', [...]);
 *     return { ok: true };
 *   });
 *
 * If the callback throws, the transaction is rolled back and the error re-thrown.
 * The client is always released back to the pool.
 */
async function withTransaction(fn) {
  if (!pool) throw new Error('Postgres pool not started yet.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Graceful shutdown — close the connection pool.
 */
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[postgres] Shutting down...');
  try {
    if (pool) {
      pool.removeAllListeners();
      await pool.end().catch(() => {});
      console.log('[postgres] Pool closed.');
    }
  } catch (_) {}
  console.log('[postgres] Shutdown complete.');
}

module.exports = { startDatabase, getPool, getConfig, withTransaction, shutdown };
