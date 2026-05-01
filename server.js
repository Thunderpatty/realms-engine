process.on('unhandledRejection', (reason, promise) => {
  console.error('UNHANDLED REJECTION:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  // Don't crash on Postgres pool connection termination errors
  if (err?.code === '57P01' || err?.message?.includes('terminating connection')) {
    console.error('Postgres connection terminated (non-fatal, reconnecting):', err.message);
    return;
  }
  console.error('UNCAUGHT EXCEPTION:', err);
  console.error(err.stack);
  process.exit(1);
});

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { startDatabase, shutdown: shutdownDb } = require('./postgres-runtime');
const { initFantasyDb, registerFantasyRoutes } = require('./fantasy-rpg');
const { initDuelDb, registerDuelRoutes } = require('./fantasy-duel');
const { validate, schemas } = require('./validation');

const app = express();
// Trust the reverse proxy (Apache on port 80 forwards X-Forwarded-For).
// Without this, express-rate-limit sees every request as 127.0.0.1 and buckets
// all users into one shared limit, plus logs a ValidationError on every request.
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const dataDir = path.join(__dirname, 'data');
const secretFile = path.join(dataDir, 'session-secret.txt');
fs.mkdirSync(dataDir, { recursive: true });

function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  const generated = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, generated, 'utf8');
  return generated;
}

// ─── DATABASE ────────────────────────────────────────────────────

let db;

async function queryOne(sql, params = []) {
  const result = await db.query(sql, params);
  return result.rows[0] || null;
}

async function initDb() {
  ({ pool: db } = await startDatabase());

  // Users table (shared across all game modules)
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migration: add is_admin column if missing
  try { await db.query('ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT FALSE'); }
  catch (e) { if (e.code !== '42701') throw e; }

  // Fantasy RPG init
  await initFantasyDb(db);
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!req.session.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// ─── EXPRESS SETUP ───────────────────────────────────────────────

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null,  // Don't force HTTPS — game runs on HTTP
    },
  },
}));

// Rate limiters
const RATE_LIMIT_AUTH = Number(process.env.RATE_LIMIT_AUTH || 50);
const RATE_LIMIT_GAME = Number(process.env.RATE_LIMIT_GAME || 1000);

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_AUTH,
  message: { error: 'Too many attempts. Try again in a minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const gameLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: RATE_LIMIT_GAME,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(compression({
  filter: (req, res) => {
    // Don't compress SSE streams — they need to flush immediately
    if (req.headers.accept === 'text/event-stream') return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Apply rate limiters to API routes
app.use('/api/register', authLimiter);
app.use('/api/login', authLimiter);
app.use('/api/reset-password', authLimiter);
// Poll endpoints get their own generous rate limit and skip the game limiter
const pollLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_POLL || 2500),
  message: { error: 'Too many poll requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  // SSE stream is long-lived — count the initial handshake only, not keep-alives.
  skip: (req) => req.originalUrl === '/api/fantasy/party/stream' && req.headers['last-event-id'] != null,
});
const pollPaths = ['/api/fantasy/party/poll', '/api/fantasy/party/combat/poll', '/api/fantasy/state', '/api/fantasy/party/stream'];
for (const p of pollPaths) app.use(p, pollLimiter);
// Game limiter applies to all other /api/fantasy routes, skipping poll/SSE paths
app.use('/api/fantasy', (req, res, next) => {
  if (pollPaths.some(p => req.originalUrl.startsWith(p))) return next();
  gameLimiter(req, res, next);
});

// Session middleware is initialized in the startup flow (after DB is ready)
async function initSessionMiddleware(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid")
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire")`);
  console.log('[sessions] Initializing PostgreSQL session store...');
  app.use(
    session({
      name: process.env.SESSION_NAME || 'connect.sid',
      store: new PgSession({
        pool,
        tableName: 'user_sessions',
        createTableIfMissing: true,
        pruneSessionInterval: 600,
      }),
      secret: getSessionSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        maxAge: 1000 * 60 * 60 * 8,
      },
    }),
  );
}

app.use('/assets', express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js')) {
      res.set('Cache-Control', 'no-cache, must-revalidate');
    }
  },
}));

// Health check — no session needed, checks DB + content
const startTime = Date.now();
app.get('/health', async (_req, res) => {
  const status = {
    ok: true,
    service: 'realms-of-ash-and-iron',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: require('./package.json').version,
  };

  // Check database connectivity
  if (db) {
    try {
      const t0 = Date.now();
      await db.query('SELECT 1');
      status.db = { ok: true, latency: Date.now() - t0 };
    } catch (e) {
      status.ok = false;
      status.db = { ok: false, error: e.message };
    }
  } else {
    status.ok = false;
    status.db = { ok: false, error: 'Pool not initialized' };
  }

  // Check content loaded
  try {
    const { getContent } = require('./fantasy-rpg');
    const content = getContent();
    const locCount = content?.locations?.length || 0;
    status.content = { ok: locCount > 0, locations: locCount };
    if (locCount === 0) status.ok = false;
  } catch (e) {
    status.content = { ok: false, error: e.message };
  }

  res.status(status.ok ? 200 : 503).json(status);
});

// ─── ROUTES (registered after session middleware is ready) ────────

function registerAppRoutes() {

  // ── Page routes ──

  app.get('/', (req, res) => {
    if (req.session.userId) {
      return res.redirect('/fantasy-rpg');
    }
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  // Legacy routes — redirect to game
  for (const route of ['/console', '/console-v2', '/choices', '/choose', '/test-console', '/console-simple', '/codex', '/store']) {
    app.get(route, (req, res) => {
      return res.redirect(req.session.userId ? '/fantasy-rpg' : '/');
    });
  }

  // ── Auth API ──

  app.get('/api/me', async (req, res) => {
    if (!req.session.userId) {
      return res.json({ authenticated: false });
    }
    const user = await queryOne(`SELECT id, handle FROM users WHERE id = $1`, [req.session.userId]);
    return res.json({ authenticated: true, user });
  });

  app.post('/api/register', validate(schemas.register), async (req, res) => {
    try {
      const { handle: rawHandle, password, confirmPassword } = req.body;
      const handle = rawHandle.toLowerCase();

      if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match.' });
      }

      const existingUser = await queryOne(`SELECT id FROM users WHERE handle = $1`, [handle]);
      if (existingUser) {
        return res.status(409).json({ error: 'That handle is already taken.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      const user = await queryOne(
        `INSERT INTO users (handle, password_hash) VALUES ($1, $2) RETURNING id, handle`,
        [handle, passwordHash],
      );

      req.session.userId = user.id;
      return res.json({ ok: true, redirect: '/fantasy-rpg' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Registration failed.' });
    }
  });

  app.post('/api/login', validate(schemas.login), async (req, res) => {
    try {
      const handle = req.body.handle.trim().toLowerCase();
      const password = req.body.password;
      const user = await queryOne(`SELECT * FROM users WHERE handle = $1`, [handle]);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return res.status(401).json({ error: 'Invalid credentials.' });
      }
      req.session.userId = user.id;
      req.session.isAdmin = !!user.is_admin;
      return res.json({ ok: true, redirect: '/fantasy-rpg' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Login failed.' });
    }
  });

  app.post('/api/reset-password', validate(schemas.resetPassword), async (req, res) => {
    try {
      const { handle: rawHandle, password, confirmPassword } = req.body;
      const handle = rawHandle.toLowerCase();

      if (password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords do not match.' });
      }

      const user = await queryOne(`SELECT id, handle FROM users WHERE handle = $1`, [handle]);
      if (!user) {
        return res.status(404).json({ error: 'No account found for that handle.' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, user.id]);
      req.session.userId = user.id;
      return res.json({ ok: true, redirect: '/fantasy-rpg' });
    } catch (error) {
      console.error(error);
      return res.status(500).json({ error: 'Password reset failed.' });
    }
  });

  app.post('/api/logout', requireAuth, (req, res) => {
    req.session.destroy((err) => {
      if (err) console.error('Session destroy error:', err);
      res.json({ ok: true, redirect: '/' });
    });
  });

} // end registerAppRoutes

// ─── ERROR HANDLER ───────────────────────────────────────────────

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

// ─── STARTUP ─────────────────────────────────────────────────────

(async () => {
  await initDb();
  await initSessionMiddleware(db);
  registerAppRoutes();
  registerFantasyRoutes(app, db, requireAuth, requireAdmin);
  await initDuelDb(db);
  registerDuelRoutes(app, db, requireAuth);
  const server = app.listen(PORT, HOST, () => {
    console.log(`Realms of Ash & Iron listening on http://${HOST}:${PORT}`);
  });
  // HTTP timeouts tuned for long-lived SSE streams. Node defaults kill idle
  // connections at 5 min (requestTimeout) / 60s (headersTimeout). SSE needs
  // these relaxed; keepAliveTimeout slightly longer than Apache's keepalive.
  server.keepAliveTimeout = 65_000;   // 65s (Apache default 5s)
  server.headersTimeout   = 70_000;   // must exceed keepAliveTimeout
  server.requestTimeout   = 0;        // 0 = disable (SSE + long polls)

  async function gracefulShutdown(signal) {
    console.log(`\n[shutdown] Received ${signal}, shutting down gracefully...`);
    if (registerFantasyRoutes._shutdown) registerFantasyRoutes._shutdown();
    server.close(() => { console.log('[shutdown] HTTP server closed.'); });
    await shutdownDb();
    process.exit(0);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
})();
