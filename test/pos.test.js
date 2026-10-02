// test/pos.test.js — pure position math (no I/O).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTpsl, posPnl, checkClose, closePnl, liqPrice, atr14, notional,
} from '../lib/pos.js';

test('computeTpsl long: TP 2*ATR above, SL 1*ATR below', () => {
  const r = computeTpsl('long', 100, 2);
  assert.ok(Math.abs(r.takeProfit - 104) < 1e-9);
  assert.ok(Math.abs(r.stopLoss - 98) < 1e-9);
});

test('computeTpsl short: mirrored', () => {
  const r = computeTpsl('short', 100, 2);
  assert.ok(Math.abs(r.takeProfit - 96) < 1e-9);
  assert.ok(Math.abs(r.stopLoss - 102) < 1e-9);
});

test('computeTpsl fallback: null ATR -> 3% of entry', () => {
  const r = computeTpsl('long', 100, null);
  assert.ok(Math.abs(r.takeProfit - 106) < 1e-9); // 2 * 3
  assert.ok(Math.abs(r.stopLoss - 97) < 1e-9);    // 1 * 3
});

test('posPnl long: notional x price change, ROE on margin', () => {
  const p = { side: 'long', entryPrice: 100, amountUsdt: 100, leverage: 10 };
  assert.equal(notional(p), 1000);
  const r = posPnl(p, 102); // +2%
  assert.ok(Math.abs(r.pnl - 20) < 1e-9);
  assert.ok(Math.abs(r.roiPct - 20) < 1e-9); // 20% of the 100 margin
});

test('posPnl short: profit when price falls', () => {
  const p = { side: 'short', entryPrice: 100, amountUsdt: 100, leverage: 10 };
  const r = posPnl(p, 98); // -2% move, short -> +20
  assert.ok(Math.abs(r.pnl - 20) < 1e-9);
  assert.ok(Math.abs(r.roiPct - 20) < 1e-9);
});

test('checkClose long: tp / sl / liq / no-hit', () => {
  const p = { side: 'long', entryPrice: 100, amountUsdt: 100, leverage: 10, takeProfit: 110, stopLoss: 95 };
  assert.deepEqual(checkClose(p, 110), { reason: 'tp', price: 110 });
  assert.deepEqual(checkClose(p, 95), { reason: 'sl', price: 95 });
  // liquidation (90.5) sits below this wide SL -> liq wins first
  assert.deepEqual(checkClose(p, 90), { reason: 'liq', price: liqPrice(p) });
  assert.equal(checkClose(p, 100), null);
});

test('checkClose short: mirrored', () => {
  const p = { side: 'short', entryPrice: 100, amountUsdt: 100, leverage: 10, takeProfit: 90, stopLoss: 105 };
  assert.deepEqual(checkClose(p, 90), { reason: 'tp', price: 90 });
  assert.deepEqual(checkClose(p, 105), { reason: 'sl', price: 105 });
  assert.deepEqual(checkClose(p, 110), { reason: 'liq', price: liqPrice(p) });
  assert.equal(checkClose(p, 100), null);
});

test('liqPrice: ~1/leverage adverse move with 0.5% buffer', () => {
  const long = liqPrice({ side: 'long', entryPrice: 100, leverage: 10 });
  assert.ok(Math.abs(long - 90.5) < 1e-9);
  const short = liqPrice({ side: 'short', entryPrice: 100, leverage: 10 });
  assert.ok(Math.abs(short - 109.5) < 1e-9);
  // 1x leverage: liquidation only after a ~95% adverse move
  const flat = liqPrice({ side: 'long', entryPrice: 100, leverage: 1 });
  assert.ok(Math.abs(flat - 5) < 1e-9);
  // very high leverage: buffer floors the distance at 0.5%
  const high = liqPrice({ side: 'long', entryPrice: 100, leverage: 200 });
  assert.ok(Math.abs(high - 99.5) < 1e-9);
});

test('closePnl: liq loses the whole margin; tp/sl use posPnl', () => {
  const p = { side: 'long', entryPrice: 100, amountUsdt: 200, leverage: 5, takeProfit: 105, stopLoss: 97 };
  assert.deepEqual(closePnl(p, 'liq', 95), { pnl: -200, roiPct: -100 });
  const tp = closePnl(p, 'tp', 105);
  assert.ok(Math.abs(tp.pnl - 50) < 1e-9);   // 200*5 = 1000 notional, +5%
  assert.ok(Math.abs(tp.roiPct - 25) < 1e-9);
  const sl = closePnl(p, 'sl', 97);
  assert.ok(Math.abs(sl.pnl - -30) < 1e-9);  // -3% of 1000
});

test('atr14: constant 2-wide candles -> ATR exactly 2', () => {
  const klines = [];
  for (let i = 0; i < 30; i++) {
    klines.push({ t: i * 3600e3, o: 100, h: 101, l: 99, c: 100 });
  }
  const a = atr14(klines, 14);
  assert.ok(a != null && Math.abs(a - 2) < 1e-9, 'atr = ' + a);
});

test('atr14: not enough history -> null', () => {
  assert.equal(atr14([{ t: 0, o: 1, h: 2, l: 0.5, c: 1 }], 14), null);
  assert.equal(atr14([], 14), null);
  assert.equal(atr14(null, 14), null);
});
