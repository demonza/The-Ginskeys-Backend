// ══════════════════════════════════════════════════════
// THE GINSKEYS — Node/Express Backend
// ══════════════════════════════════════════════════════
const path = require('path');
require('dotenv').config();

// ─── ENV VALIDATION (fail fast before anything starts) ─
const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  console.error('   Create a .env file — see .env.example for reference.');
  process.exit(1);
}

const express = require('express');
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const cors    = require('cors');
const helmet  = require('helmet');
const pool    = require('./db/pool');

const authRoutes        = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const inviteRoutes      = require('./routes/invites');
const tourRoutes        = require('./routes/tours');
const auditRoutes       = require('./routes/audit');

const app = express();

// ─── CORS ─────────────────────────────────────────────
// Allowed origins (comma-separated in FRONTEND_URL env var, or defaults below).
// 'null' covers opening the HTML file directly (file:// protocol).
const EXTRA_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  ...EXTRA_ORIGINS,
  'https://the-ginskeys-backend-production.up.railway.app',
  'null', // permite abrir HTML local (file://)
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const corsOptions = {
  origin(origin, cb) {
    // origin is undefined for same-origin requests (Postman, curl, etc.)
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    // Allow any localhost / 127.0.0.1 port during development
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── MIDDLEWARE ───────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false
}));

// ─── ROUTES ───────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/invites',      inviteRoutes);
app.use('/api/tours',        tourRoutes);
app.use('/api/audit',        auditRoutes);

// ─── HEALTH (actually tests the DB connection) ────────
app.get('/api/health', async (req, res) => {
  try {
    const result = await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('DB timeout')), 2000)
      )
    ]);

    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'DB slow/unreachable' });
  }
});

// ─── FRONTEND ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ginskeys-console.html'));
});

// ─── ERROR HANDLER ────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── START ────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);

async function start() {
  // Test DB connection before accepting any traffic
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Database connected.');
  } catch (err) {
    console.error('❌ Cannot connect to database:', err.message);
    console.error('   Check DATABASE_URL in your .env file.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎸 Ginskeys API listening on :${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
    console.log(`   Console: http://localhost:${PORT}/`);
  });
}

start();
