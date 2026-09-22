const PRIMARY_URL = 'https://api.binance.com/api/v3/ticker/price';
const FALLBACK_URL = 'https://data-api.binance.vision/api/v3/ticker/price';
const SYMBOL_PATTERN = /^[A-Z0-9]{2,20}$/;

export function normalizeSymbol(raw) {
  const value = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\//g, '');
  const symbol = value.endsWith('USDT') ? value.slice(0, -4) : value;
  if (!SYMBOL_PATTERN.test(symbol)) {
    throw new Error('نماد باید فقط از حروف/اعداد تشکیل شود؛ نمونه: BTC یا PEPE.');
  }
  return symbol;
}

export function pairFor(symbol) {
  return `${normalizeSymbol(symbol)}USDT`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.msg || `Market API returned ${response.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function requestTicker(url, pairs) {
  const params = new URLSearchParams();
  if (pairs.length === 1) params.set('symbol', pairs[0]);
  else params.set('symbols', JSON.stringify(pairs));
  const payload = await fetchJson(`${url}?${params.toString()}`);
  const rows = Array.isArray(payload) ? payload : [payload];
  const result = new Map();
  for (const row of rows) {
    const price = Number(row.price);
    if (row?.symbol && Number.isFinite(price) && price > 0) {
      result.set(row.symbol, price);
    }
  }
  return result;
}

/**
 * Fetches public Binance spot tickers. The Binance Vision endpoint is a fallback
 * for deployments where api.binance.com is temporarily unavailable.
 */
export async function getPrices(symbols) {
  const pairs = [...new Set(symbols.map(pairFor))];
  if (!pairs.length) return new Map();

  let prices;
  try {
    prices = await requestTicker(PRIMARY_URL, pairs);
  } catch (primaryError) {
    try {
      prices = await requestTicker(FALLBACK_URL, pairs);
    } catch (fallbackError) {
      throw new Error(`دریافت قیمت از Binance ناموفق بود: ${fallbackError.message || primaryError.message}`);
    }
  }

  const missing = pairs.filter((pair) => !prices.has(pair));
  if (missing.length) throw new Error(`این جفت در بازار Binance USDT پیدا نشد: ${missing.join(', ')}`);
  return prices;
}

export async function validateTokenOnBinance(symbol) {
  const normalized = normalizeSymbol(symbol);
  const prices = await getPrices([normalized]);
  return { symbol: normalized, pair: pairFor(normalized), price: prices.get(pairFor(normalized)) };
}
