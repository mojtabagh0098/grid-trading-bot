import { randomUUID } from 'node:crypto';
import { normalizeSymbol, pairFor } from './market.js';

const NS = 'infinity-grid:v1';
const keys = {
  tokens: () => `${NS}:tokens`,
  token: (symbol) => `${NS}:token:${symbol}`,
  grids: () => `${NS}:grids`,
  grid: (id) => `${NS}:grid:${id}`,
  session: (chatId) => `${NS}:session:${chatId}`
};

export async function listTokens(redis) {
  const symbols = await redis.command('SMEMBERS', keys.tokens());
  const tokens = (await Promise.all((symbols || []).map((symbol) => redis.getJson(keys.token(symbol))))).filter(Boolean);
  return tokens.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function getToken(redis, rawSymbol) {
  return redis.getJson(keys.token(normalizeSymbol(rawSymbol)));
}

export async function saveToken(redis, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  const old = await getToken(redis, symbol);
  const now = new Date().toISOString();
  const token = {
    symbol,
    pair: pairFor(symbol),
    createdAt: old?.createdAt || now,
    updatedAt: now
  };
  await Promise.all([
    redis.command('SADD', keys.tokens(), symbol),
    redis.setJson(keys.token(symbol), token)
  ]);
  return token;
}

export async function hasGridsForToken(redis, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  const grids = await listGrids(redis);
  return grids.some((grid) => grid.symbol === symbol);
}

export async function renameToken(redis, oldRawSymbol, newRawSymbol) {
  const oldSymbol = normalizeSymbol(oldRawSymbol);
  const newSymbol = normalizeSymbol(newRawSymbol);
  if (oldSymbol === newSymbol) return getToken(redis, oldSymbol);
  if (!(await getToken(redis, oldSymbol))) throw new Error('توکن موردنظر پیدا نشد.');
  if (await getToken(redis, newSymbol)) throw new Error('این توکن از قبل در فهرست ثبت شده است.');
  if (await hasGridsForToken(redis, oldSymbol)) {
    throw new Error('برای حفظ سوابق شبیه‌سازی، ابتدا گریدهای این توکن را حذف کنید.');
  }
  const token = { symbol: newSymbol, pair: pairFor(newSymbol), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await Promise.all([
    redis.command('SREM', keys.tokens(), oldSymbol),
    redis.command('SADD', keys.tokens(), newSymbol),
    redis.command('DEL', keys.token(oldSymbol)),
    redis.setJson(keys.token(newSymbol), token)
  ]);
  return token;
}

export async function removeToken(redis, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (await hasGridsForToken(redis, symbol)) {
    throw new Error('این توکن گرید دارد؛ ابتدا گریدهای وابسته را حذف کنید.');
  }
  await Promise.all([
    redis.command('SREM', keys.tokens(), symbol),
    redis.command('DEL', keys.token(symbol))
  ]);
}

export async function listGrids(redis) {
  const ids = await redis.command('SMEMBERS', keys.grids());
  const grids = (await Promise.all((ids || []).map((id) => redis.getJson(keys.grid(id))))).filter(Boolean);
  return grids.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function getGrid(redis, id) {
  return redis.getJson(keys.grid(id));
}

export async function saveGrid(redis, grid) {
  if (!grid?.id) throw new Error('Grid id is required.');
  grid.updatedAt = new Date().toISOString();
  await Promise.all([
    redis.command('SADD', keys.grids(), grid.id),
    redis.setJson(keys.grid(grid.id), grid)
  ]);
  return grid;
}

export async function createGrid(redis, data) {
  const id = randomUUID();
  const grid = { ...data, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await saveGrid(redis, grid);
  return grid;
}

export async function removeGrid(redis, id) {
  await Promise.all([
    redis.command('SREM', keys.grids(), id),
    redis.command('DEL', keys.grid(id))
  ]);
}

export async function getSession(redis, chatId) {
  return redis.getJson(keys.session(chatId));
}

export async function setSession(redis, chatId, session) {
  return redis.setJson(keys.session(chatId), session, 30 * 60);
}

export async function clearSession(redis, chatId) {
  return redis.command('DEL', keys.session(chatId));
}
