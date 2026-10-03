// lib/kucoin.js — minimal KuCoin SPOT REST client (public + signed private endpoints).
//
// Auth (API key version 2): every private request carries
//   KC-API-KEY, KC-API-TIMESTAMP (ms), KC-API-SIGN = base64(HMAC_SHA256(secret, ts+METHOD+path+body)),
//   KC-API-PASSPHRASE = base64(HMAC_SHA256(secret, passphrase)), KC-API-KEY-VERSION = 2
// `path` includes the query string. Responses are { code: "200000", data }.
//
// Env: KUCOIN_API_KEY, KUCOIN_API_SECRET, KUCOIN_API_PASSPHRASE
//      KUCOIN_BASE_URL (optional; default https://api.kucoin.com — sandbox: https://openapi-sandbox.kucoin.com)

import { createHmac } from 'node:crypto';

export class KucoinError extends Error {
  constructor(code, msg, path) {
    super(`KuCoin ${code}: ${msg} (${path})`);
    this.name = 'KucoinError';
    this.code = String(code);
    this.path = path;
  }
}

const baseUrl = () => (process.env.KUCOIN_BASE_URL || 'https://api.kucoin.com').replace(/\/+$/, '');

export function hasCredentials() {
  return !!(process.env.KUCOIN_API_KEY && process.env.KUCOIN_API_SECRET && process.env.KUCOIN_API_PASSPHRASE);
}

const hmac64 = (secret, msg) => createHmac('sha256', secret).update(msg).digest('base64');

/** Build the signed header set (exported for tests). */
export function signHeaders(method, path, body = '', ts = Date.now()) {
  const key = process.env.KUCOIN_API_KEY;
  const secret = process.env.KUCOIN_API_SECRET;
  const pass = process.env.KUCOIN_API_PASSPHRASE;
  if (!key || !secret || !pass) throw new Error('KuCoin API credentials are not set');
  return {
    'KC-API-KEY': key,
    'KC-API-SIGN': hmac64(secret, `${ts}${method.toUpperCase()}${path}${body}`),
    'KC-API-TIMESTAMP': String(ts),
    'KC-API-PASSPHRASE': hmac64(secret, pass),
    'KC-API-KEY-VERSION': '2',
    'Content-Type': 'application/json',
  };
}

async function request(method, path, { body, auth = true } = {}) {
  const json = body ? JSON.stringify(body) : '';
  const headers = auth ? signHeaders(method, path, json) : { 'Content-Type': 'application/json' };
  const res = await fetch(baseUrl() + path, { method, headers, body: json || undefined });
  const j = await res.json().catch(() => null);
  if (!j || j.code !== '200000') {
    throw new KucoinError((j && j.code) || res.status, (j && j.msg) || `HTTP ${res.status}`, path);
  }
  return j.data;
}

const pair = (symbol) => `${symbol}-USDT`;

// ---------- public ----------

/** Trading rules: priceIncrement, baseIncrement, baseMinSize, minFunds, enableTrading … */
export async function symbolInfo(symbol) {
  const rows = await request('GET', `/api/v2/symbols/${pair(symbol)}`, { auth: false });
  return rows;
}

export async function ticker(symbol) {
  const d = await request('GET', `/api/v1/market/orderbook/level1?symbol=${pair(symbol)}`, { auth: false });
  const price = +d.price;
  if (!(price > 0)) throw new Error('no price');
  return { price, bestBid: +d.bestBid, bestAsk: +d.bestAsk };
}

// ---------- private ----------

/** Available USDT in the TRADE account. */
export async function usdtAvailable() {
  const rows = await request('GET', '/api/v1/accounts?currency=USDT&type=trade');
  return (rows || []).reduce((s, a) => s + (+a.available || 0), 0);
}

/** Place a GTC limit order. clientOid makes the call idempotent. @returns {Promise<string>} orderId */
export async function placeLimit({ clientOid, symbol, side, price, size }) {
  const d = await request('POST', '/api/v1/orders', {
    body: { clientOid, symbol: pair(symbol), side, type: 'limit', price: String(price), size: String(size), timeInForce: 'GTC' },
  });
  return d.orderId;
}

/** Single order (works for active and finished orders). */
export async function getOrder(orderId) {
  const d = await request('GET', `/api/v1/orders/${orderId}`);
  return {
    id: d.id, isActive: !!d.isActive, cancelExist: !!d.cancelExist,
    dealSize: +d.dealSize || 0, dealFunds: +d.dealFunds || 0,
    fee: +d.fee || 0, feeCurrency: d.feeCurrency || '',
  };
}

/** Look up an ACTIVE order by clientOid; null when it does not exist (yet). */
export async function getActiveByClientOid(clientOid) {
  try {
    const d = await request('GET', `/api/v1/order/client-order/${clientOid}`);
    return d && d.id ? { id: d.id, isActive: !!d.isActive } : null;
  } catch (e) {
    if (e instanceof KucoinError) return null; // "order not exist"
    throw e;
  }
}

export async function cancelOrder(orderId) {
  return request('DELETE', `/api/v1/orders/${orderId}`);
}
