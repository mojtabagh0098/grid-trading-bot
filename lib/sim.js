// lib/sim.js — orchestrates grid simulation: fetch candle history, run the engine, persist state.

import { getSeries, getTicker, getAtr } from './prices.js';
import { processGrid, gridLevels } from './grid.js';
import { computeTpsl, checkClose, closePnl } from './pos.js';
import * as repo from './repo.js';
import * as ui from './tg.js';
import * as live from './live.js';
import { topPrice, fmtPrice } from './util.js';

const MIN_GAP_MS = 15 * 60000;  // when creating: replay the last 15 minutes immediately
const FRESH_MS = 5 * 60000;     // within 5 minutes -> state is fresh, only refresh display price

/**
 * Sync one grid through its candle history (catch-up capable) and persist the result.
 * Returns the updated grid row plus `source` (which exchange price was used).
 */
export async function syncGrid(userId, grid) {
  if (grid.live) return live.liveSync(userId, grid);   // real KuCoin orders
  const now = Date.now();
  const since = grid.lastSync > 0 ? grid.lastSync : now - MIN_GAP_MS;
  const series = await getSeries(grid.symbol, since);
  const res = processGrid(grid, series.klines, series.prevClose);

  const patch = {
    lastSync: res.lastSync,
    lastPrice: res.lastPrice,
    cash: res.cash,
    position: res.position,
    costBasis: res.costBasis,
    realized: res.realized,
    tradeCount: res.tradeCount,
    heldLevels: res.heldLevels,
  };

  // light guard: if a concurrent update already advanced this grid, keep the newer state
  const fresh = await repo.getGrid(userId, grid.id);
  if (fresh && fresh.lastSync >= res.lastSync && fresh.lastSync > grid.lastSync) {
    return { ...fresh, source: series.source };
  }

  await repo.setGridState(grid.id, patch);
  if (res.trades.length) {
    await repo.insertTrades(res.trades.map((t) => ({
      gridId: grid.id, userId, level: t.level, side: t.side, price: t.price, qty: t.qty, t: t.t,
    })));
  }
  return { ...grid, ...patch, source: series.source };
}

/**
 * Background sync for the Vercel cron endpoint: replay every active grid.
 * Bounded by a time budget and a grid cap so it always fits the function timeout.
 */
export async function syncAllActiveGrids() {
  const grids = await repo.getAllActiveGrids();
  const deadline = Date.now() + 45000;
  let synced = 0, failed = 0, skipped = 0;
  for (const g of grids) {
    if (synced >= 50 || Date.now() > deadline) { skipped++; continue; }
    try {
      await syncGrid(g.userId, g);
      synced++;
    } catch (e) {
      failed++;
      console.warn('syncAll: grid failed', g.id, g.symbol, e.message);
    }
  }
  return { total: grids.length, synced, failed, skipped };
}

/**
 * Sync a grid if it is stale; otherwise just refresh its display price.
 * Never throws — display problems should not break the UI.
 */
export async function safeSync(userId, grid, priceCache) {
  const now = Date.now();
  if (grid.active && (now - (grid.lastSync || 0) > FRESH_MS)) {
    return syncGrid(userId, grid);
  }
  let price = grid.lastPrice;
  let source = null;
  try {
    if (priceCache && priceCache[grid.symbol]) {
      ({ price, source } = priceCache[grid.symbol]);
    } else {
      const t = await getTicker(grid.symbol);
      price = t.price; source = t.source;
      if (priceCache) priceCache[grid.symbol] = { price, source };
    }
  } catch {
    /* keep last known price */
  }
  return { ...grid, lastPrice: price, source };
}

/**
 * Create a grid: fetch current price, seed state, replay the last 15 minutes,
 * persist, and return { grid, confirmText }.
 */
export async function createGrid(user, d, priceSource) {
  if (user.live) {
    // never silently fall back to simulation while the user believes they trade for real
    if (!live.canTrade(user.tgId)) {
      throw new Error('حالت واقعی روشن است ولی معامله واقعی فعال نیست (LIVE_TRADING / کلیدهای KuCoin / OWNER_TG_ID را چک کن). با /live آن را خاموش کن.');
    }
    return live.createLiveGrid(user, d);
  }
  const now = Date.now();
  const since = now - MIN_GAP_MS;
  const series = await getSeries(d.symbol, since);

  const base = {
    lowerPrice: d.lowerPrice,
    gridCount: d.gridCount,
    intervalPct: d.intervalPct,
    deposit: d.deposit,
    lastSync: since,
    lastPrice: series.prevClose != null ? series.prevClose : series.lastPrice,
    cash: d.deposit,
    position: 0,
    costBasis: 0,
    realized: 0,
    tradeCount: 0,
    heldLevels: [],
  };
  const res = processGrid(base, series.klines);

  const grid = await repo.insertGrid({
    userId: user.tgId,
    symbol: d.symbol,
    deposit: d.deposit,
    lowerPrice: d.lowerPrice,
    gridCount: d.gridCount,
    intervalPct: d.intervalPct,
    active: true,
    lastSync: res.lastSync,
    lastPrice: res.lastPrice,
    cash: res.cash,
    position: res.position,
    costBasis: res.costBasis,
    realized: res.realized,
    tradeCount: res.tradeCount,
    heldLevels: res.heldLevels,
    created: now,
  });

  if (res.trades.length) {
    await repo.insertTrades(res.trades.map((t) => ({
      gridId: grid.id, userId: user.tgId, level: t.level, side: t.side, price: t.price, qty: t.qty, t: t.t,
    })));
  }

  const g = { ...grid, source: series.source };
  const levels = gridLevels({ lowerPrice: g.lowerPrice, gridCount: g.gridCount, intervalPct: g.intervalPct });
  const source = g.source || priceSource || '?';
  let warn = '';
  if (g.lastPrice > topPrice(g)) {
    warn = '\n\n⚠️ قیمت فعلی بالاتر از سقف گرید است؛ تا وقتی قیمت از بالا به سطوح نزسد، خریدی انجام نمی‌شود.';
  } else if (g.lastPrice < g.lowerPrice) {
    warn = '\n\n⚠️ قیمت فعلی پایین‌تر از قیمت پایین گرید است؛ تا وقتی قیمت از بالا به سطوح برسد، خریدی انجام نمی‌شود.';
  }
  const text =
    `✅ گرید ساخته شد و شبیه‌سازی شروع شد!\n\n` +
    `🪙 توکن: ${g.symbol}\n` +
    `💵 سرمایه: ${fmtPrice(g.deposit)} USDT (${fmtPrice(g.deposit / g.gridCount)} در هر گرید)\n` +
    `📉 قیمت پایین: ${fmtPrice(g.lowerPrice)}\n` +
    `🎯 سقف گرید: ${fmtPrice(topPrice(g))}\n` +
    `🧵 تعداد گرید: ${g.gridCount}\n` +
    `📏 فاصله گریدها: ${g.intervalPct}%\n` +
    `💹 قیمت فعلی: ${fmtPrice(g.lastPrice)} (${source})${warn}\n\n` +
    `هر بار که لیست گریدها را باز کنید، شبیه‌سازی با کندل‌های ۱ دقیقه‌ای به‌روز می‌شود.`;
  return { grid: g, confirmText: text };
}

export { topPrice };

// ================= positions (leveraged long/short with bot-set TP/SL) =================

export const MAX_OPEN_POSITIONS = 10;

/**
 * Open a simulated leveraged position.
 * d: { symbol, entry, amount, leverage, side, takeProfit?, stopLoss? }
 * TP/SL normally come from the flow (computed there from ATR so the user sees
 * them before opening); if missing they are computed here.
 */
export async function openPosition(user, d) {
  const open = await repo.countOpenPositions(user.tgId);
  if (open >= MAX_OPEN_POSITIONS) {
    throw new Error(`حداکثر ${MAX_OPEN_POSITIONS} پوزیشن هم‌زمان باز می‌ماند`);
  }
  let takeProfit = d.takeProfit;
  let stopLoss = d.stopLoss;
  if (takeProfit == null || stopLoss == null) {
    let atr = null;
    try { atr = (await getAtr(d.symbol)).atr; } catch { /* 3% fallback */ }
    ({ takeProfit, stopLoss } = computeTpsl(d.side, d.entry, atr));
  }
  const pos = await repo.insertPosition({
    userId: user.tgId, symbol: d.symbol, side: d.side,
    entryPrice: d.entry, amountUsdt: d.amount, leverage: d.leverage,
    takeProfit, stopLoss, created: Date.now(),
  });
  return { pos, takeProfit, stopLoss };
}

/**
 * Close a position at `price` and notify the user.
 * Returns the closed row, or null if it was already closed (concurrent close).
 */
export async function closePosition(tgId, posId, { reason, price, last }) {
  const p = await repo.getPosition(tgId, posId);
  if (!p || p.status !== 'open') return null;
  const { pnl, roiPct } = closePnl(p, reason, price);
  const now = Date.now();
  const won = await repo.closePositionRow(posId, {
    closePrice: price, closeTime: now, closeReason: reason, pnl, roiPct,
    lastPrice: last != null ? last : price,
  });
  if (!won) return null;
  const done = {
    ...p, status: 'closed', closePrice: price, closeTime: now, closeReason: reason,
    pnl, roiPct, lastPrice: last != null ? last : price,
  };
  try {
    await ui.notifyPositionClosed(tgId, done);
  } catch (e) {
    console.warn('close notification failed:', e.message);
  }
  return done;
}

/**
 * Check one user's open positions against live prices: close TP/SL/liq hits
 * (with notifications) and keep last_price fresh. Never throws.
 * @returns {{checked: number, closed: Array<{pos: object, text: string}>}}
 */
export async function checkUserPositions(tgId, budgetMs = 20000) {
  const list = await repo.getOpenPositions(tgId);
  const out = { checked: 0, closed: [] };
  if (!list.length) return out;
  const deadline = Date.now() + budgetMs;
  const cache = {};
  for (const p of list.slice(0, 15)) {
    if (Date.now() > deadline) break;
    let t;
    try {
      t = cache[p.symbol] || (cache[p.symbol] = await getTicker(p.symbol));
    } catch {
      continue; // price unavailable: keep the last known one
    }
    const price = t.price;
    out.checked++;
    const hit = checkClose(p, price);
    if (hit) {
      try {
        const done = await closePosition(tgId, p.id, { reason: hit.reason, price: hit.price, last: price });
        if (done) out.closed.push({ pos: done, text: ui.positionClosedText(done) });
      } catch (e) {
        console.warn('closePosition failed', p.id, e.message);
      }
    } else {
      await repo.setPositionState(p.id, { lastPrice: price });
    }
  }
  return out;
}

/**
 * Vercel-cron sweep over every user's open positions (bounded: 60 / 30s).
 */
export async function syncAllPositions() {
  const all = await repo.getAllOpenPositions();
  const deadline = Date.now() + 30000;
  let checked = 0, closed = 0, failed = 0;
  const cache = {};
  for (const p of all) {
    if (checked >= 60 || Date.now() > deadline) break;
    let t;
    try {
      t = cache[p.symbol] || (cache[p.symbol] = await getTicker(p.symbol));
    } catch {
      failed++;
      continue;
    }
    checked++;
    const price = t.price;
    const hit = checkClose(p, price);
    if (hit) {
      try {
        const done = await closePosition(p.userId, p.id, { reason: hit.reason, price: hit.price, last: price });
        if (done) closed++;
      } catch (e) {
        failed++;
        console.warn('syncAllPositions close failed', p.id, e.message);
      }
    } else {
      await repo.setPositionState(p.id, { lastPrice: price });
    }
  }
  return { total: all.length, checked, closed, failed };
}
