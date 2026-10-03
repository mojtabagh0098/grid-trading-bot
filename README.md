# tg-grid-bot — ربات تلگرامی شبکه معاملاتی (نسخه Vercel)

A Persian-language Telegram bot that runs **simulated grid trading** on selected tokens.
No server, no exchange keys, no real funds — the whole thing runs on **Vercel** (serverless
functions) + **Vercel Postgres**.

## Features

- **Token menu** — add / rename / delete candidate tokens (≤15 per user).
- **Grid creation** — pick a token, then fill in: deposit (USDT, 10 – 100 000 000),
  lower price, number of grids (1 – 200) and grid interval (0.1 – 50 %).
- **Simulated grid trading** — each grid owns a virtual cash + position account.
  When the price crosses a grid level it buys there; when it rises to the next level
  it sells and books the profit. Levels form an arithmetic sequence from the lower price.
- **Candle-based catch-up** — the engine replays real 1-minute candles (KuCoin → Binance → Bybit →
  OKX fallback) between the last sync and now, so fills happen even if the bot only wakes
  up occasionally. The replay window is capped (3 days) to fit Vercel function limits.
- **Grid list with stats** — P/L, ROI %, trade count, live last price; stop & delete grids.
- **Leveraged positions (long/short)** — you give token + entry price + margin + leverage;
  the **bot sets TP/SL from ATR(14) of 1h candles (2:1)** and shows them for confirmation.
  When the price hits TP, SL (or the approximate liquidation level) the position closes
  automatically, is written to history, and you get a Telegram notification. A
  **refresh button** shows all open positions with live price, PnL and PnL%;
  a **history view** lists how each closed position ended. Manual close is two-step.
- **All in Persian**, with the standard cancel button on every step of a conversation.

## Architecture

```
Telegram ──webhook──► /api/webhook  ──► lib/bot.js (router) ──► lib/flow.js (conversations)
                                              │                        lib/sim.js (grid engine)
   Vercel Cron (daily) ──► /api/cron ──► syncAllActiveGrids()  lib/grid.js (pure engine)
                                              │
                                     Vercel Postgres (pg Pool, plain SQL)
```

| Piece | What it is |
|---|---|
| `api/webhook.js` | Vercel function, POST-only, checks `x-telegram-bot-api-secret-token` vs `WEBHOOK_SECRET`, replies `200` immediately, then handles the update + a light background sync of the sender's due grids. |
| `api/cron.js` | Vercel function, checks the `Authorization: Bearer <CRON_SECRET>` header (Vercel sends it automatically), syncs **all active grids** (up to 50, 45 s budget) and sweeps **all open positions** for TP/SL hits (up to 60, 30 s budget). |
| `vercel.json` | Cron schedule `0 12 * * *` (daily — Hobby-plan safe) + `maxDuration: 60` for both functions. |
| `schema.sql` | Postgres DDL: `users` (+`pending` JSONB for conversations), `tokens`, `grids` (simulation state), `trades`, `positions` (leveraged long/short with TP/SL and close history). |
| `lib/db.js` | pg Pool from `DATABASE_URL` (SSL on), tiny query helper. |
| `lib/repo.js` | All SQL in one place (raw `$1…` parameters, no ORM). |
| `lib/tg.js` | Telegram Bot API over `fetch` (send/edit messages, keyboards). |
| `lib/prices.js` | 1-minute klines with KuCoin → Binance → Bybit → OKX fallback + ticker. |
| `lib/grid.js` | **Pure** grid math (levels, sawtooth simulation, metrics) — fully unit-tested, no I/O. |
| `lib/pos.js` | **Pure** position math: TP/SL from ATR (2:1), PnL/ROE, liquidation price, close detection (liq → SL → TP order), Wilder ATR — no I/O. |
| `lib/sim.js` | Engine + DB glue: createGrid / syncGrid / syncAllActiveGrids, trade persistence, 20 s fetch budget; positions: openPosition / closePosition / checkUserPositions / syncAllPositions (max 10 open per user). |
| `lib/bot.js` | Update router (commands + callback_data) and `backgroundSyncForUser`. |
| `lib/flow.js` | Conversation flows (token add/rename/delete, grid creation) with `pending` JSONB state. |
| `lib/util.js` | Persian digits, Tehran-timezone formatting, price/duration formatting. |

### Why only a daily cron?

Vercel's Hobby plan only allows cron jobs with a **daily** schedule, and functions run at most
60 seconds. The design therefore trades latency for coverage:

- the **webhook** wakes the bot for every user message and syncs that user's due grids in the background (5-min freshness, ≤5 grids, 20 s budget);
- the **daily cron** sweeps all active grids once;
- the **catch-up engine** replays candles from `lastSync`, so at most a few hours of price action are processed per wake — enough for realistic grid fills while staying well inside the function budget.

## Environment variables

| Variable | Where | Purpose |
|---|---|---|
| `BOT_TOKEN` | Vercel | Telegram bot token. |
| `DATABASE_URL` | Vercel | **Pooled** Postgres URL (the one ending in `-pooler`). |
| `WEBHOOK_SECRET` | Vercel + your webhook URL | Random string; sent by Telegram on every update. |
| `CRON_SECRET` | Vercel (auto-generated) | Compared against the Bearer header Vercel adds to cron calls. |

A `.env` with these values is used for local runs/tests; `.env` is git-ignored,
`.env.example` documents the format.

## Local development & tests

```bash
npm install
npm test            # 50 tests: pure engines + Postgres (pg-mem) + handlers, no network
```

The test suite:

- verifies the **pure engines** (grid sawtooth, buy/sell, crash, accounting identity,
  metrics, formatting; position TP/SL, PnL/ROE, liquidation order, ATR);
- runs the **real `schema.sql`** against an in-memory Postgres (pg-mem) and exercises the
  full product path: token CRUD, JSONB conversation state, a complete grid-creation
  conversation (including Persian-digit input), a 3-hour catch-up replay that produces
  fills and persists trades, grid-list rendering, the full position-creation conversation
  (TP/SL computed from stubbed 1h ATR), TP/SL/liquidation auto-closes with notifications,
  manual close, history rendering, the webhook handler (secret check, `/start`,
  stop-callback) and the cron handler (grids + positions sweep).

External HTTP (Telegram, exchanges) is stubbed with a deterministic price series —
tests never hit the network.

To run the bot locally against a real DB (e.g. `npx vercel env pull` or a local
Postgres): set the four env vars, then `node api/webhook.js` is **not** a server —
for a live local run either deploy to Vercel (recommended) or wrap the handler in any
small HTTP server of your choice.

## Deployment (Vercel)

1. **Create the project.** Push this folder to GitHub and import it in Vercel
   (Framework: *Other* — the `api/` folder becomes serverless functions automatically).
2. **Create the database.** In the project: *Add Integration → Vercel Postgres*.
   Use the **pooled** connection string (`...-pooler...`) as `DATABASE_URL`.
3. **Set env vars** (*Settings → Environment Variables*, all environments):
   `BOT_TOKEN`, `DATABASE_URL`, `WEBHOOK_SECRET` (any long random string).
   `CRON_SECRET` is managed by Vercel automatically.
4. **Apply the schema** (once): *Database → SQL Editor* → paste the contents of
   `schema.sql` → run. (Or: `psql "$DATABASE_URL" -f schema.sql`.)
5. **Deploy:**
   ```bash
   npm run deploy          # = vercel --prod  (install @vercel/cli + `vercel login` first)
   ```
6. **Point Telegram at the webhook:**
   ```bash
   ./scripts/setup-webhook.sh <BOT_TOKEN> <https://your-app.vercel.app> <WEBHOOK_SECRET>
   ```
   This registers `https://your-app.vercel.app/api/webhook` with `secret_token`.
7. **Check the cron:** Vercel → project → *Cron Jobs* — one job `0 12 * * *` → `/api/cron`
   should appear after deploy. You can also trigger it manually by GETting
   `https://your-app.vercel.app/api/cron` with header `Authorization: Bearer <CRON_SECRET>`.

## How a grid works (simulation)

- Levels: `L_i = lower × (1 + i·iv)` for `i = 0 … count` (arithmetic in price).
- Each level buys `deposit/count` USDT of the token when the price **crosses it downward**
  (one fill per level per direction); the position bought at level `i` sells when the
  price reaches level `i+1` (top level sells at the grid top — the "infinity tail").
- Profit per round trip ≈ `deposit/count × iv`; fees are not modeled.
- The account identity always holds: `cash + costBasis = deposit + realized`.
- Every fill is a `trades` row; the grid list shows total P/L = realized + position value
  at the latest price.

### How a position works (simulation)

- You provide: **token, entry price, margin (USDT), leverage (1–50×), side (long/short)**.
- **The bot sets TP/SL**: `ATR(14)` over the last 50 1h candles;
  long → `TP = entry + 2·ATR`, `SL = entry − 1·ATR` (short mirrored). A 2:1 risk:reward.
  If ATR is unavailable, 3% of entry is used as the fallback distance.
- PnL: `notional × price-change`, where `notional = margin × leverage`;
  ROE % is PnL relative to the **margin** (exchange-style).
- Close events, checked on every wake (webhook background check, refresh button, cron):
  - `tp` — price crossed the take-profit → closed at TP;
  - `sl` — price crossed the stop-loss → closed at SL;
  - `liq` — price reached the approximate liquidation level
    (`entry × (1 ∓ 0.95/leverage)`), checked **first** because a wide SL can sit beyond it
    → the whole margin is lost;
  - `manual` — you close it from the button (two-step confirm, fills at the live price).
- Every close is persisted (`status='closed'` + reason + PnL) and a Telegram notification
  is sent. Closes are race-safe: the DB update only wins while the row is still `open`.

## Notes & limits

- Prices come from public klines (Binance first). If all three exchanges are unreachable
  (e.g. geo-blocked), syncs simply do nothing until they're reachable again — no errors to users.
- Max 20 active grids, 15 tokens and 10 open positions per user.
- Positions are **not** candle-replayed like grids: a limit is only detected when the bot
  wakes up (message, refresh button, or the daily cron), so a TP/SL that was crossed while
  the bot slept is filled at the limit price on the next wake — which is the conservative
  (best-case for TP, worst-case for SL) assumption for a sleeping simulator.
- The bot never places real orders; all money is virtual.


## Live trading on KuCoin (optional, owner only)

By default everything is simulated. To let **grids** trade for real on KuCoin **spot**:

1. Run `migrations/002-live-trading.sql` once on the existing database (new installs: `schema.sql`).
2. Create a KuCoin API key with **General + Spot Trading** permissions only (no withdrawal/transfer).
3. Set `OWNER_TG_ID`, `LIVE_TRADING=1`, `KUCOIN_API_KEY`, `KUCOIN_API_SECRET`, `KUCOIN_API_PASSPHRASE`
   in Vercel and redeploy. Keys live only in environment variables, never in the database.
4. In Telegram the owner sends `/live` to switch real mode on/off. New grids then place real limit
   orders (one resting buy per level below the price; after a fill the sell goes one interval higher).
   `/panic` cancels every resting live order and stops all live grids. Coins already bought stay in the account.

How it works: `lib/kucoin.js` (signed REST client), `lib/live.js` (grid engine using real orders,
idempotent `clientOid`s written to `live_orders` before sending, per-grid DB lock).
Fills happen on the exchange; the bot places the follow-up order on its next sync, so call
`/api/cron` often (an external scheduler such as cron-job.org with the `Authorization: Bearer <CRON_SECRET>`
header every minute, or a Vercel Pro cron). Leveraged long/short positions stay simulated.
