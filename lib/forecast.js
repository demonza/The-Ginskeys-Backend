// ══════════════════════════════════════════════════════════════════
// FORECAST ENGINE — lib/forecast.js
//
// Turns the booking pipeline from a flat status list into an actual
// expected-value calculation, and combines it with the Trust Engine's
// verified cash balance into a runway projection. Everything here is
// arithmetic on data that already exists in the DB — no model, no
// guessing, no invented numbers.
//
// Honesty rule: a conversion rate is only reported as "empirical" once
// there's enough history behind it (MIN_SAMPLE_SIZE bookings that ever
// passed through that stage). Below that, we fall back to a labelled
// prior and say so explicitly — we never dress up a 2-sample rate as a
// real probability.
// ══════════════════════════════════════════════════════════════════
const { accountBalances } = require('./ledger');

const MIN_SAMPLE_SIZE = 8; // below this, an empirical rate is noise, not signal

// Generic, labelled starting priors for a small live-music booking funnel.
// These are NOT measured — they're a reasonable starting assumption so the
// engine can produce a number on day one. They get replaced by your own
// empirical rates, stage by stage, as booking_stage_events accumulates.
const PRIOR_CONVERSION = {
  cold:        0.05,
  contacted:   0.15,
  negotiating: 0.40,
  confirmed:   0.92, // confirmed gigs falling through is rare but real (cancellations)
};

const OPEN_STAGES = ['cold', 'contacted', 'negotiating', 'confirmed'];
const TERMINAL_SUCCESS = ['completed'];
const TERMINAL_FAIL = ['rejected'];

// For each open stage, estimate P(this booking eventually reaches
// completed) using booking_stage_events history. A booking "passed through"
// a stage if it has an event with to_stage = that stage. It "succeeded" if
// it (or a later event for the same booking_id) reached 'completed'.
async function stageConversionRates(pool) {
  const { rows } = await pool.query(`
    SELECT
      e.to_stage AS stage,
      COUNT(DISTINCT e.booking_id) AS sample_size,
      COUNT(DISTINCT e.booking_id) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM booking_stage_events f
          WHERE f.booking_id = e.booking_id AND f.to_stage = 'completed'
        )
      ) AS succeeded
    FROM booking_stage_events e
    WHERE e.to_stage = ANY($1)
    GROUP BY e.to_stage
  `, [OPEN_STAGES]);

  const empirical = {};
  rows.forEach(r => { empirical[r.stage] = { sample_size: Number(r.sample_size), succeeded: Number(r.succeeded) }; });

  return OPEN_STAGES.map(stage => {
    const e = empirical[stage];
    if (e && e.sample_size >= MIN_SAMPLE_SIZE) {
      return {
        stage,
        probability: Number((e.succeeded / e.sample_size).toFixed(3)),
        source: 'empirical',
        sample_size: e.sample_size,
      };
    }
    return {
      stage,
      probability: PRIOR_CONVERSION[stage],
      source: 'prior',
      sample_size: e ? e.sample_size : 0,
      note: `Fewer than ${MIN_SAMPLE_SIZE} historical bookings through '${stage}' — using a generic starting assumption, not a measured rate.`,
    };
  });
}

// Expected value of the open pipeline: sum(fee_eur * P(stage)) over every
// booking currently sitting in cold/contacted/negotiating/confirmed.
async function pipelineExpectedValue(pool, { withinDays = null } = {}) {
  const rates = await stageConversionRates(pool);
  const rateByStage = Object.fromEntries(rates.map(r => [r.stage, r]));

  const params = [OPEN_STAGES];
  let dateFilter = '';
  if (withinDays !== null) {
    params.push(withinDays);
    dateFilter = `AND (date IS NULL OR date <= (now() + ($2 || ' days')::interval))`;
  }

  const { rows } = await pool.query(`
    SELECT id, name, stage, fee_eur, date, follow_up_date
    FROM booking_contacts
    WHERE stage = ANY($1) ${dateFilter}
    ORDER BY date ASC NULLS LAST
  `, params);

  const items = rows.map(b => {
    const rate = rateByStage[b.stage];
    const fee = Number(b.fee_eur || 0);
    return {
      id: b.id,
      name: b.name,
      stage: b.stage,
      fee_eur: fee,
      probability: rate.probability,
      probability_source: rate.source,
      expected_value_eur: Number((fee * rate.probability).toFixed(2)),
      date: b.date,
    };
  });

  const total = Number(items.reduce((s, i) => s + i.expected_value_eur, 0).toFixed(2));
  const totalFaceValue = Number(items.reduce((s, i) => s + i.fee_eur, 0).toFixed(2));

  return {
    items,
    total_expected_value_eur: total,
    total_face_value_eur: totalFaceValue,
    conversion_rates: rates,
  };
}

// Verified band cash (Trust Engine) + trailing burn rate + pipeline expected
// value → a runway projection. Every input is either a derived ledger
// balance or a real historical average — nothing here is invented.
async function runwayProjection(pool) {
  const balances = await accountBalances(pool);
  const bandCash = Number(balances.find(b => b.account === 'band_cash')?.balance || 0);

  // Trailing 3-month average expense burn from the event store.
  const { rows: [burnRow] } = await pool.query(`
    SELECT COALESCE(SUM(amount_eur), 0) AS total, COUNT(DISTINCT date_trunc('month', occurred_on)) AS months
    FROM fin_events
    WHERE event_type = 'expense_paid' AND occurred_on >= (now() - interval '3 months')
  `);
  const monthsObserved = Math.max(1, Number(burnRow.months));
  const monthlyBurn = Number((Number(burnRow.total) / monthsObserved).toFixed(2));

  const pipeline90 = await pipelineExpectedValue(pool, { withinDays: 90 });

  const runwayMonthsFromCashAlone = monthlyBurn > 0 ? bandCash / monthlyBurn : null;
  const coverageWithPipeline = monthlyBurn > 0
    ? (bandCash + pipeline90.total_expected_value_eur) / monthlyBurn
    : null;

  return {
    verified_band_cash_eur: bandCash,
    monthly_burn_eur: monthlyBurn,
    burn_estimated_from_months: monthsObserved,
    pipeline_expected_value_90d_eur: pipeline90.total_expected_value_eur,
    runway_months_cash_only: runwayMonthsFromCashAlone,
    runway_months_with_pipeline: coverageWithPipeline,
    note: monthsObserved < 3
      ? `Burn rate is based on only ${monthsObserved} month(s) of expense history — treat as a rough estimate, not a stable average.`
      : null,
  };
}

// Score a hypothetical or pending offer against your own historical gig
// economics (average net revenue per gig from treasury_pool), so a new
// fee can be judged against what shows like this have actually netted —
// not a generic industry benchmark.
async function gigBreakeven(pool, proposedFeeEur) {
  const { rows: [row] } = await pool.query(`
    SELECT COUNT(*)::int AS gig_count,
           COALESCE(AVG(net_eur), 0) AS avg_net,
           COALESCE(percentile_cont(0.5) WITHIN GROUP (ORDER BY net_eur), 0) AS median_net
    FROM treasury_pool WHERE source_type = 'gig'
  `);

  const gigCount = row.gig_count;
  const avgNet = Number(row.avg_net);
  const medianNet = Number(row.median_net);

  if (gigCount < MIN_SAMPLE_SIZE) {
    return {
      proposed_fee_eur: proposedFeeEur,
      historical_gig_count: gigCount,
      verdict: 'insufficient_data',
      note: `Only ${gigCount} historical gigs recorded in treasury — fewer than ${MIN_SAMPLE_SIZE}, ` +
            `so there isn't a reliable historical benchmark yet. This will get more useful as more gigs are logged.`,
    };
  }

  const vsAverage = proposedFeeEur - avgNet;
  const vsMedian = proposedFeeEur - medianNet;

  return {
    proposed_fee_eur: proposedFeeEur,
    historical_gig_count: gigCount,
    historical_avg_net_eur: Number(avgNet.toFixed(2)),
    historical_median_net_eur: Number(medianNet.toFixed(2)),
    difference_vs_average_eur: Number(vsAverage.toFixed(2)),
    difference_vs_median_eur: Number(vsMedian.toFixed(2)),
    verdict: vsMedian >= 0 ? 'at_or_above_typical' : 'below_typical',
  };
}

module.exports = {
  MIN_SAMPLE_SIZE,
  PRIOR_CONVERSION,
  stageConversionRates,
  pipelineExpectedValue,
  runwayProjection,
  gigBreakeven,
};
