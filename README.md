[CHANGELOG_GREENROOM.md](https://github.com/user-attachments/files/29399919/CHANGELOG_GREENROOM.md)# Ginskeys Console — Update: Green Room, Alert Engine, Bookings↔Tours Fix

This pass focused on the items you flagged that I could verify correct **by inspection**
(I can't run your live DB here, so every change is conservative and additive, and every
JS/Node file passes `node --check`). Nothing existing was removed except the hardcoded
fake dashboard alerts. **The Band Health Score was not touched.**

---

## 1. Bookings ↔ Tours conflict — FIXED (the real bug)

**File:** `routes/booking.js`

The pipeline (`cold → … → confirmed → completed / rejected`) is now the single source
of truth and its lifecycle is mirrored onto the linked tour:

- A booking moving to **completed** now sets its tour `status = 'completed'` (previously
  it stayed `'planned'` forever, so finished gigs never closed out in Tour P&L).
- A booking moving to **rejected** after being confirmed now sets the tour
  `status = 'cancelled'` instead of leaving a ghost "planned" tour polluting P&L.
- Fixed a date-comparison bug where a request-body date **string** was compared against a
  Postgres **Date** object — it always evaluated unequal and fired a needless `UPDATE` on
  every save.

The `GET /api/tours` UNION (real tours + virtual confirmed-booking rows) is unchanged and
no longer double-counts, because rejected/linked bookings are correctly excluded.

## 2. The Green Room — band chat (NEW)

The retention answer. A real-time-ish (4s poll) group chat for the whole band where you can
**embed live console objects** — a booking, show, release, invoice or tour travels with the
message as a clickable card that opens the real record in the console.

- **Backend:** `routes/chat.js` (messages, embeds, reactions, pins, presence, unread cursor,
  soft-delete with author/admin rules), `db/migrate_v9.js`.
- **Auto-creates its tables on boot** (`index.js`) — no manual migration needed on Railway.
- **Frontend:** new **☻ Green Room** tab (visible to every role), immersive chat UI, the
  📎 attach picker, presence avatars, unread badge on the nav, 🔥/👍/🎸… reactions, pinned
  messages strip. Background unread polling runs after login; message polling runs while the
  tab is open.

Endpoints: `GET /api/chat[?since=]`, `GET /api/chat/state`, `POST /api/chat`,
`POST /api/chat/read`, `POST /api/chat/:id/react`, `POST /api/chat/:id/pin`,
`DELETE /api/chat/:id`.

## 3. Alerts that matter to a band (NEW logic in `computeAlerts()`)

Added four band-business alerts alongside the existing financial ones:

- **Show prep risk** — a confirmed show in ≤14 days with **no setlist linked** (critical at ≤5 days).
- **Revenue cliff** — **no confirmed show in the next 60 days** (tells you whether the
  pipeline can save it).
- **Uninvoiced completed gigs** — completed bookings with a fee but **no matching invoice**
  (money on the table, with the total).
- **Stale negotiations** — deals in `negotiating` with **no follow-up date set**.

## 4. Dashboard de-clutter

Removed the four **hardcoded placeholder alerts** ("Open a bank account!", "Open up a
company?", the stale Centro de Artes note, the frozen runway card) from the Financials
"Live Alerts" panel. It now renders the **top 5 live alerts** from the same engine as the
Alerts tab, ranked critical → warning → info, and stays in sync. The Band Health Score and
every other dashboard panel are untouched.

## 5. Day Sheet PDF (NEW) + share to Green Room

Each Production show card now has **📄 Day Sheet** (prints a clean A4 advance: times, venue,
stage dims, audio config, and the linked setlist with keys/BPM/tunings) and **☻** (posts the
show as an embed into the Green Room). Reuses your existing print-window pattern.

---

## Deploy notes

1. Deploy as usual. The Green Room tables are created automatically on first boot
   (look for `✔ Green Room chat tables ready` in the logs). To run it manually:
   `node db/migrate_v9.js`.
2. No new dependencies, no env-var changes.
3. The frontend is the same single `ginskeys-console.html`; `API_BASE` is unchanged.

## What I deliberately did NOT do (so I didn't ship guesses)

You also asked for *more* PDF generators/archives and *more* input flexibility per
show/formation/setting. I shipped the one PDF I could build correctly against your real data
shape (the Day Sheet) rather than fake several. Broader templating + a documents archive is a
clean next step — happy to do it as a focused follow-up.

---

## 6. Camada mobile (NOVO) — usável no telemóvel

O site é desktop-first (estilo terminal Bloomberg), e o que partia no telemóvel
eram as ~229 grelhas multi-coluna definidas *inline* (que uma media query normal
não consegue sobrepor). Adicionei uma **camada mobile dedicada** no fim do `<style>`,
toda dentro de `@media (max-width:768px / 480px)` — por isso **o desktop fica
exatamente igual**.

O que muda no telemóvel:
- As grelhas densas (`repeat(4/6/12…)`) colapsam para **2 colunas legíveis** com
  `minmax(0,1fr)`, garantindo que nada transborda a largura do ecrã.
- A grelha principal do dashboard passa a **uma coluna**; painéis `col-span`/`row-span`
  deixam de forçar largura.
- **Tabelas** (ledger, etc.) passam a deslizar na horizontal dentro do painel em vez
  de empurrar a página.
- **Drawer** (detalhe) e **modais** passam a ecrã-inteiro e continuam a fazer scroll.
- **Barra de topo** encolhe o logótipo e dá o espaço às tabs (que já deslizam, agora
  com scroll-snap e tap targets maiores); barra de estado esconde os atalhos de teclado.
- **Green Room**: input a 16px (evita o zoom automático do iOS ao focar), embeds a 100%
  de largura, picker limitado a 50% da altura.

Continua a ser um terminal denso — o objetivo é **navegável e usável no telemóvel**,
não uma app nativa redesenhada. Não consigo testar num telemóvel real aqui, por isso
vale a pena confirmares no teu (sobretudo Ledger e Dashboard, que são as vistas mais densas).


[Uploading CHANGELOG_GREENROOM.md…]()
[CHANGELOG_GREENROOM.md](https://github.com/user-attachments/files/29399852/CHANGELOG_GREENROOM.md)

# Ginskeys Console — Update: Green Room, Alert Engine, Bookings↔Tours Fix

This pass focused on the items you flagged that I could verify correct **by inspection**
(I can't run your live DB here, so every change is conservative and additive, and every
JS/Node file passes `node --check`). Nothing existing was removed except the hardcoded
fake dashboard alerts. **The Band Health Score was not touched.**

---

## 1. Bookings ↔ Tours conflict — FIXED (the real bug)

**File:** `routes/booking.js`

The pipeline (`cold → … → confirmed → completed / rejected`) is now the single source
of truth and its lifecycle is mirrored onto the linked tour:

- A booking moving to **completed** now sets its tour `status = 'completed'` (previously
  it stayed `'planned'` forever, so finished gigs never closed out in Tour P&L).
- A booking moving to **rejected** after being confirmed now sets the tour
  `status = 'cancelled'` instead of leaving a ghost "planned" tour polluting P&L.
- Fixed a date-comparison bug where a request-body date **string** was compared against a
  Postgres **Date** object — it always evaluated unequal and fired a needless `UPDATE` on
  every save.

The `GET /api/tours` UNION (real tours + virtual confirmed-booking rows) is unchanged and
no longer double-counts, because rejected/linked bookings are correctly excluded.

## 2. The Green Room — band chat (NEW)

The retention answer. A real-time-ish (4s poll) group chat for the whole band where you can
**embed live console objects** — a booking, show, release, invoice or tour travels with the
message as a clickable card that opens the real record in the console.

- **Backend:** `routes/chat.js` (messages, embeds, reactions, pins, presence, unread cursor,
  soft-delete with author/admin rules), `db/migrate_v9.js`.
- **Auto-creates its tables on boot** (`index.js`) — no manual migration needed on Railway.
- **Frontend:** new **☻ Green Room** tab (visible to every role), immersive chat UI, the
  📎 attach picker, presence avatars, unread badge on the nav, 🔥/👍/🎸… reactions, pinned
  messages strip. Background unread polling runs after login; message polling runs while the
  tab is open.

Endpoints: `GET /api/chat[?since=]`, `GET /api/chat/state`, `POST /api/chat`,
`POST /api/chat/read`, `POST /api/chat/:id/react`, `POST /api/chat/:id/pin`,
`DELETE /api/chat/:id`.

## 3. Alerts that matter to a band (NEW logic in `computeAlerts()`)

Added four band-business alerts alongside the existing financial ones:

- **Show prep risk** — a confirmed show in ≤14 days with **no setlist linked** (critical at ≤5 days).
- **Revenue cliff** — **no confirmed show in the next 60 days** (tells you whether the
  pipeline can save it).
- **Uninvoiced completed gigs** — completed bookings with a fee but **no matching invoice**
  (money on the table, with the total).
- **Stale negotiations** — deals in `negotiating` with **no follow-up date set**.

## 4. Dashboard de-clutter

Removed the four **hardcoded placeholder alerts** ("Open a bank account!", "Open up a
company?", the stale Centro de Artes note, the frozen runway card) from the Financials
"Live Alerts" panel. It now renders the **top 5 live alerts** from the same engine as the
Alerts tab, ranked critical → warning → info, and stays in sync. The Band Health Score and
every other dashboard panel are untouched.

## 5. Day Sheet PDF (NEW) + share to Green Room

Each Production show card now has **📄 Day Sheet** (prints a clean A4 advance: times, venue,
stage dims, audio config, and the linked setlist with keys/BPM/tunings) and **☻** (posts the
show as an embed into the Green Room). Reuses your existing print-window pattern.

---

## Deploy notes

1. Deploy as usual. The Green Room tables are created automatically on first boot
   (look for `✔ Green Room chat tables ready` in the logs). To run it manually:
   `node db/migrate_v9.js`.
2. No new dependencies, no env-var changes.
3. The frontend is the same single `ginskeys-console.html`; `API_BASE` is unchanged.

## What I deliberately did NOT do (so I didn't ship guesses)

You also asked for *more* PDF generators/archives and *more* input flexibility per
show/formation/setting. I shipped the one PDF I could build correctly against your real data
shape (the Day Sheet) rather than fake several. Broader templating + a documents archive is a
clean next step — happy to do it as a focused follow-up.

---

## Trust Engine (v10) — event-sourced ledger + tamper-evident audit

An additive integrity layer. The classic `transactions` / `treasury_pool` /
`member_account_txns` tables are unchanged; alongside them the engine keeps an
**append-only event store** whose balances are *derived*, not mutated, plus a
**hash-chained audit log** where each entry seals the previous one.

**Why (not a blockchain):** it gives the one genuinely useful property people
reach for blockchains for — provable, un-secretly-alterable history — with zero
wallets, gas, or external infra. Money is conserved by double-entry construction,
so the class of bug where a wallet was silently debited instead of credited is
now structurally impossible (an unbalanced event throws).

### Deploy
1. Ship the code (tables auto-create on boot; or run `node db/migrate_v10.js`).
2. Seed history: `node db/backfill_events.js` (dry run), then `--apply`.
3. Verify anytime: `GET /api/trust/verify` → audit chain + event chain + conservation.

### Endpoints
- `GET /api/trust/verify` — full integrity report (the "prove it" button).
- `GET /api/trust/balances` — derived band_cash + per-member wallet balances.
- `GET /api/trust/events` — append-only event feed.
