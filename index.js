// ══════════════════════════════════════════════════════
// THE GINSKEYS — Node/Express Backend
// ══════════════════════════════════════════════════════
const path = require('path');
require('dotenv').config();

const REQUIRED_ENV = ['DATABASE_URL', 'JWT_SECRET'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌ Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const pool    = require('./db/pool');

const authRoutes        = require('./routes/auth');
const transactionRoutes = require('./routes/transactions');
const inviteRoutes      = require('./routes/invites');
const tourRoutes        = require('./routes/tours');
const auditRoutes       = require('./routes/audit');
const streamingRoutes   = require('./routes/streaming');
const bookingRoutes     = require('./routes/booking');
const releasesRoutes    = require('./routes/releases');
const pressRoutes       = require('./routes/press');
const splitsRoutes      = require('./routes/splits');
const agentRoutes       = require('./routes/agent');
const productionRoutes  = require('./routes/production');

const app = express();

// ─── CORS ─────────────────────────────────────────────
const EXTRA_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  ...EXTRA_ORIGINS,
  'https://the-ginskeys-backend-production.up.railway.app',
  'null',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── MIDDLEWARE ───────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                   "https://cdnjs.cloudflare.com",
                   "https://cdn.jsdelivr.net"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:"],
      // FIX: allow API calls from file:// and any configured frontend origin
      connectSrc: [
        "'self'",
        "https://the-ginskeys-backend-production.up.railway.app",
        "https://api.frankfurter.app",
        ...EXTRA_ORIGINS,
      ],
      scriptSrcAttr: ["'unsafe-inline'"],
    },
  },
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────
app.use('/api/auth',         authRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/invites',      inviteRoutes);
app.use('/api/tours',        tourRoutes);
app.use('/api/audit',        auditRoutes);
app.use('/api/streaming',    streamingRoutes);
app.use('/api/booking',      bookingRoutes);
app.use('/api/releases',     releasesRoutes);
app.use('/api/press',        pressRoutes);
app.use('/api/splits',       splitsRoutes);
app.use('/api/agent',        agentRoutes);
app.use('/api/production',   productionRoutes);

// ─── HEALTH ───────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS db_time');
    res.json({ ok: true, ts: new Date(), db_time: rows[0].db_time });
  } catch (err) {
    console.error('Health check DB error:', err.message);
    res.status(503).json({ ok: false, error: 'Database unreachable', detail: err.message });
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
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Database connected.');
  } catch (err) {
    console.error('❌ Cannot connect to database:', err.message);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🎸 Ginskeys API listening on :${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health`);
    console.log(`   Console: http://localhost:${PORT}/`);
  });
}

start();
