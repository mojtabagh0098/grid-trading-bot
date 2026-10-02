# AGENTS.md — tg-grid-bot (Vercel)

Persian Telegram bot simulating grid trading. **Vercel** serverless functions (`api/`) +
**Vercel Postgres** (plain `pg`, no ORM). No server, no real orders, no exchange keys.

## Commands

- `npm test` — 50 tests, offline: pure engines + `schema.sql` on pg-mem + handler tests.
  Do not add network calls to tests; HTTP is stubbed via `globalThis.fetch`.
- `npm run deploy` — `vercel --prod`.

## Layout (all cross-imports are relative paths with `.js` extensions)

- `api/webhook.js` — POST; validates `x-telegram-bot-api-secret-token` == `WEBHOOK_SECRET`;
  200 immediately, then `handleUpdate` + `backgroundSyncForUser`.
- `api/cron.js` — validates `Authorization: Bearer <CRON_SECRET>`; `syncAllActiveGrids` + `syncAllPositions`.
- `vercel.json` — cron `0 12 * * *` (Hobby plan = daily only!), `maxDuration: 60`.
- `schema.sql` — users(+pending JSONB), tokens, grids (sim state, held_levels JSONB), trades,
  positions (leveraged long/short, TP/SL, close status/reason/pnl).
- `lib/db.js` — pg Pool from `DATABASE_URL` + `_setTestPool()` (tests only).
  `queryFull` returns rows+rowCount for conditional updates.
- `lib/repo.js` — ALL SQL here, raw `$1…` params. Map BIGINT→Number in mappers.
  `closePositionRow` = conditional UPDATE (`WHERE status='open'`) for race-safe closes.
- `lib/grid.js` — **pure** engine (no I/O). Levels arithmetic on `lowerPrice`:
  `L_i = lower×(1+i·iv)`; sell target of level i = `L_{i+1}` (top = ∞ tail → grid top).
- `lib/pos.js` — **pure** position math: `computeTpsl` (ATR, 2:1; null ATR → 3%),
  `posPnl` (ROE on margin), `liqPrice` (0.95/leverage adverse), `checkClose`
  (order: liq → sl → tp), `closePnl` (liq = −margin), `atr14` (Wilder).
- `lib/sim.js` — engine+DB glue; budgets: 20 s fetch deadline, ≤1500 candles, catch-up
  window < 3 days, cron sweep ≤50 grids/45 s + ≤60 positions/30 s, background ≤5 grids
  + `checkUserPositions` (≤15 positions/15 s). Positions: max 10 open per user.
- `lib/flow.js` — conversations (pending JSONB on users). Keep `cancel` in every menu.
- `lib/bot.js` — router: commands `/start /menu /cancel /help` + `callback_data`
  namespace `main|help|tokens|add_token|token_edit.<SYM>|token_del.<SYM>|token_del_y.<SYM>|grids|grid_new|grid_pick.<SYM>|grid_info.<ID>|grid_stop.<ID>|grid_del.<ID>|grid_del_y.<ID>|positions|pos_refresh|pos_new|pos_pick.<SYM>|pos_side.long|pos_side.short|pos_confirm|pos_close.<ID>|pos_close_y.<ID>|pos_history|flow_cancel`.
- `lib/tg.js` — Bot API via fetch; `editOrSend` clears keyboards with `{inline_keyboard:[]}`.
- `lib/prices.js` — klines: Binance → Bybit → OKX; returns arrays of raw 1m klines.
- `lib/util.js` — `toNum` (Persian/Arabic digits), Tehran (UTC+3:30) time formatting.

## Hard constraints (do not break)

- Vercel functions: no process persistence, 60 s max — never loop/block on fetches;
  every network phase has a deadline. Hobby cron is daily-only.
- Keep the accounting identity: `cash + costBasis = deposit + realized`.
- Engine inputs from the DB are mapped in `repo.js` (held_levels coerced to array).
- Positions: TP/SL are set by the BOT (ATR 2:1), max leverage 50, max 10 open per user,
  close detection order is liq → sl → tp; closes go through `closePositionRow`
  (conditional on `status='open'`) so webhook/cron overlaps never double-close.
- pg-mem gotchas hit during testing: empty jsonb arrays come back as `{}` (coerce in
  mappers); partial indexes (`CREATE INDEX … WHERE …`) break unrelated predicates —
  keep the schema on plain indexes.
- Tests must stay green and offline (`npm test`).
