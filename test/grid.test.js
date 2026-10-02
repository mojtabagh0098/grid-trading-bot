// test/grid.test.js — unit tests for the pure grid engine + util helpers.
// Run with: npm test   (plain `node --test`, no platform SDK needed)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processGrid, gridLevels, sellTarget, gridMetrics } from '../lib/grid.js';
import { toNum, fmtPrice, tTime, topPrice } from '../lib/util.js';

const MIN = 60000;
const T0 = 1_700_000_000_000; // arbitrary base time (ms)

function state(over = {}) {
  return {
    lowerPrice: 100, gridCount: 10, intervalPct: 2, deposit: 1000,
    lastSync: T0, lastPrice: 109,
    cash: 1000, position: 0, costBasis: 0, realized: 0, tradeCount: 0, heldLevels: [],
    ...over,
  };
}

// bearish candle: open 109 -> low 100.5 -> close 101
const klineDown = { t: T0, o: 109, h: 109.2, l: 100.5, c: 101 };
// bullish candle: open 101 -> high/close 110.5 (close at the high so no trailing
// dip crosses the open level-110 buy, keeping the round-trip exact)
const klineUp = { t: T0 + MIN, o: 101, h: 110.5, l: 100.8, c: 110.5 };

test('levels are arithmetic on lowerPrice', () => {
  const lv = gridLevels({ lowerPrice: 100, gridCount: 5, intervalPct: 2 });
  assert.deepEqual(lv, [100, 102, 104, 106, 108]);
});

test('sell target is next level; top level gets the infinity tail', () => {
  const g = { lowerPrice: 100, gridCount: 5, intervalPct: 2 };
  const lv = gridLevels(g);
  assert.equal(sellTarget(g, lv, 0), 102);
  assert.equal(sellTarget(g, lv, 3), 108);
  assert.ok(Math.abs(sellTarget(g, lv, 4) - 110) < 1e-9); // 108 * 1.02
});

test('sawtooth: buys on the way down, sells on the way up, profit > 0', () => {
  const res = processGrid(state(), [klineDown, klineUp]);
  const per = 100; // 1000 / 10
  const expectedProfit = per * (2 / 102 + 2 / 104 + 2 / 106 + 2 / 108);

  assert.equal(res.tradeCount, 8);
  assert.equal(res.trades.filter(t => t.side === 'buy').length, 4);
  assert.equal(res.trades.filter(t => t.side === 'sell').length, 4);
  assert.deepEqual(res.heldLevels, []);
  assert.ok(Math.abs(res.position) < 1e-12);
  assert.ok(Math.abs(res.realized - expectedProfit) < 1e-9);
  // accounting identity: cash + costBasis == deposit + realized
  assert.ok(Math.abs(res.cash + res.costBasis - (1000 + res.realized)) < 1e-9);
  assert.equal(res.lastSync, T0 + 2 * MIN);
  assert.equal(res.lastPrice, 110.5);
});

test('buy at the top level sells on the infinity tail', () => {
  const g = state({ lowerPrice: 100, gridCount: 2, intervalPct: 10, lastPrice: 112 });
  // drop from 112 to 109.5 -> buys level 110 (top level)
  const k1 = { t: T0, o: 112, h: 112.1, l: 109.5, c: 109.6 };
  const r1 = processGrid(g, [k1]);
  assert.deepEqual(r1.heldLevels, [1]);
  assert.ok(Math.abs(r1.cash - 500) < 1e-9);

  // rise to 122 -> sell at 120 (one uniform interval above the top: 100*(1+2*10%))
  const k2 = { t: T0 + MIN, o: 109.6, h: 122, l: 109.4, c: 121.5 };
  const r2 = processGrid({ ...g, ...r1 }, [k2]);
  assert.deepEqual(r2.heldLevels, []);
  const qty = 500 / 110;
  assert.ok(Math.abs(r2.realized - qty * (120 - 110)) < 1e-9);
});

test('flat price: nothing happens', () => {
  const k = { t: T0, o: 105, h: 105.0, l: 105.0, c: 105.0 };
  const res = processGrid(state({ lastPrice: 105 }), [k]);
  assert.equal(res.tradeCount, 0);
  assert.equal(res.trades.length, 0);
  assert.equal(res.lastSync, T0 + MIN);
  assert.equal(res.lastPrice, 105);
});

test('price far below all levels: no buys until it crosses a level from above', () => {
  // price is already below the lowest level; rising into the range must NOT buy
  const g = state({ lastPrice: 95 });
  const k = { t: T0, o: 95, h: 101.5, l: 94.5, c: 101 };
  const res = processGrid(g, [k]);
  assert.equal(res.tradeCount, 0);

  // now it falls back onto level 102? no — level is 100; falling from 101 crosses 100
  const k2 = { t: T0 + MIN, o: 101, h: 101.2, l: 99.2, c: 99.5 };
  const res2 = processGrid({ ...g, ...res }, [k2]);
  assert.equal(res2.tradeCount, 1);
  // perGrid = 1000/10 = 100 USDT; buying at 100 -> qty = 1
  assert.deepEqual(res2.trades, [{ level: 0, side: 'buy', price: 100, qty: 1, t: T0 + MIN }]);
});

test('crash fills every level, cash never goes negative', () => {
  const g = state({ lowerPrice: 100, gridCount: 3, intervalPct: 2, lastPrice: 110 });
  const k = { t: T0, o: 110, h: 110, l: 90, c: 90 };
  const res = processGrid(g, [k]);
  assert.deepEqual(res.heldLevels, [0, 1, 2]);
  assert.ok(res.cash >= -1e-9);
  const per = 1000 / 3;
  assert.ok(Math.abs(res.position - (per / 100 + per / 102 + per / 104)) < 1e-12);
});

test('random walk keeps the accounting identity and non-negative cash', () => {
  let s = state({ lastPrice: 105 });
  let price = 105;
  let t = T0;
  for (let i = 0; i < 3000; i++) {
    const o = price;
    const drift = (Math.random() - 0.495) * 3;
    const c = Math.max(1, o + drift);
    const h = Math.max(o, c) + Math.random() * 1.2;
    const l = Math.max(0.5, Math.min(o, c) - Math.random() * 1.2);
    s = processGrid(s, [{ t, o, h, l, c }]);
    price = c;
    t += MIN;
    assert.ok(s.cash > -1e-9, 'cash negative at step ' + i);
    assert.ok(s.position > -1e-9, 'position negative at step ' + i);
    assert.ok(Math.abs(s.cash + s.costBasis - (1000 + s.realized)) < 1e-6, 'identity broken at step ' + i);
    for (const i2 of s.heldLevels) assert.ok(i2 >= 0 && i2 < 10);
  }
  // grid must have made money overall in this mildly mean-reverting walk (or at least not lost on realized)
  assert.ok(s.realized >= 0);
});

test('empty klines: state passes through with startPrice as lastPrice', () => {
  const res = processGrid(state(), [], 107.5);
  assert.equal(res.lastPrice, 107.5);
  assert.equal(res.tradeCount, 0);
  assert.equal(res.lastSync, T0);
});

test('metrics', () => {
  const g = { cash: 900, position: 0.1, deposit: 1000, costBasis: 100, realized: 5 };
  const m = gridMetrics(g, 1050);
  assert.ok(Math.abs(m.equity - 1005) < 1e-9);
  assert.ok(Math.abs(m.totalPnl - 5) < 1e-9);
  assert.ok(Math.abs(m.totalPct - 0.5) < 1e-9);
  assert.ok(Math.abs(m.unrealized - 5) < 1e-9);
});

test('toNum handles Persian digits and separators', () => {
  assert.equal(toNum('۱۲۳۴.۵'), 1234.5);
  assert.equal(toNum('۱٬۲۳۴'), 1234);
  assert.equal(toNum('1,500.75'), 1500.75);
  assert.equal(toNum('۰٫۵'), 0.5);
  assert.ok(Number.isNaN(toNum('abc')));
  assert.ok(Number.isNaN(toNum('')));
  assert.ok(Number.isNaN(toNum('1.2.3')));
});

test('tTime uses Tehran offset (UTC+3:30)', () => {
  // 2026-09-22 00:00:00 UTC -> 03:30 Tehran on 22/09
  assert.equal(tTime(Date.UTC(2026, 8, 22, 0, 0)), '22/09 03:30');
  // 21:45 UTC + 3:30 -> 01:15 next day
  assert.equal(tTime(Date.UTC(2026, 8, 21, 21, 45)), '22/09 01:15');
});

test('fmtPrice formatting', () => {
  assert.equal(fmtPrice(97432.156), '97,432.2');
  assert.equal(fmtPrice(1.5), '1.50');
  assert.equal(fmtPrice(0.001234), '0.001234');
  assert.equal(fmtPrice(null), '—');
});

test('topPrice matches last grid level', () => {
  const g = { lowerPrice: 95000, gridCount: 20, intervalPct: 1.5 };
  assert.ok(Math.abs(topPrice(g) - 95000 * (1 + 19 * 0.015)) < 1e-9);
});
