import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, getGridStats, syncGrid } from '../api/_lib/simulator.js';

function makeGrid(overrides = {}) {
  return buildGrid({
    symbol: 'BTC',
    deposit: 600,
    lowerPrice: 100,
    totalGridNumber: 6,
    gridIntervalPct: 10,
    startPrice: 150,
    feeRatePct: 0,
    ...overrides
  });
}

test('a downward crossing buys grid tranches and rebound sells the paired tranche one level higher', () => {
  const grid = makeGrid();
  const originalLots = grid.lots.length;

  syncGrid(grid, 130, '2026-01-01T00:00:00.000Z');
  assert.equal(grid.tradeCount, 2);
  assert.equal(grid.lots.length, originalLots + 2);
  assert.equal(grid.recentTrades[0].side, 'BUY');

  syncGrid(grid, 150, '2026-01-01T01:00:00.000Z');
  assert.equal(grid.tradeCount, 3);
  assert.equal(grid.recentTrades[0].side, 'SELL');
  assert.ok(grid.realizedPnl > 0);
});

test('seed inventory realizes profit when price crosses its assigned upper grid', () => {
  const grid = makeGrid({ totalGridNumber: 4, deposit: 400 });
  syncGrid(grid, 170, '2026-01-01T00:00:00.000Z');
  assert.equal(grid.tradeCount, 1);
  assert.equal(grid.recentTrades[0].side, 'SELL');
  assert.ok(grid.realizedPnl > 0);
});

test('lower price acts as a hard floor and does not create an imaginary fill on return', () => {
  const grid = makeGrid();
  syncGrid(grid, 90, '2026-01-01T00:00:00.000Z');
  assert.equal(grid.belowLower, true);
  assert.equal(grid.tradeCount, 0);

  syncGrid(grid, 120, '2026-01-01T01:00:00.000Z');
  assert.equal(grid.belowLower, false);
  assert.equal(grid.tradeCount, 0);
});

test('portfolio statistics return current equity and total PnL', () => {
  const grid = makeGrid();
  const stats = getGridStats(grid);
  assert.equal(stats.equity, 600);
  assert.equal(stats.totalPnl, 0);
});

test('grid creation validates the lower price', () => {
  assert.throws(() => makeGrid({ lowerPrice: 150 }), /Lower price/);
});
