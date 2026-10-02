// test/positions.test.js — positions feature E2E: full flow (token -> entry ->
// amount -> leverage -> side -> confirm), TP/SL/liq auto-close with notification,
// manual close, history, cron sweep. Offline: Postgres = pg-mem, HTTP stubbed.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pgMem from 'pg-mem';

import { _setTestPool } from '../lib/db.js';

const MIN = 60000;
const HOUR = 3600e3;
const T_END = Math.floor(Date.now() / MIN) * MIN;
const T_END_H = Math.floor(Date.now() / HOUR) * HOUR;

// 1h candles: constant 100 with 99..101 wicks -> ATR(14) = exactly 2
// (so a long at entry 100 gets TP = 104, SL = 98 from the bot)
function hourKlines() {
  const out = [];
  for (let i = 49; i >= 0; i--) {
    const t = T_END_H - i * HOUR;
    out.push([t, '100', '101', '99', '100', '1', t + HOUR - 1, 'x', 0, '0', '0', '0']);
  }
  return out;
}

// "live" price for the 1m ticker — mutable per test
let CUR_PRICE = 100.5;

let msgIdCounter = 900;
const sent = [];

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
  const raw = (result) => ({ ok: true, status: 200, json: async () => result });

  if (u.startsWith('https://api.telegram.org/bot')) {
    const method = u.split('/').pop();
    sent.push({ method, body: opts.body });
    if (method === 'sendMessage') return ok({ message_id: ++msgIdCounter, chat: { id: 1 } });
    if (method === 'editMessageText') return ok({ message_id: 4242 });
    return ok(true);
  }
  if (u.includes('api.binance.com/api/v3/klines')) {
    const interval = new URL(u).searchParams.get('interval');
    if (interval === '1h') return raw(hourKlines());
    // 1m ticker: three candles ending at CUR_PRICE
    const rows = [];
    for (let i = 3; i >= 1; i--) {
      const t = T_END - i * MIN;
      rows.push([t, String(CUR_PRICE), String(CUR_PRICE), String(CUR_PRICE), String(CUR_PRICE), '1', t + MIN - 1, 'x', 0, '0', '0', '0']);
    }
    return raw(rows);
  }
  throw new Error('unexpected fetch: ' + u);
};

let repo, sim, bot, tg;
const CHAT = 1;
const TGID = 777000111;

before(async () => {
  process.env.BOT_TOKEN = '123456:TEST-TOKEN';
  const db = pgMem.newDb();
  db.public.none(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const { Pool } = db.adapters.createPg();
  _setTestPool(new Pool());

  repo = await import('../lib/repo.js');
  sim = await import('../lib/sim.js');
  tg = await import('../lib/tg.js');
  bot = await import('../lib/bot.js');
});

after(() => { globalThis.fetch = realFetch; });

const cb = (data) => ({
  callback_query: { id: 'cq' + Math.random(), data, from: { id: TGID }, message: { chat: { id: CHAT }, message_id: 4242 } },
});
const msg = (text) => ({ message: { chat: { id: CHAT }, from: { id: TGID }, text } });
const lastEditText = (needle) => {
  const edits = sent.filter((s) => s.method === 'editMessageText');
  for (let i = edits.length - 1; i >= 0; i--) {
    const text = new URLSearchParams(edits[i].body.toString()).get('text') || '';
    if (!needle || text.includes(needle)) return text;
  }
  return null;
};
const lastSentText = (needle) => {
  const sends = sent.filter((s) => s.method === 'sendMessage');
  for (let i = sends.length - 1; i >= 0; i--) {
    const text = new URLSearchParams(sends[i].body.toString()).get('text') || '';
    if (!needle || text.includes(needle)) return text;
  }
  return null;
};

test('schema: positions table exists and is empty', async () => {
  await repo.getUser(TGID);
  assert.equal(await repo.countOpenPositions(TGID), 0);
  assert.equal((await repo.getRecentClosed(TGID)).length, 0);
});

test('full flow: pos_new -> pick -> entry -> amount -> leverage -> side -> confirm', async () => {
  await repo.addToken(TGID, 'BTC');

  sent.length = 0;
  await bot.handleUpdate(msg('/start'));
  await bot.handleUpdate(cb('pos_new'));
  let u = await repo.getUser(TGID);
  assert.equal(u.pending.type, 'pos_new');
  assert.equal(u.pending.step, 'token');

  await bot.handleUpdate(cb('pos_pick.BTC'));
  u = await repo.getUser(TGID);
  assert.equal(u.pending.step, 'entry');
  assert.equal(u.pending.data.symbol, 'BTC');

  await bot.handleUpdate(msg('100'));            // entry
  u = await repo.getUser(TGID);
  assert.equal(u.pending.step, 'amount');
  await bot.handleUpdate(msg('۵۰۰'));            // amount (Persian digits)
  u = await repo.getUser(TGID);
  assert.equal(u.pending.data.amount, 500);
  assert.equal(u.pending.step, 'leverage');
  await bot.handleUpdate(msg('10'));             // leverage
  u = await repo.getUser(TGID);
  assert.equal(u.pending.step, 'side');

  await bot.handleUpdate(cb('pos_side.long'));   // side -> confirm screen with bot TP/SL
  u = await repo.getUser(TGID);
  assert.equal(u.pending.step, 'confirm');
  assert.equal(u.pending.data.takeProfit, 104, 'TP = entry + 2*ATR(2)');
  assert.equal(u.pending.data.stopLoss, 98, 'SL = entry - 1*ATR(2)');
  const confirm = lastEditText('حد سود (ربات)');
  assert.ok(confirm, 'confirm screen shows bot-computed TP/SL');
  assert.match(confirm, /104/);
  assert.match(confirm, /98/);
  assert.match(confirm, /لیکوئید/);

  sent.length = 0;
  await bot.handleUpdate(cb('pos_confirm'));     // open
  u = await repo.getUser(TGID);
  assert.equal(u.pending, null, 'flow finished');
  const [p] = await repo.getOpenPositions(TGID);
  assert.equal(p.symbol, 'BTC');
  assert.equal(p.side, 'long');
  assert.equal(p.entryPrice, 100);
  assert.equal(p.amountUsdt, 500);
  assert.equal(p.leverage, 10);
  assert.equal(p.takeProfit, 104);
  assert.equal(p.stopLoss, 98);
  assert.equal(p.status, 'open');
  assert.match(lastEditText('باز شد'), /باز شد/);
});

test('showPositions renders the open position with live PnL', async () => {
  CUR_PRICE = 100.5; // no hit (SL 98 / TP 104)
  sent.length = 0;
  const user = await repo.getUser(TGID);
  await tg.showPositions(user, CHAT, 4242);
  const text = lastEditText('پوزیشن‌های باز');
  assert.ok(text);
  assert.match(text, /BTC/);
  assert.match(text, /PnL/);
  assert.match(text, /حد سود/);
  assert.match(text, /۰٫۵|0\.5/); // live price shown
  const [p] = await repo.getOpenPositions(TGID);
  assert.equal(p.lastPrice, 100.5, 'last_price refreshed');
});

test('TP hit: checkUserPositions closes at TP, books +PnL, notifies', async () => {
  CUR_PRICE = 105; // crossed TP (104)
  sent.length = 0;
  const res = await sim.checkUserPositions(TGID);
  assert.equal(res.checked, 1);
  assert.equal(res.closed.length, 1);
  const p = res.closed[0].pos;
  assert.equal(p.closeReason, 'tp');
  assert.equal(p.closePrice, 104);
  assert.ok(Math.abs(p.pnl - 200) < 1e-9, 'notional 5000 x +4%');
  assert.ok(Math.abs(p.roiPct - 40) < 1e-9, 'ROE on the 500 margin');
  assert.equal(await repo.countOpenPositions(TGID), 0);

  const notify = lastSentText('پوزیشن بسته شد');
  assert.ok(notify, 'user was notified');
  assert.match(notify, /حد سود/);
  assert.match(notify, /\+200/);

  const hist = await repo.getRecentClosed(TGID);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].closeReason, 'tp');
});

test('SL hit: closes at SL with negative PnL and notification', async () => {
  const p0 = await repo.insertPosition({
    userId: TGID, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 500, leverage: 10, takeProfit: 110, stopLoss: 99, created: Date.now(),
  });
  CUR_PRICE = 98; // crossed SL (99)
  sent.length = 0;
  const res = await sim.checkUserPositions(TGID);
  assert.equal(res.closed.length, 1);
  const p = res.closed[0].pos;
  assert.equal(p.id, p0.id);
  assert.equal(p.closeReason, 'sl');
  assert.equal(p.closePrice, 99);
  assert.ok(Math.abs(p.pnl - -50) < 1e-9, 'notional 5000 x -1%');
  assert.match(lastSentText('حد ضرر'), /حد ضرر/);
});

test('liquidation: wide SL at high leverage -> liq fires first, full margin lost', async () => {
  const p0 = await repo.insertPosition({
    userId: TGID, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 300, leverage: 20, takeProfit: 130, stopLoss: 95, created: Date.now(),
  });
  CUR_PRICE = 95; // liq price = 100*(1-0.95/20) = 95.25 -> liquidated
  sent.length = 0;
  const res = await sim.checkUserPositions(TGID);
  assert.equal(res.closed.length, 1);
  const p = res.closed[0].pos;
  assert.equal(p.id, p0.id);
  assert.equal(p.closeReason, 'liq');
  assert.ok(Math.abs(p.closePrice - 95.25) < 1e-9);
  assert.equal(p.pnl, -300, 'whole margin lost');
  assert.equal(p.roiPct, -100);
  assert.match(lastSentText('لیکوئید'), /لیکوئید/);
});

test('manual close: pos_close -> confirm -> pos_close_y closes at market', async () => {
  const p0 = await repo.insertPosition({
    userId: TGID, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 400, leverage: 5, takeProfit: 130, stopLoss: 80, created: Date.now(),
  });
  CUR_PRICE = 101;
  sent.length = 0;
  await bot.handleUpdate(cb('pos_close.' + p0.id));
  assert.ok(lastEditText('ببندیم'), 'confirm screen shown');
  await bot.handleUpdate(cb('pos_close_y.' + p0.id));
  const p = await repo.getPosition(TGID, p0.id);
  assert.equal(p.status, 'closed');
  assert.equal(p.closeReason, 'manual');
  assert.equal(p.closePrice, 101);
  assert.ok(Math.abs(p.pnl - 20) < 1e-9, 'notional 2000 x +1%');
  assert.ok(Math.abs(p.roiPct - 5) < 1e-9);
  assert.match(lastSentText('بستن دستی'), /بستن دستی/);
});

test('short position: TP when price falls', async () => {
  const p0 = await repo.insertPosition({
    userId: TGID, symbol: 'BTC', side: 'short', entryPrice: 100,
    amountUsdt: 100, leverage: 10, takeProfit: 96, stopLoss: 102, created: Date.now(),
  });
  CUR_PRICE = 95; // crossed short TP (96)
  sent.length = 0;
  const res = await sim.checkUserPositions(TGID);
  assert.equal(res.closed.length, 1);
  const p = res.closed[0].pos;
  assert.equal(p.id, p0.id);
  assert.equal(p.closeReason, 'tp');
  assert.equal(p.closePrice, 96);
  assert.ok(Math.abs(p.pnl - 40) < 1e-9, 'notional 1000 x +4% (short, price fell)');
});

test('showPosHistory lists closed positions with reasons and totals', async () => {
  sent.length = 0;
  const user = await repo.getUser(TGID);
  await tg.showPosHistory(user, CHAT, 4242);
  const text = lastEditText('تاریخچه پوزیشن‌ها');
  assert.ok(text);
  assert.match(text, /حد سود/);
  assert.match(text, /حد ضرر/);
  assert.match(text, /لیکوئید/);
  assert.match(text, /بستن دستی/);
  assert.match(text, /جمع/);
});

test('syncAllPositions (cron sweep) closes hits across users', async () => {
  await repo.insertPosition({
    userId: TGID, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 100, leverage: 5, takeProfit: 100.1, stopLoss: 90, created: Date.now(),
  });
  await repo.getUser(888000222);
  await repo.insertPosition({
    userId: 888000222, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 100, leverage: 5, takeProfit: 100.2, stopLoss: 90, created: Date.now(),
  });
  CUR_PRICE = 101;
  const res = await sim.syncAllPositions();
  assert.equal(res.total, 2);
  assert.equal(res.closed, 2);
  assert.equal(await repo.countOpenPositions(TGID), 0);
  assert.equal(await repo.countOpenPositions(888000222), 0);
});

test('concurrent close guard: closePositionRow only wins while open', async () => {
  const p0 = await repo.insertPosition({
    userId: TGID, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 100, leverage: 5, takeProfit: 110, stopLoss: 95, created: Date.now(),
  });
  assert.equal(await repo.closePositionRow(p0.id, {
    closePrice: 100, closeTime: Date.now(), closeReason: 'tp', pnl: 0, roiPct: 0, lastPrice: 100,
  }), true, 'first close wins');
  assert.equal(await repo.closePositionRow(p0.id, {
    closePrice: 100, closeTime: Date.now(), closeReason: 'sl', pnl: 0, roiPct: 0, lastPrice: 100,
  }), false, 'second close is a no-op');
  const p = await repo.getPosition(TGID, p0.id);
  assert.equal(p.closeReason, 'tp');
});

test('backgroundSyncForUser checks positions without crashing', async () => {
  CUR_PRICE = 101;
  await bot.backgroundSyncForUser(999999); // no user -> no-op
  const res = await sim.checkUserPositions(888000222);
  assert.equal(res.checked, 0, 'that user has nothing open');
});
