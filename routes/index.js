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
const fxRoutes          = require('./routes/fx');
const reportRoutes      = require('./routes/reports');
const treasuryRoutes    = require('./routes/treasury');

const app = express();

// ─── CORS ─────────────────────────────────────────────
const EXTRA_ORIGINS = (process.env.FRONTEND_URL || '')
  .split(',').map(s => s.trim()).filter(Boolean);

const ALLOWED_ORIGINS = new Set([
  ...EXTRA_ORIGINS,
  'https://the-ginskeys-backend-production.up.railway.app','https://console.theginskeys.com'
  // FIX: removed 'null' — allows file:// and data: origins, security risk
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

const corsOptions = {
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
    // FIX: only allow localhost regex in development
    if (process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return cb(null, true);
    }
    cb(new Error('CORS: origin not allowed — ' + origin));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],  // FIX: added PATCH (used by checklist)
  allowedHeaders: ['Content-Type', 'Authorization'],
};

// ─── MIDDLEWARE ───────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'",
                   // NOTE: unsafe-eval is required by the external script loaded from scriptcdn.
                   // If you move the frontend to a separate build, you can remove this.
                   "https://cdnjs.cloudflare.com",
                   "https://cdn.jsdelivr.net",
                   "https://3001.scriptcdn.net"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:"],
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

// FIX: body size limit to prevent payload abuse
app.use(express.json({ limit: '1mb' }));

// FIX: trust proxy for correct req.ip behind Railway's reverse proxy
app.set('trust proxy', 1);

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
app.use('/api/fx',           fxRoutes);
app.use('/api/reports',      reportRoutes);
app.use('/api/treasury',     treasuryRoutes);

// ─── HEALTH ───────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT now() AS db_time');
    res.json({ ok: true, ts: new Date(), db_time: rows[0].db_time });
  } catch (err) {
    console.error('Health check DB error:', err.message);
    // FIX: don't leak internal error details in production
    res.status(503).json({
      ok: false,
      error: 'Database unreachable',
      ...(process.env.NODE_ENV !== 'production' && { detail: err.message }),
    });
  }
});

// ─── FRONTEND ─────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'ginskeys-console.html'));
});

// FIX: 404 handler for undefined routes (was missing)
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ─── ERROR HANDLER ────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  // FIX: don't leak stack traces in production
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message || 'Internal server error';
  res.status(status).json({ error: message });
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
