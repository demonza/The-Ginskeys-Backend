// ══════════════════════════════════════════════════
// FX RATES PROXY — /api/fx
// Server-side proxy for Frankfurter API
// Solves CORS blocking on browser-side calls
// ══════════════════════════════════════════════════
const router = require('express').Router();

// ── In-memory cache ────────────────────────────────
let cachedRates = null;
let cachedAt = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const FALLBACK_RATES = { EUR: 1, USD: 1.08, GBP: 0.86 };
const SUPPORTED_SYMBOLS = ['USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'BRL', 'JPY'];

// ── GET /api/fx/latest ─────────────────────────────
// Returns current EUR-based exchange rates
// No auth required — rates are public data, and the
// frontend needs them before login for the KPI strip
router.get('/latest', async (_req, res) => {
  try {
    const now = Date.now();

    // Return cache if fresh
    if (cachedRates && (now - cachedAt) < CACHE_TTL_MS) {
      return res.json({
        ok: true,
        source: 'cache',
        rates: cachedRates,
        cached_at: new Date(cachedAt).toISOString(),
        next_refresh: new Date(cachedAt + CACHE_TTL_MS).toISOString(),
      });
    }

    // Fetch from Frankfurter (ECB rates, free, no key needed)
    const symbols = SUPPORTED_SYMBOLS.join(',');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(
      `https://api.frankfurter.app/latest?base=EUR&symbols=${symbols}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Frankfurter returned ${response.status}`);
    }

    const data = await response.json();

    // Build rates object with EUR = 1 as base
    const rates = { EUR: 1 };
    for (const [ccy, rate] of Object.entries(data.rates || {})) {
      rates[ccy] = rate;
    }

    // Update cache
    cachedRates = rates;
    cachedAt = now;

    res.json({
      ok: true,
      source: 'frankfurter',
      base: 'EUR',
      date: data.date,
      rates,
      cached_at: new Date(cachedAt).toISOString(),
      next_refresh: new Date(cachedAt + CACHE_TTL_MS).toISOString(),
    });
  } catch (err) {
    console.warn('[FX] Fetch failed:', err.message);

    // If we have stale cache, serve it with a warning
    if (cachedRates) {
      return res.json({
        ok: true,
        source: 'stale_cache',
        rates: cachedRates,
        cached_at: new Date(cachedAt).toISOString(),
        warning: 'Using stale cached rates — upstream unavailable',
      });
    }

    // Last resort: hardcoded fallback
    res.json({
      ok: true,
      source: 'fallback',
      rates: FALLBACK_RATES,
      warning: 'Using hardcoded fallback rates — upstream unavailable',
    });
  }
});

// ── GET /api/fx/convert ────────────────────────────
// Quick conversion endpoint: ?from=EUR&to=USD&amount=1000
router.get('/convert', async (req, res) => {
  try {
    const { from = 'EUR', to = 'USD', amount = 1 } = req.query;
    const amt = parseFloat(amount);
    if (!isFinite(amt)) return res.status(400).json({ error: 'amount must be a number' });

    // Ensure we have rates
    const now = Date.now();
    let rates = cachedRates;
    if (!rates || (now - cachedAt) > CACHE_TTL_MS) {
      // Try to refresh
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(
          `https://api.frankfurter.app/latest?base=EUR&symbols=${SUPPORTED_SYMBOLS.join(',')}`,
          { signal: controller.signal }
        );
        clearTimeout(timeout);
        if (response.ok) {
          const data = await response.json();
          rates = { EUR: 1, ...data.rates };
          cachedRates = rates;
          cachedAt = now;
        }
      } catch { /* fall through to whatever we have */ }
    }

    rates = rates || FALLBACK_RATES;
    const fromUpper = from.toUpperCase();
    const toUpper = to.toUpperCase();

    if (!rates[fromUpper] && fromUpper !== 'EUR')
      return res.status(400).json({ error: `Unsupported currency: ${from}` });
    if (!rates[toUpper] && toUpper !== 'EUR')
      return res.status(400).json({ error: `Unsupported currency: ${to}` });

    // Convert via EUR as base
    const fromRate = fromUpper === 'EUR' ? 1 : rates[fromUpper];
    const toRate = toUpper === 'EUR' ? 1 : rates[toUpper];
    const eurAmount = amt / fromRate;
    const converted = parseFloat((eurAmount * toRate).toFixed(4));

    res.json({
      from: fromUpper,
      to: toUpper,
      amount: amt,
      converted,
      rate: parseFloat((toRate / fromRate).toFixed(6)),
    });
  } catch (err) {
    res.status(500).json({ error: 'Conversion failed' });
  }
});

// ── Shared rate accessor for other routes ──────────
// Returns EUR-based rates (EUR=1, others = units of that ccy per 1 EUR),
// refreshing the cache if stale. Falls back gracefully. This is what the
// transactions routes use so amount_eur is computed from live ECB rates
// instead of hardcoded guesses.
async function getRates() {
  const now = Date.now();
  if (cachedRates && (now - cachedAt) < CACHE_TTL_MS) return cachedRates;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(
      `https://api.frankfurter.app/latest?base=EUR&symbols=${SUPPORTED_SYMBOLS.join(',')}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (response.ok) {
      const data = await response.json();
      cachedRates = { EUR: 1, ...data.rates };
      cachedAt = now;
    }
  } catch { /* keep whatever we have */ }
  return cachedRates || FALLBACK_RATES;
}

// Convert an amount in `currency` to EUR using live rates.
// Frankfurter rates are "units per 1 EUR", so EUR = amount / rate.
async function toEur(amount, currency) {
  const ccy = (currency || 'EUR').toUpperCase();
  if (ccy === 'EUR') return parseFloat(Number(amount).toFixed(2));
  const rates = await getRates();
  const rate = rates[ccy];
  if (!rate) return parseFloat(Number(amount).toFixed(2)); // unknown ccy: treat 1:1, better than silently wrong
  return parseFloat((Number(amount) / rate).toFixed(2));
}

module.exports = router;
module.exports.getRates = getRates;
module.exports.toEur = toEur;
