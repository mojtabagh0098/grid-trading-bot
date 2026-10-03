// lib/live.js — REAL grid trading on KuCoin spot (limit orders resting on the exchange).
//
// Model (same maths as lib/grid.js, but with real orders):
//   * one resting limit BUY per grid level that lies below the market price
//   * when a buy fills, a limit SELL is placed one interval above (levels[i+1])
//   * when the sell fills the level is empty again and a new buy is placed
// Fills happen on the exchange 24/7. The bot only has to *notice* them (sync) to place the
// counter-order, so how often /api/cron runs decides how fast the grid recycles.
//
// Safety properties (these are correctness, not limits):
//   * only OWNER_TG_ID can trade live — otherwise any Telegram user could spend your funds
//   * every order row is written to the DB BEFORE it is sent, with a deterministic clientOid,
//     so a retry / double webhook can never place the same order twice
//   * a per-grid DB lock serialises concurrent syncs (webhook + cron)
//
// Env: LIVE_TRADING=1, OWNER_TG_ID, KUCOIN_API_KEY / KUCOIN_API_SECRET / KUCOIN_API_PASSPHRASE

import * as repo from './repo.js';
import * as kc from './kucoin.js';
import * as ui from './tg.js';
import { gridLevels, sellTarget } from './grid.js';
import { fmtPrice } from './util.js';

// Replaceable in tests.
export const deps = {
  repo,
  kc,
  now: () => Date.now(),
  notify: async (tgId, text) => {
    try { await ui.api.sendMessage({ chat_id: tgId, text }); } catch (e) { console.warn('notify failed', e.message); }
  },
};

const MAX_ATTEMPTS = 5;
const PLACE_BATCH = 8;           // parallel order placements
const BUY_MARGIN = 0.0005;       // buy only if level <= price * (1 - 0.05%) so the order rests (maker)

// ---------------------------------------------------------------- guards

export const isLiveEnabled = () => process.env.LIVE_TRADING === '1' && deps.kc.hasCredentials();
export const isOwner = (tgId) => !!process.env.OWNER_TG_ID && String(tgId) === String(process.env.OWNER_TG_ID);
export const canTrade = (tgId) => isLiveEnabled() && isOwner(tgId);

// ---------------------------------------------------------------- number helpers

const decimals = (inc) => {
  const s = inc.toFixed(12).replace(/0+$/, '');
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
};
export const floorTo = (x, inc) => +(Math.floor(x / inc + 1e-9) * inc).toFixed(decimals(inc));
export const roundTo = (x, inc) => +(Math.round(x / inc) * inc).toFixed(decimals(inc));

const rulesCache = new Map();
async function getRules(symbol) {
  if (rulesCache.has(symbol)) return rulesCache.get(symbol);
  const i = await deps.kc.symbolInfo(symbol);
  if (!i.enableTrading) throw new Error(`معامله ${symbol} در KuCoin فعال نیست`);
  const rules = {
    priceInc: +i.priceIncrement,
    baseInc: +i.baseIncrement,
    baseMin: +i.baseMinSize || 0,
    minFunds: +(i.minFunds || i.quoteMinSize) || 0,
  };
  rulesCache.set(symbol, rules);
  return rules;
}

const newOid = (gridId, level, side) =>
  `g${gridId}-${level}-${side[0]}-${deps.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ---------------------------------------------------------------- order placement

/** Send one pending row to KuCoin. Safe to call repeatedly (idempotent via clientOid). */
async function submit(row, symbol) {
  try {
    if (row.attempts > 0) {
      // an earlier attempt may have been accepted although we never saw the answer
      const existing = await deps.kc.getActiveByClientOid(row.clientOid);
      if (existing) {
        await deps.repo.updateLiveOrder(row.id, { orderId: existing.id, status: 'open' });
        row.orderId = existing.id; row.status = 'open';
        return true;
      }
    }
    const orderId = await deps.kc.placeLimit({
      clientOid: row.clientOid, symbol, side: row.side, price: row.price, size: row.size,
    });
    await deps.repo.updateLiveOrder(row.id, { orderId, status: 'open' });
    row.orderId = orderId; row.status = 'open';
    return true;
  } catch (e) {
    const attempts = (row.attempts || 0) + 1;
    row.attempts = attempts;
    const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    row.status = status;
    await deps.repo.updateLiveOrder(row.id, { attempts, status });
    console.warn(`live: ${row.side} L${row.level} ${symbol} failed (${attempts}/${MAX_ATTEMPTS}):`, e.message);
    row.lastError = e.message;
    return false;
  }
}

async function inBatches(items, fn) {
  for (let i = 0; i < items.length; i += PLACE_BATCH) {
    await Promise.all(items.slice(i, i + PLACE_BATCH).map(fn));
  }
}

// ---------------------------------------------------------------- core sync (grid lock must be held)

function ledgerOf(g) {
  return {
    cash: g.cash, position: g.position, costBasis: g.costBasis, realized: g.realized,
    tradeCount: g.tradeCount, held: new Set(g.heldLevels),
  };
}

async function syncLocked(g, { arm = true, submitNew = true, deadline }) {
  const rules = await getRules(g.symbol);
  const L = ledgerOf(g);
  const trades = [];
  const events = [];
  const now = deps.now();
  const perGrid = g.deposit / g.gridCount;
  const levels = gridLevels(g);

  let failure = null;
  let lastPrice = g.lastPrice;
  let placedBuys = 0;
  let skipped = 0;
  try {
  // 1) retry unconfirmed orders, settle finished ones
  const open = await deps.repo.getLiveOrdersOpen(g.id);
  await inBatches(open, async (row) => {
    if (deps.now() > deadline) return;
    if (!row.orderId) {
      if (submitNew) await submit(row, g.symbol);
      return;
    }
    let o;
    try { o = await deps.kc.getOrder(row.orderId); } catch (e) {
      console.warn('live: getOrder failed', row.orderId, e.message);
      return;
    }
    if (o.isActive) {
      if (o.dealSize > row.dealSize) await deps.repo.updateLiveOrder(row.id, { dealSize: o.dealSize, dealFunds: o.dealFunds });
      return;
    }
    if (o.dealSize <= 0) {                       // cancelled with no fills
      await deps.repo.updateLiveOrder(row.id, { status: 'canceled' });
      return;
    }
    const feeUsdt = o.feeCurrency === 'USDT' ? o.fee : (o.fee * (o.dealFunds / o.dealSize));
    await deps.repo.updateLiveOrder(row.id, {
      status: 'filled', dealSize: o.dealSize, dealFunds: o.dealFunds, fee: feeUsdt,
    });
    const avg = o.dealFunds / o.dealSize;

    if (row.side === 'buy') {
      const baseFee = o.feeCurrency && o.feeCurrency !== 'USDT' ? o.fee : 0;   // fee taken in the coin itself
      const netSize = o.dealSize - baseFee;
      L.cash -= o.dealFunds + (o.feeCurrency === 'USDT' ? o.fee : 0);
      L.position += netSize;
      L.costBasis += o.dealFunds;
      L.held.add(row.level);
      L.tradeCount++;
      trades.push({ level: row.level, side: 'buy', price: avg, qty: netSize, t: now });
      events.push(`🟢 خرید واقعی ${g.symbol}: ${fmtPrice(netSize)} در ${fmtPrice(avg)} (سطح ${row.level + 1})`);
      await placeSell(g, rules, levels, row.level, {
        buyFunds: o.dealFunds, buySize: netSize, buyFee: feeUsdt, submitNew, events,
      });
    } else {
      const frac = row.size > 0 ? Math.min(1, o.dealSize / row.size) : 1;
      L.cash += o.dealFunds - feeUsdt;
      L.position -= row.buySize * frac;
      L.costBasis -= row.buyFunds * frac;
      const profit = o.dealFunds - feeUsdt - (row.buyFunds + row.buyFee) * frac;
      L.realized += profit;
      L.held.delete(row.level);
      L.tradeCount++;
      trades.push({ level: row.level, side: 'sell', price: avg, qty: o.dealSize, t: now });
      events.push(`🔴 فروش واقعی ${g.symbol}: ${fmtPrice(o.dealSize)} در ${fmtPrice(avg)} | سود: ${profit >= 0 ? '+' : ''}${fmtPrice(profit)} USDT`);
    }
  });

  // 2) held levels that lost their sell order (grid was stopped/resumed, crash, …) get it back
  let openNow = await deps.repo.getLiveOrdersOpen(g.id);
  let covered = new Set(openNow.map((r) => r.level));
  if (submitNew) {
    for (const lvl of [...L.held]) {
      if (covered.has(lvl) || deps.now() > deadline) continue;
      const last = await deps.repo.lastRowAtLevel(g.id, lvl);
      if (!last) continue;
      if (last.side === 'sell' && last.status === 'canceled') {
        await placeSell(g, rules, levels, lvl, { buyFunds: last.buyFunds, buySize: last.buySize, buyFee: last.buyFee, submitNew, events });
      } else if (last.side === 'buy' && last.status === 'filled') {
        await placeSell(g, rules, levels, lvl, { buyFunds: last.dealFunds, buySize: last.dealSize, buyFee: last.fee, submitNew, events });
      }
    }
  }

  // 3) arm every empty level that is below the market with a resting buy
  if (arm) {
    lastPrice = (await deps.kc.ticker(g.symbol)).price;
    openNow = await deps.repo.getLiveOrdersOpen(g.id);
    covered = new Set(openNow.map((r) => r.level));
    const fresh = [];
    for (let i = 0; i < levels.length; i++) {
      if (L.held.has(i) || covered.has(i)) continue;
      if (levels[i] > lastPrice * (1 - BUY_MARGIN)) continue;
      const price = roundTo(levels[i], rules.priceInc);
      const size = floorTo(perGrid / price, rules.baseInc);
      if (size < rules.baseMin || size * price < rules.minFunds) { skipped++; continue; }
      const row = await deps.repo.insertLiveOrder({
        gridId: g.id, level: i, side: 'buy', clientOid: newOid(g.id, i, 'buy'), price, size,
      });
      fresh.push(row);
    }
    if (submitNew) {
      await inBatches(fresh, async (row) => {
        if (deps.now() > deadline) return;
        if (await submit(row, g.symbol)) placedBuys++;
      });
    }
  }

  } catch (e) {
    failure = e;   // still persist what already happened on the exchange, then rethrow
  }

  // 4) persist the ledger
  const patch = {
    lastSync: now, lastPrice,
    cash: L.cash, position: Math.abs(L.position) < 1e-12 ? 0 : L.position,
    costBasis: Math.abs(L.costBasis) < 1e-9 ? 0 : L.costBasis,
    realized: L.realized, tradeCount: L.tradeCount,
    heldLevels: [...L.held].sort((a, b) => a - b),
  };
  await deps.repo.setGridState(g.id, patch);
  if (trades.length) {
    await deps.repo.insertTrades(trades.map((t) => ({ gridId: g.id, userId: g.userId, ...t })));
  }
  for (const text of events) await deps.notify(g.userId, text);
  if (failure) throw failure;
  return { grid: { ...g, ...patch, source: 'KuCoin' }, placedBuys, skipped };
}

/** Insert (and optionally send) the sell that closes a filled buy. */
async function placeSell(g, rules, levels, level, { buyFunds, buySize, buyFee, submitNew, events }) {
  const buyPrice = roundTo(levels[level], rules.priceInc);
  let price = roundTo(sellTarget(g, levels, level), rules.priceInc);
  if (price <= buyPrice) price = +(buyPrice + rules.priceInc).toFixed(decimals(rules.priceInc));
  const size = floorTo(buySize, rules.baseInc);
  const row = await deps.repo.insertLiveOrder({
    gridId: g.id, level, side: 'sell', clientOid: newOid(g.id, level, 'sell'),
    price, size, buyFunds, buySize, buyFee,
  });
  if (size < rules.baseMin) {
    await deps.repo.updateLiveOrder(row.id, { status: 'failed' });
    events.push(`⚠️ مقدار فروش سطح ${level + 1} از حداقل KuCoin کمتر است؛ دستی بفروش.`);
    return;
  }
  if (submitNew) {
    const ok = await submit(row, g.symbol);
    if (!ok && row.status === 'failed') events.push(`⚠️ ثبت سفارش فروش سطح ${level + 1} ناموفق بود: ${row.lastError || ''}`);
  }
}

// ---------------------------------------------------------------- public API

async function withLock(grid, fn) {
  if (!(await deps.repo.tryLockGrid(grid.id, deps.now()))) return null;
  try {
    const fresh = (await deps.repo.getGrid(grid.userId, grid.id)) || grid;
    return await fn(fresh);
  } finally {
    await deps.repo.unlockGrid(grid.id);
  }
}

/** Sync one live grid with the exchange (called by sim.syncGrid → cron, webhook, UI). */
export async function liveSync(userId, grid) {
  const r = await withLock(grid, (g) => syncLocked(g, { deadline: deps.now() + 40000 }));
  return r ? r.grid : { ...grid, source: 'KuCoin' };
}

/**
 * Create a REAL grid: validates exchange rules + balance, stores the grid, places the first buys.
 * d: { symbol, deposit, lowerPrice, gridCount, intervalPct }
 */
export async function createLiveGrid(user, d) {
  if (!canTrade(user.tgId)) throw new Error('معامله واقعی فقط برای مالک ربات فعال است');
  const rules = await getRules(d.symbol);
  const { price } = await deps.kc.ticker(d.symbol);
  const perGrid = d.deposit / d.gridCount;
  const levels = gridLevels(d);

  const minNeeded = levels.reduce((m, p) => {
    const q = roundTo(p, rules.priceInc);
    const size = floorTo(perGrid / q, rules.baseInc);
    return size < rules.baseMin || size * q < rules.minFunds ? Math.max(m, Math.max(rules.minFunds, rules.baseMin * q)) : m;
  }, 0);
  if (minNeeded > 0) {
    throw new Error(`سرمایه هر گرید (${fmtPrice(perGrid)} USDT) از حداقل سفارش KuCoin برای ${d.symbol} کمتر است (حدود ${fmtPrice(minNeeded)} USDT لازم است). سرمایه را بیشتر یا تعداد گرید را کمتر کن.`);
  }

  const free = await deps.kc.usdtAvailable();
  if (free + 1e-9 < d.deposit) {
    throw new Error(`موجودی USDT در حساب Trading کوکوین (${fmtPrice(free)}) از سرمایه گرید (${fmtPrice(d.deposit)}) کمتر است.`);
  }

  const now = deps.now();
  const grid = await deps.repo.insertGrid({
    userId: user.tgId, symbol: d.symbol, deposit: d.deposit, lowerPrice: d.lowerPrice,
    gridCount: d.gridCount, intervalPct: d.intervalPct, active: true,
    lastSync: now, lastPrice: price, cash: d.deposit, position: 0, costBasis: 0,
    realized: 0, tradeCount: 0, heldLevels: [], created: now, live: true,
  });

  const r = await withLock(grid, (g) => syncLocked(g, { deadline: deps.now() + 40000 }));
  const g = r ? r.grid : grid;
  const placed = r ? r.placedBuys : 0;
  const above = d.gridCount - placed;
  const text =
    `🔴 گرید واقعی روی KuCoin ساخته شد!\n\n` +
    `🪙 توکن: ${g.symbol}\n` +
    `💵 سرمایه: ${fmtPrice(g.deposit)} USDT (${fmtPrice(perGrid)} در هر گرید)\n` +
    `📉 قیمت پایین: ${fmtPrice(g.lowerPrice)} | 🎯 سقف: ${fmtPrice(levels[levels.length - 1] * (1 + g.intervalPct / 100))}\n` +
    `🧵 تعداد گرید: ${g.gridCount} | 📏 فاصله: ${g.intervalPct}%\n` +
    `💹 قیمت فعلی: ${fmtPrice(g.lastPrice)} (KuCoin)\n\n` +
    `📌 ${placed} سفارش خرید واقعی ثبت شد.` +
    (above > 0 ? `\n⏳ ${above} سطح بالاتر از قیمت است و وقتی قیمت بالاتر برود/همگام‌سازی بعدی انجام شود، سفارششان گذاشته می‌شود.` : '') +
    (r && r.skipped ? `\n⚠️ ${r.skipped} سطح به‌خاطر حداقل سفارش KuCoin رد شد.` : '') +
    `\n\n⚠️ سفارش‌ها روی خود صرافی می‌مانند؛ برای ثبت فروشِ بعد از هر خرید، ربات باید همگام شود (کران/باز کردن لیست گریدها).`;
  return { grid: g, confirmText: text };
}

/**
 * Stop trading a grid: settle fills, cancel all resting orders. Coins already bought stay in your
 * account (their level remains "held"; resuming the grid re-creates the sell orders).
 * @returns {Promise<{cancelled:number}|null>} null when another sync holds the lock (retry in a moment)
 */
export async function cancelGridOrders(grid) {
  return withLock(grid, async (g) => {
    const deadline = deps.now() + 45000;
    await syncLocked(g, { arm: false, submitNew: false, deadline });         // book fills first
    const open = (await deps.repo.getLiveOrdersOpen(g.id)).filter((r) => r.orderId);
    let cancelled = 0;
    await inBatches(open, async (row) => {
      try { await deps.kc.cancelOrder(row.orderId); cancelled++; } catch (e) {
        console.warn('live: cancel failed (maybe already filled)', row.orderId, e.message);
      }
    });
    const g2 = (await deps.repo.getGrid(g.userId, g.id)) || g;
    await syncLocked(g2, { arm: false, submitNew: false, deadline });        // book cancels / late fills
    return { cancelled };
  });
}

/** Cancel + remove a live grid completely. @returns {Promise<boolean>} false when busy. */
export async function deleteLiveGrid(grid) {
  const r = await cancelGridOrders(grid);
  if (!r) return false;
  await deps.repo.deleteLiveOrdersOfGrid(grid.id);
  return true;
}

/** Kill switch: stop every live grid of the user and cancel all their resting orders. */
export async function panicStop(userId) {
  const grids = await deps.repo.getLiveGridsOfUser(userId);
  let cancelled = 0, busy = 0;
  for (const g of grids) {
    await deps.repo.setGridState(g.id, { active: false });
    const r = await cancelGridOrders(g);
    if (r) cancelled += r.cancelled; else busy++;
  }
  return { grids: grids.length, cancelled, busy };
}
