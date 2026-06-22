[AUDIT_REPORT.md](https://github.com/user-attachments/files/29218046/AUDIT_REPORT.md)
# The Ginskeys Backend — Financial Audit & Code Review

**Date:** 2026-06-22
**Scope:** Full reconciliation of Ledger / Financials / Treasury, plus a code-quality audit.

---

## 1. The balance discrepancy (primary issue) — RESOLVED

### Root cause
The closing balance `1626.65` was **hardcoded** in three places and used to back-solve a
fake opening balance:

```
openingBalance = 1626.65 − Σ(movements)
```

This forced the **Ledger tab** running balance to display `1626.65`, while the
**Financials → Net Position** card summed the movements directly and showed `1826.65`,
and the **Treasury** page reported the real cash. Three pages, three numbers, all anchored
to a value that was never real.

### Reconciliation
| Quantity | Value |
|---|---|
| Recorded ledger movements (from €0 opening) | **+€1,826.65** |
| Real cash on hand — Treasury (confirmed) | **€390.57** |
| Undocumented cash loss | **€1,436.08** |

A single, clearly-labelled loss entry was booked (date `2026-06-22`, category `Ajustes`,
tags `adjustment, reconciliation`) — **not** disguised as an operating expense. With it,
the ledger opens at a clean **€0** and closes at **€390.57**, so:

> **Ledger = Financials = Treasury = €390.57** ✓ (verified numerically)

### Files changed for the reconciliation
- `ginskeys-console.html` — `LEDGER_DATA` seed: added the loss entry; removed the
  `targetEndBalance = 1626.65` hack; opens at €0.
- `ginskeys-console.html` — `mapApiTxn()`: computes the running balance **forward from €0**
  instead of back-solving from the hardcoded `1626.65` fallback.
- `ginskeys-console.html` — `recalcBalances()`: forward computation from the €0 opening;
  removed the end-balance "anchor" model.
- `ginskeys-console.html` — `saveEditTxn()` / `confirmDeleteTxn()`: removed the now-obsolete
  `_ledgerAnchorBalance` adjustments (the forward recompute handles edits/deletes correctly).
- `db/seed.js` — added the loss entry to `RAW_TXNS`; removed the identical
  `TARGET_END_BALANCE = 1626.65` hack and its dead running-balance code.
- `db/migrate.js` — added the `Ajustes` (expense) category so the loss maps to its own
  bucket rather than polluting `Outros` (which the reports treat as a *direct gig cost* —
  putting the loss there would have distorted cost-per-gig and gig-margin).

> **If your live database differs from the 43 seeded rows**, the loss amount is simply
> `390.57 − (live Financials Net Position)`. Update the single `amount` on the adjustment
> entry accordingly.

---

## 2. Other bugs fixed

**`writeAudit` silently dropped detail text** (`middleware/audit.js`).
The helper destructured its third argument as an options object, but several call sites in
`routes/invoices.js` and `routes/members.js` passed a plain string (an invoice number, a
rehearsal date, a decision title). Those audit rows were written with **empty** `details`.
Fixed at the source: `writeAudit` now treats a string third argument as `details`, repairing
all call sites at once.

**Two orphaned dead files removed.**
- `routes/index.js` — a stale, broken duplicate of the real `index.js` entrypoint (its
  `require('./db/pool')` and `require('./routes/...')` paths are wrong and would crash if
  ever run; it was also missing the `invoices`/`members` routes). Nothing imported it.
- `reports.js` (repo root) — an orphaned older copy of `routes/reports.js`. The app wires
  `require('./routes/reports')`; nothing referenced the root file.

---

## 3. Findings documented (not auto-changed — need your confirmation)

**FX convention mismatch (latent).** `routes/transactions.js` and `routes/reports.js`
hardcode `FX = { EUR:1, USD:0.92, GBP:1.17 }` (EUR-per-unit), while `routes/fx.js` returns
Frankfurter rates as unit-per-EUR (`USD:1.08, GBP:0.86`). They are reciprocal conventions.
This does **not** affect your current data (every transaction is in EUR), but a future
non-EUR transaction would be converted wrongly by the hardcoded path. Recommended: have the
ingest path use the `/api/fx` rates (and divide, since they're unit-per-EUR) rather than the
stale hardcoded table.

**Treasury vs. ledger are independent models.** The `treasury_pool` (unallocated revenue)
and the `transactions` ledger are not kept in sync automatically — a treasury allocation
credits member accounts but does not post to the ledger. That's a deliberate design choice,
but it means the two can drift. Worth a periodic reconciliation check (the same exercise we
just did) rather than assuming they track each other.

---

## 4. Verification

```
seed RAW_TXNS (44 rows):    income +5057.50 − expense 4666.93 = 390.57  ✓
frontend LEDGER_DATA (44):  closes at 390.57                            ✓
grep for 1626.65 / anchors: none remain                                 ✓
node -c on changed JS:      seed.js / migrate.js / audit.js all OK      ✓
```
