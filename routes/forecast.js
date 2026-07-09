// ══════════════════════════════════════════════════
// FORECAST ROUTES — /api/forecast
// Read-only. Expected-value pipeline math + runway projection,
// built on booking_stage_events + the Trust Engine ledger.
// ══════════════════════════════════════════════════
const router = require('express').Router();
const pool = require('../db/pool');
const { requireAuth, requirePerm } = require('../middleware/auth');
const {
  stageConversionRates,
  pipelineExpectedValue,
  runwayProjection,
  gigBreakeven,
} = require('../lib/forecast');

// GET /api/forecast/pipeline?days=90
router.get('/pipeline', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const days = req.query.days ? parseInt(req.query.days) : null;
    const result = await pipelineExpectedValue(pool, { withinDays: isFinite(days) ? days : null });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/forecast/conversion-rates
router.get('/conversion-rates', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const rates = await stageConversionRates(pool);
    res.json({ rates });
  } catch (err) { next(err); }
});

// GET /api/forecast/runway
router.get('/runway', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const result = await runwayProjection(pool);
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/forecast/breakeven?fee=800
router.get('/breakeven', requireAuth, requirePerm('viewLedger'), async (req, res, next) => {
  try {
    const fee = parseFloat(req.query.fee);
    if (!isFinite(fee) || fee < 0) return res.status(400).json({ error: 'fee query param must be a non-negative number' });
    const result = await gigBreakeven(pool, fee);
    res.json(result);
  } catch (err) { next(err); }
});

module.exports = router;
