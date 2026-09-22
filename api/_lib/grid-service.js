import { getPrices } from './market.js';
import { listGrids, saveGrid } from './repository.js';
import { syncGrid } from './simulator.js';

export async function refreshOneGrid(redis, grid, prices, timestamp = new Date().toISOString()) {
  const marketPrice = prices.get(grid.pair);
  if (!marketPrice) return grid;
  if (grid.status === 'active') {
    syncGrid(grid, marketPrice, timestamp);
  } else {
    grid.lastPrice = marketPrice;
    grid.lastSyncAt = timestamp;
  }
  await saveGrid(redis, grid);
  return grid;
}

export async function syncAllActiveGrids(redis) {
  const grids = await listGrids(redis);
  const active = grids.filter((grid) => grid.status === 'active');
  if (!active.length) return { grids, synced: 0, trades: 0 };

  const tradesBefore = active.reduce((sum, grid) => sum + grid.tradeCount, 0);
  const prices = await getPrices(active.map((grid) => grid.symbol));
  const timestamp = new Date().toISOString();
  await Promise.all(active.map((grid) => refreshOneGrid(redis, grid, prices, timestamp)));
  const refreshed = await listGrids(redis);
  const tradesAfter = refreshed.reduce((sum, grid) => sum + grid.tradeCount, 0);
  return { grids: refreshed, synced: active.length, trades: tradesAfter - tradesBefore };
}
