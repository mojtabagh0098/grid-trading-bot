// lib/pos.js — pure position math (no I/O): TP/SL, PnL, liquidation, ATR.
// A position = margin (amountUsdt) x leverage -> notional. The bot sets TP/SL
// from ATR(14) of 1h candles with a 2:1 risk:reward (TP = 2*ATR, SL = 1*ATR).

export const TP_RR = 2; // TP distance = TP_RR x ATR, SL distance = 1 x ATR
const ATR_FALLBACK_PCT = 0.03; // when ATR is unavailable: use 3% of entry

/** TP/SL for a side around `entry`, spaced by `atr` (null -> 3% fallback). */
export function computeTpsl(side, entry, atr) {
  const a = atr != null && atr > 0 ? atr : entry * ATR_FALLBACK_PCT;
  return side === 'long'
    ? { takeProfit: entry + TP_RR * a, stopLoss: entry - a }
    : { takeProfit: entry - TP_RR * a, stopLoss: entry + a };
}

export const notional = (p) => p.amountUsdt * p.leverage;

/** Unrealized PnL at `price`. roiPct is relative to the margin (exchange-style ROE). */
export function posPnl(p, price) {
  const chg = p.side === 'long'
    ? (price - p.entryPrice) / p.entryPrice
    : (p.entryPrice - price) / p.entryPrice;
  const pnl = notional(p) * chg;
  return { pnl, roiPct: (pnl / p.amountUsdt) * 100 };
}

/** Approximate liquidation price: ~1/leverage adverse move minus a 0.5% buffer. */
export function liqPrice(p) {
  const d = Math.max((1 / p.leverage) * 0.95, 0.005);
  return p.side === 'long' ? p.entryPrice * (1 - d) : p.entryPrice * (1 + d);
}

/**
 * What happens at `price`? Returns { reason: 'tp'|'sl'|'liq', price } or null.
 * Order matters: liquidation can sit *closer* than a wide SL, so it is checked first.
 */
export function checkClose(p, price) {
  const lp = liqPrice(p);
  if (p.side === 'long') {
    if (price <= lp) return { reason: 'liq', price: lp };
    if (price <= p.stopLoss) return { reason: 'sl', price: p.stopLoss };
    if (price >= p.takeProfit) return { reason: 'tp', price: p.takeProfit };
  } else {
    if (price >= lp) return { reason: 'liq', price: lp };
    if (price >= p.stopLoss) return { reason: 'sl', price: p.stopLoss };
    if (price <= p.takeProfit) return { reason: 'tp', price: p.takeProfit };
  }
  return null;
}

/** PnL booked on close. Liquidation = the whole margin is lost. */
export function closePnl(p, reason, price) {
  if (reason === 'liq') return { pnl: -p.amountUsdt, roiPct: -100 };
  return posPnl(p, price);
}

/**
 * Wilder ATR(period) over ascending klines [{t,o,h,l,c}].
 * Returns null when there is not enough history.
 */
export function atr14(klines, period = 14) {
  if (!Array.isArray(klines) || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const k = klines[i], prev = klines[i - 1];
    trs.push(Math.max(k.h - k.l, Math.abs(k.h - prev.c), Math.abs(k.l - prev.c)));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr > 0 ? atr : null;
}
