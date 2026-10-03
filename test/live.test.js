// test/live.test.js — live KuCoin grid engine against an in-memory fake exchange + fake repo.
// (No network, no database needed.)

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.OWNER_TG_ID = '42';
process.env.LIVE_TRADING = '1';
process.env.KUCOIN_API_KEY = 'k';
process.env.KUCOIN_API_SECRET = 'secret';
process.env.KUCOIN_API_PASSPHRASE = 'pass';

const live = await import('../lib/live.js');
const kcReal = await import('../lib/kucoin.js');

// ---------------- fake exchange ----------------
function makeExchange() {
  const ex = {
    price: 100, usdt: 10000, orders: new Map(), seq: 0, failAfterAccept: false, notifications: [],
    hasCredentials: () => true,
    async symbolInfo() {
      return { enableTrading: true, priceIncrement: '0.01', baseIncrement: '0.0001', baseMinSize: '0.0001', minFunds: '1' };
    },
    async ticker() { return { price: ex.price }; },
    async usdtAvailable() { return ex.usdt; },
    async placeLimit({ clientOid, side, price, size }) {
      for (const o of ex.orders.values()) if (o.clientOid === clientOid) throw new Error('duplicate clientOid');
      const id = 'O' + (++ex.seq);
      ex.orders.set(id, { id, clientOid, side, price: +price, size: +size, active: true, dealSize: 0, dealFunds: 0, fee: 0 });
      if (ex.failAfterAccept) { ex.failAfterAccept = false; throw new Error('network timeout'); }
      return id;
    },
    async getOrder(id) {
      const o = ex.orders.get(id);
      return { id, isActive: o.active, cancelExist: false, dealSize: o.dealSize, dealFunds: o.dealFunds, fee: o.fee, feeCurrency: 'USDT' };
    },
    async getActiveByClientOid(oid) {
      for (const o of ex.orders.values()) if (o.clientOid === oid && o.active) return { id: o.id, isActive: true };
      return null;
    },
    async cancelOrder(id) {
      const o = ex.orders.get(id);
      if (!o || !o.active) throw new Error('order not exist or not allow to be cancelled');
      o.active = false;
    },
    // move the market; resting limit orders fill when crossed
    move(p) {
      ex.price = p;
      for (const o of ex.orders.values()) {
        if (!o.active) continue;
        const crossed = o.side === 'buy' ? p <= o.price : p >= o.price;
        if (crossed) {
          o.active = false; o.dealSize = o.size; o.dealFunds = o.size * o.price; o.fee = o.dealFunds * 0.001;
        }
      }
    },
    open: () => [...ex.orders.values()].filter((o) => o.active),
  };
  return ex;
}

// ---------------- fake repo ----------------
function makeRepo() {
  const r = { grids: new Map(), rows: [], trades: [], gid: 0, rid: 0 };
  const g = (id) => r.grids.get(id);
  return Object.assign(r, {
    async tryLockGrid(id, now) { const x = g(id); if (x.liveLock > now - 90000 && x.liveLock !== 0) return false; x.liveLock = now; return true; },
    async unlockGrid(id) { g(id).liveLock = 0; },
    async getGrid(userId, id) { return g(id) ? { ...g(id) } : null; },
    async insertGrid(x) { const id = ++r.gid; r.grids.set(id, { ...x, id, liveLock: 0 }); return { ...g(id) }; },
    async setGridState(id, patch) { Object.assign(g(id), patch); },
    async getLiveOrdersOpen(gid) { return r.rows.filter((o) => o.gridId === gid && ['pending', 'open'].includes(o.status)).map((o) => ({ ...o })); },
    async insertLiveOrder(o) {
      if (r.rows.some((x) => x.clientOid === o.clientOid)) throw new Error('unique');
      const row = { id: ++r.rid, status: 'pending', orderId: null, dealSize: 0, dealFunds: 0, fee: 0, attempts: 0,
        buyFunds: 0, buySize: 0, buyFee: 0, ...o };
      r.rows.push(row); return { ...row };
    },
    async updateLiveOrder(id, patch) { Object.assign(r.rows.find((x) => x.id === id), patch); },
    async lastRowAtLevel(gid, level) {
      const rows = r.rows.filter((o) => o.gridId === gid && o.level === level);
      return rows.length ? { ...rows[rows.length - 1] } : null;
    },
    async insertTrades(t) { r.trades.push(...t); },
    async deleteLiveOrdersOfGrid(gid) { r.rows = r.rows.filter((o) => o.gridId !== gid); },
    async getLiveGridsOfUser(uid) { return [...r.grids.values()].filter((x) => x.userId === uid && x.live && x.active).map((x) => ({ ...x })); },
  });
}

let ex, repo, notes;
const user = { tgId: 42 };
const D = { symbol: 'BTC', deposit: 500, lowerPrice: 90, gridCount: 5, intervalPct: 2 };

beforeEach(() => {
  ex = makeExchange(); repo = makeRepo(); notes = [];
  live.deps.kc = ex; live.deps.repo = repo;
  live.deps.notify = async (_id, text) => { notes.push(text); };
  process.env.OWNER_TG_ID = '42';
});

test('create: one resting buy per level below the market', async () => {
  const { grid, confirmText } = await live.createLiveGrid(user, D);
  assert.equal(grid.live, true);
  assert.equal(ex.open().length, 5);
  assert.ok(ex.open().every((o) => o.side === 'buy'));
  assert.deepEqual(ex.open().map((o) => o.price).sort((a, b) => a - b), [90, 91.8, 93.6, 95.4, 97.2]);
  assert.ok(ex.open().every((o) => Math.abs(o.size * o.price - 100) < 0.5), 'each buy ≈ deposit/gridCount');
  assert.match(confirmText, /5 سفارش خرید واقعی/);
});

test('levels above the market are armed later, when the market is above them', async () => {
  ex.price = 93; // only 90 and 91.8 are below
  const { grid } = await live.createLiveGrid(user, D);
  assert.equal(ex.open().length, 2);
  ex.price = 100;
  await live.liveSync(42, grid);
  assert.equal(ex.open().length, 5);
});

test('buy fill -> sell one interval above; sell fill -> profit booked and level re-armed', async () => {
  const { grid } = await live.createLiveGrid(user, D);
  ex.move(95); // fills buys at 97.2 and 95.4
  let g = await live.liveSync(42, grid);
  assert.equal(g.tradeCount, 2);
  assert.deepEqual(g.heldLevels, [3, 4]);
  assert.ok(g.position > 0 && g.cash < 500 - 190);
  const sells = ex.open().filter((o) => o.side === 'sell').map((o) => o.price).sort((a, b) => a - b);
  assert.deepEqual(sells, [97.2, 99]);

  ex.move(100);           // both sells fill
  g = await live.liveSync(42, g);
  assert.equal(g.heldLevels.length, 0);
  assert.equal(g.tradeCount, 4);
  assert.ok(g.realized > 0, 'profit after fees');
  assert.ok(Math.abs(g.position) < 1e-9);
  assert.equal(ex.open().filter((o) => o.side === 'buy').length, 5, 'all levels armed again');
  assert.ok(notes.some((n) => n.includes('فروش واقعی')));
});

test('idempotent placement: accepted-but-timed-out order is adopted, never duplicated', async () => {
  ex.failAfterAccept = true;
  const { grid } = await live.createLiveGrid(user, D);
  assert.equal(ex.orders.size, 5);                                   // all five exist exactly once
  await live.liveSync(42, grid);                                     // retry pass
  assert.equal(ex.orders.size, 5, 'no duplicate order');
  assert.ok(repo.rows.every((r) => r.status === 'open' && r.orderId));
});

test('per-grid lock: a concurrent sync does nothing', async () => {
  const { grid } = await live.createLiveGrid(user, D);
  repo.grids.get(grid.id).liveLock = Date.now();                     // someone else is syncing
  const before = ex.orders.size;
  ex.move(95);
  await live.liveSync(42, grid);
  assert.equal(ex.orders.size, before);
  assert.equal(repo.grids.get(grid.id).tradeCount, 0);
});

test('stop cancels resting orders but keeps held coins; resume re-creates the sell', async () => {
  const { grid } = await live.createLiveGrid(user, D);
  ex.move(97);                                                       // fills 97.2 (level 4 is 97.2)
  let g = await live.liveSync(42, grid);
  assert.equal(g.heldLevels.length, 1);
  const r = await live.cancelGridOrders(g);
  assert.ok(r.cancelled >= 1);
  assert.equal(ex.open().length, 0, 'nothing resting after stop');
  const held = repo.grids.get(grid.id).heldLevels;
  assert.equal(held.length, 1, 'coins stay held');

  repo.grids.get(grid.id).active = true;
  g = await live.liveSync(42, { ...repo.grids.get(grid.id) });
  const sells = ex.open().filter((o) => o.side === 'sell');
  assert.equal(sells.length, 1, 'sell re-created for the held level');
});

test('delete removes order rows after cancelling', async () => {
  const { grid } = await live.createLiveGrid(user, D);
  assert.equal(await live.deleteLiveGrid(grid), true);
  assert.equal(ex.open().length, 0);
  assert.equal(repo.rows.length, 0);
});

test('panic stops every live grid', async () => {
  await live.createLiveGrid(user, D);
  await live.createLiveGrid(user, { ...D, symbol: 'ETH' });
  const r = await live.panicStop(42);
  assert.equal(r.grids, 2);
  assert.equal(ex.open().length, 0);
});

test('only the owner can trade live', async () => {
  await assert.rejects(() => live.createLiveGrid({ tgId: 7 }, D), /مالک/);
  assert.equal(live.canTrade(7), false);
  assert.equal(live.canTrade(42), true);
  process.env.LIVE_TRADING = '0';
  assert.equal(live.canTrade(42), false);
  process.env.LIVE_TRADING = '1';
});

test('rejects when balance is too low or order size is below the exchange minimum', async () => {
  ex.usdt = 100;
  await assert.rejects(() => live.createLiveGrid(user, D), /موجودی/);
  ex.usdt = 10000;
  await assert.rejects(() => live.createLiveGrid(user, { ...D, deposit: 2 }), /حداقل سفارش/);
  assert.equal(ex.orders.size, 0, 'nothing was sent');
});

test('a ticker failure after fills does not lose the booked fills', async () => {
  const { grid } = await live.createLiveGrid(user, D);
  ex.move(95);
  const realTicker = ex.ticker;
  ex.ticker = async () => { throw new Error('ticker down'); };
  await assert.rejects(() => live.liveSync(42, grid), /ticker down/);
  assert.equal(repo.grids.get(grid.id).tradeCount, 2, 'ledger persisted despite the error');
  ex.ticker = realTicker;
});

test('rounding helpers', () => {
  assert.equal(live.floorTo(0.123456, 0.0001), 0.1234);
  assert.equal(live.roundTo(97.236, 0.01), 97.24);
  assert.equal(live.floorTo(1.00009, 0.001), 1);
});

test('KuCoin request signing (API key v2)', () => {
  const h = kcReal.signHeaders('POST', '/api/v1/orders', '{"a":1}', 1700000000000);
  const sign = createHmac('sha256', 'secret').update('1700000000000POST/api/v1/orders{"a":1}').digest('base64');
  const pp = createHmac('sha256', 'secret').update('pass').digest('base64');
  assert.equal(h['KC-API-SIGN'], sign);
  assert.equal(h['KC-API-PASSPHRASE'], pp);
  assert.equal(h['KC-API-KEY-VERSION'], '2');
  assert.equal(h['KC-API-TIMESTAMP'], '1700000000000');
  assert.equal(h['KC-API-KEY'], 'k');
});
