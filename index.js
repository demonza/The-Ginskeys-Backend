// ══════════════════════════════════════════════════════
// THE GINSKEYS — Node/Express Backend
// ══════════════════════════════════════════════════════
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');

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
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'null',   // file:// — browser sends literal string "null" as origin
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
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
};

// ─── MIDDLEWARE ───────────────────────────────────────
app.use(helmet({
  // Allow the HTML file to call this API from file:// without CSP blocking
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // pre-flight for all routes
app.use(express.json());

// ─── ROUTES ───────────────────────────────────────────
//app.use('/api/auth',         authRoutes);
//app.use('/api/transactions', transactionRoutes);
//app.use('/api/invites',      inviteRoutes);
//app.use('/api/tours',        tourRoutes);
//app.use('/api/audit',        auditRoutes);

// ─── HEALTH ───────────────────────────────────────────
app.get('/', (req, res) => {
  res.send('Server is alive');
});
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date() }));

// ─── ERROR HANDLER ────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3001;

if (!PORT) {
  console.error("❌ PORT is not defined");
  process.exit(1);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Ginskeys API listening on :${PORT}`);
});
