// lib/prices.js — kline history + current price from public spot APIs.
// Providers are tried in order: Binance -> Bybit -> OKX (USDT pairs, no API keys).
// Uses the runtime's global fetch (Node 18+ on Vercel).

import { atr14 } from './pos.js';

// ~25 pages * 1000 candles ≈ 17 days of 1m history per fetch window.
// If a grid has been idle longer than that, it simply resumes across a few
// consecutive syncs (self-healing).
const MAX_PAGES = 25;

async function binanceKlines(symbol, windowStart) {
  const out = [];
  let st = Math.max(windowStart - 60000, 0); // one extra candle before the window (prevClose)
  const now = Date.now();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1m&startTime=${st}&limit=1000`,
    );
    if (!res.ok) throw new Error('http ' + res.status);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('no klines');
    for (const r of rows) out.push({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
    const lastT = out[out.length - 1].t;
    if (rows.length < 1000 || lastT + 60000 >= now) break;
    st = lastT + 60000;
  }
  return out;
}

async function bybitKlines(symbol, windowStart) {
  const out = [];
  let cursor = Math.max(windowStart - 60000, 0);
  const now = Date.now();
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}USDT&interval=1&start=${cursor}&limit=1000`,
    );
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    if (j.retCode !== 0) throw new Error(j.retMsg || 'retCode ' + j.retCode);
    const list = j.result && j.result.list ? j.result.list : [];
    if (list.length === 0) throw new Error('no klines');
    for (const r of list) out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
    const next = j.result && j.result.nextCursor ? +j.result.nextCursor : 0;
    if (!next || next <= cursor || next >= now + 60000) break;
    cursor = next;
  }
  out.reverse(); // Bybit returns newest-first -> ascending
  return out;
}

async function okxKlines(symbol, windowStart) {
  const out = [];
  let after = '';
  const now = Date.now();
  for (let page = 0; page < 30; page++) {
    const url =
      `https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=1m&limit=300` +
      (after ? `&after=${after}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const j = await res.json();
    if (j.code !== '0') throw new Error(j.msg || 'code ' + j.code);
    const list = j.data || [];
    if (list.length === 0) break;
    for (const r of list) out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] });
    const oldest = +list[list.length - 1][0];
    if (oldest < windowStart || oldest >= now) break;
    after = String(oldest);
  }
  out.reverse(); // OKX returns newest-first -> ascending
  return out;
}

const PROVIDERS = [
  { name: 'Binance', klines: binanceKlines },
  { name: 'Bybit', klines: bybitKlines },
  { name: 'OKX', klines: okxKlines },
];

/**
 * Fetch 1m candles covering [since, now] for a USDT pair, plus the close of the
 * candle right before the window (prevClose) and the latest price.
 *
 * @returns {Promise<{klines: Array, prevClose: number|null, lastPrice: number, source: string}>}
 * @throws Error when no provider has the symbol (message lists per-provider errors).
 */
export async function getSeries(symbol, since) {
  const start = Math.min(since, Date.now());
  const errors = [];
  for (const ex of PROVIDERS) {
    try {
      const all = await ex.klines(symbol, start);
      if (!all || all.length === 0) throw new Error('no klines');
      all.sort((a, b) => a.t - b.t);
      const klines = all.filter((k) => k.t >= start);
      // last candle strictly before the window start
      let prevClose = null;
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].t < start) { prevClose = all[i].c; break; }
      }
      const last = klines[klines.length - 1];
      return {
        klines,
        prevClose: prevClose != null ? prevClose : (klines.length ? klines[0].o : null),
        lastPrice: last ? last.c : prevClose,
        source: ex.name,
      };
    } catch (e) {
      errors.push(`${ex.name}: ${e.message}`);
    }
  }
  throw new Error(`no_price(${symbol}) — ${errors.join(' | ')}`);
}

// Latest price for a symbol (used for token lists & fresh display).
export async function getTicker(symbol) {
  const series = await getSeries(symbol, Date.now() - 2 * 60000);
  return { price: series.lastPrice, source: series.source };
}

// ---------------- recent klines for other intervals (ATR / TP-SL) ----------------

async function binanceKlinesRecent(symbol, interval, limit) {
  const res = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${limit}`,
  );
  if (!res.ok) throw new Error('http ' + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('no klines');
  return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
}

const BYBIT_INTERVAL = { '15m': '15', '1h': '60', '4h': '240', '1d': 'D' };
async function bybitKlinesRecent(symbol, interval, limit) {
  const res = await fetch(
    `https://api.bybit.com/v5/market/kline?category=spot&symbol=${symbol}USDT&interval=${BYBIT_INTERVAL[interval] || interval}&limit=${limit}`,
  );
  if (!res.ok) throw new Error('http ' + res.status);
  const j = await res.json();
  if (j.retCode !== 0) throw new Error(j.retMsg || 'retCode ' + j.retCode);
  const list = (j.result && j.result.list) || [];
  if (!list.length) throw new Error('no klines');
  return list.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).reverse();
}

const OKX_INTERVAL = { '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
async function okxKlinesRecent(symbol, interval, limit) {
  const res = await fetch(
    `https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=${OKX_INTERVAL[interval] || interval}&limit=${limit}`,
  );
  if (!res.ok) throw new Error('http ' + res.status);
  const j = await res.json();
  if (j.code !== '0') throw new Error(j.msg || 'code ' + j.code);
  if (!j.data || !j.data.length) throw new Error('no klines');
  return j.data.map((r) => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })).reverse();
}

const RECENT_PROVIDERS = [
  { name: 'Binance', klines: binanceKlinesRecent },
  { name: 'Bybit', klines: bybitKlinesRecent },
  { name: 'OKX', klines: okxKlinesRecent },
];

/**
 * Fetch the last `limit` candles of `interval` (e.g. '1h', 50) for a USDT pair.
 * @returns {Promise<{klines: Array, source: string}>}
 */
export async function getKlinesRecent(symbol, interval, limit) {
  const errors = [];
  for (const ex of RECENT_PROVIDERS) {
    try {
      const k = await ex.klines(symbol, interval, limit);
      if (!k.length) throw new Error('no klines');
      k.sort((a, b) => a.t - b.t);
      return { klines: k, source: ex.name };
    } catch (e) {
      errors.push(`${ex.name}: ${e.message}`);
    }
  }
  throw new Error(`no_klines(${symbol}) — ${errors.join(' | ')}`);
}

// ATR(14) over 1h candles — used by the bot to place TP/SL on new positions.
export async function getAtr(symbol, interval = '1h', limit = 50, period = 14) {
  const { klines, source } = await getKlinesRecent(symbol, interval, limit);
  const atr = atr14(klines, period);
  if (atr == null) throw new Error('atr_unavailable');
  return { atr, source };
}
