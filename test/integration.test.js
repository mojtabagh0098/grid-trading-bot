// test/integration.test.js — full pipeline test: schema + Postgres (pg-mem) + flows + engine.
// Exchange + Telegram HTTP calls are stubbed with a deterministic price series.
// Run with: npm test

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pgMem from 'pg-mem';

import { _setTestPool } from '../lib/db.js';

const MIN = 60000;
const HOURS = 5;
const T_END = Math.floor(Date.now() / MIN) * MIN; // "now", minute-aligned
const T_START = T_END - HOURS * 60 * MIN;

// deterministic price path: oscillates between ~96 and ~105
function priceAtMinute(i) {
  return 100.5 + 4.2 * Math.sin(i / 38) + 0.9 * Math.sin(i / 7);
}

function makeKlines() {
  const out = [];
  const n = HOURS * 60;
  for (let i = 0; i < n; i++) {
    const t = T_START + i * MIN;
    const o = priceAtMinute(i);
    const c = priceAtMinute(i + 1);
    const h = Math.max(o, c) + 0.35;
    const l = Math.min(o, c) - 0.35;
    out.push({ t, o, h, l, c });
  }
  return out;
}

const KLINES = makeKlines();

// ---------------- fetch stub (Binance + Telegram) ----------------

let msgIdCounter = 100;
const sent = []; // captured Telegram API calls

function telegramResult(method) {
  if (method === 'sendMessage') return { message_id: ++msgIdCounter, chat: { id: 1 } };
  if (method === 'editMessageText') return { message_id: 4242 };
  return true;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  // Bot API envelope: { ok: true, result: ... }
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => 'ok' });

  if (u.startsWith('https://api.telegram.org/bot')) {
    const method = u.split('/').pop();
    sent.push({ method, body: opts.body });
    return ok(telegramResult(method));
  }
  if (u.includes('api.binance.com/api/v3/klines')) {
    const st = Number(new URL(u).searchParams.get('startTime') || 0);
    const rows = KLINES.filter((k) => k.t >= st && k.t < T_END + MIN)
      .slice(0, 1000)
      .map((k) => [k.t, String(k.o), String(k.h), String(k.l), String(k.c), '1', k.t + MIN - 1, 'x', 0, '0', '0', '0']);
    // exchange APIs return raw JSON (no envelope)
    return { ok: true, status: 200, json: async () => rows, text: async () => 'ok' };
  }
  throw new Error('unexpected fetch: ' + u);
};

// After imports above, wire the DB pool BEFORE importing the app modules.
before(async () => {
  process.env.BOT_TOKEN = '123456:TEST-TOKEN';
  const db = pgMem.newDb();
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  db.public.none(schema);
  const { Pool } = db.adapters.createPg();
  _setTestPool(new Pool());

  // load app modules with the pool injected
  globalThis.__repo = await import('../lib/repo.js');
  globalThis.__sim = await import('../lib/sim.js');
  globalThis.__flow = await import('../lib/flow.js');
  globalThis.__tg = await import('../lib/tg.js');
  globalThis.__bot = await import('../lib/bot.js');
});

after(() => {
  globalThis.fetch = realFetch;
});

const repo = () => globalThis.__repo;
const sim = () => globalThis.__sim;
const flow = () => globalThis.__flow;
const tg = () => globalThis.__tg;
const bot = () => globalThis.__bot;

const CHAT = 1;
const TGID = 777000111;

test('schema: tables exist and are empty', async () => {
  const u = await repo().getUser(TGID);
  assert.ok(u.id > 0);
  assert.equal(u.tgId, TGID);
  // second call returns the same row
  const u2 = await repo().getUser(TGID);
  assert.equal(u2.id, u.id);
});

test('tokens: add, list, duplicate check, rename, delete', async () => {
  await repo().addToken(TGID, 'BTC');
  await repo().addToken(TGID, 'SOL');
  const toks = await repo().getTokens(TGID);
  assert.deepEqual(toks.map((t) => t.symbol), ['BTC', 'SOL']);

  // the DB itself enforces (user_id, symbol) uniqueness (the flow checks first for a friendly error)
  await assert.rejects(repo().addToken(TGID, 'BTC'), (e) => /duplicate|23505/i.test(e.message));

  await repo().renameToken(TGID, 'SOL', 'XRP');
  assert.ok(await repo().getToken(TGID, 'XRP'));
  assert.equal(await repo().getToken(TGID, 'SOL'), null);

  await repo().deleteToken(TGID, 'XRP');
  assert.equal(await repo().getToken(TGID, 'XRP'), null);
  assert.equal((await repo().getTokens(TGID)).length, 1);
});

test('pending JSONB roundtrip', async () => {
  const u = await repo().getUser(TGID);
  const p = { type: 'grid_new', step: 'deposit', msgId: 42, data: { symbol: 'BTC', deposit: 1000 } };
  await repo().setPending(u.id, p);
  let u2 = await repo().getUser(TGID);
  assert.deepEqual(u2.pending, p);
  await repo().setPending(u.id, null);
  u2 = await repo().getUser(TGID);
  assert.equal(u2.pending, null);
});

test('createGrid via the full text flow (deposit/lower/count/interval)', async () => {
  const user = await repo().getUser(TGID);
  await repo().setPending(user.id, { type: 'grid_new', step: 'deposit', msgId: 77, data: { symbol: 'BTC' } });

  await flow().handleText(await repo().getUser(TGID), CHAT, '2000'); // deposit (fresh user, like the webhook does)
  let u2 = await repo().getUser(TGID);
  assert.equal(u2.pending.step, 'lower');
  await flow().handleText(u2, CHAT, '۹۵');           // lower (Persian digits)
  u2 = await repo().getUser(TGID);
  assert.equal(u2.pending.step, 'count');
  await flow().handleText(u2, CHAT, '10');            // count
  u2 = await repo().getUser(TGID);
  assert.equal(u2.pending.step, 'interval');
  await flow().handleText(u2, CHAT, '1');             // interval %

  u2 = await repo().getUser(TGID);
  assert.equal(u2.pending, null, 'flow should be finished');
  const grids = await repo().getGrids(TGID);
  assert.equal(grids.length, 1);
  const g = grids[0];
  assert.equal(g.symbol, 'BTC');
  assert.equal(g.deposit, 2000);
  assert.equal(g.lowerPrice, 95);
  assert.equal(g.gridCount, 10);
  assert.equal(g.intervalPct, 1);
  assert.ok(g.lastSync > 0);
  assert.ok(g.lastPrice > 90 && g.lastPrice < 115, 'lastPrice within the oscillation band');
  // accounting identity right after creation
  assert.ok(Math.abs(g.cash + g.costBasis - (g.deposit + g.realized)) < 1e-6);
});

test('syncGrid catch-up: rewound 3h grid replays candles, fills and persists trades', async () => {
  const [g0] = await repo().getGrids(TGID);
  // rewind the grid 3 hours with fresh state — as if it had been idle
  const rewind = T_END - 3 * 3600e3;
  await repo().setGridState(g0.id, {
    lastSync: rewind, lastPrice: priceAtMinute(120),
    cash: g0.deposit, position: 0, costBasis: 0, realized: 0,
    tradeCount: 0, heldLevels: [],
  });
  const r0 = await repo().getGrid(TGID, g0.id);

  const g = await sim().syncGrid(TGID, r0);
  assert.ok(g.lastSync > rewind, 'lastSync advanced');
  assert.ok(g.lastSync >= T_END - 2 * MIN, 'caught up to ~now');
  assert.ok(g.tradeCount > 0, 'fills occurred in the replayed window');
  assert.ok(g.realized > 0, 'grid profited from the oscillation');
  assert.ok(Math.abs(g.cash + g.costBasis - (g.deposit + g.realized)) < 1e-6, 'identity holds');

  const stored = await repo().getGrid(TGID, g0.id);
  assert.equal(stored.lastSync, g.lastSync);
  assert.equal(stored.tradeCount, g.tradeCount);

  const trs = await repo().recentTrades(g0.id, 100);
  assert.ok(trs.length > 0 && trs.length <= 100);
  const t1 = trs[0].t, t2 = trs.length > 1 ? trs[1].t : t1;
  assert.ok(t1 >= t2, 'trades ordered by t desc');
});

test('grid list renders with profit stats (Telegram calls captured)', async () => {
  sent.length = 0;
  const user = await repo().getUser(TGID);
  await tg().showGridList(user, CHAT, 4242, '');
  const edit = sent.find((s) => s.method === 'editMessageText');
  assert.ok(edit, 'grid list rendered by editing the message');
  const text = Object.fromEntries(new URLSearchParams(edit.body.toString()).entries()).text;
  assert.match(text, /لیست گریدها/);
  assert.match(text, /BTC/);
  assert.match(text, /سود/);
  assert.match(text, /معامله/);
});

test('handleUpdate end-to-end: /start and grid stop via callback', async () => {
  sent.length = 0;
  await bot().handleUpdate({ message: { chat: { id: CHAT }, from: { id: TGID }, text: '/start' } });
  assert.ok(sent.some((s) => s.method === 'sendMessage'), 'main menu sent');

  const grids = await repo().getGrids(TGID);
  const gid = grids[0].id;
  await bot().handleUpdate({
    callback_query: { id: 'cq1', data: 'grid_stop.' + gid, from: { id: TGID }, message: { chat: { id: CHAT }, message_id: 4242 } },
  });
  const g = await repo().getGrid(TGID, gid);
  assert.equal(g.active, false, 'grid stopped');
  assert.ok(sent.some((s) => s.method === 'answerCallbackQuery'), 'callback answered');
});

test('backgroundSyncForUser is a no-op crash when nothing is due', async () => {
  // just make sure it never throws
  await bot().backgroundSyncForUser(999999);
});
