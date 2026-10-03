// lib/repo.js — data access layer (Postgres via node-pg).

import { query, one, queryFull } from './db.js';

// ---------- row mappers (snake_case -> camelCase) ----------

const mapUser = (r) => ({ id: r.id, tgId: Number(r.tg_id), pending: r.pending, live: !!r.live, created: r.created_at });

const mapToken = (r) => ({ id: r.id, userId: Number(r.user_id), symbol: r.symbol, created: r.created_at });

const mapGrid = (r) => ({
  id: r.id, userId: Number(r.user_id), symbol: r.symbol,
  deposit: r.deposit, lowerPrice: r.lower_price, gridCount: r.grid_count,
  intervalPct: r.interval_pct, active: r.active,
  lastSync: r.last_sync, lastPrice: r.last_price, cash: r.cash, position: r.position,
  costBasis: r.cost_basis, realized: r.realized, tradeCount: r.trade_count,
  // always an array (defensive: some clients may hand back a raw/empty value)
  heldLevels: Array.isArray(r.held_levels) ? r.held_levels : [],
  live: !!r.live, liveLock: Number(r.live_lock) || 0,
  created: r.created_at,
});

const mapTrade = (r) => ({
  id: r.id, gridId: r.grid_id, userId: Number(r.user_id),
  level: r.level, side: r.side, price: r.price, qty: r.qty, t: r.t,
});

const mapPos = (r) => ({
  id: r.id, userId: Number(r.user_id), symbol: r.symbol, side: r.side,
  entryPrice: r.entry_price, amountUsdt: r.amount_usdt, leverage: r.leverage,
  takeProfit: r.take_profit, stopLoss: r.stop_loss, status: r.status,
  lastPrice: r.last_price, closePrice: r.close_price, closeTime: r.close_time,
  closeReason: r.close_reason, pnl: r.pnl, roiPct: r.roi_pct, created: r.created_at,
});

// ---------- users ----------

export async function getUser(tgId) {
  const r = await one(
    `INSERT INTO users (tg_id, created_at) VALUES ($1, $2)
     ON CONFLICT (tg_id) DO UPDATE SET tg_id = EXCLUDED.tg_id
     RETURNING *`,
    [tgId, Date.now()],
  );
  return mapUser(r);
}

export const setPending = (userId, pending) =>
  query(`UPDATE users SET pending = $1::jsonb WHERE id = $2`, [pending, userId]);

export const setUserLive = (userId, live) =>
  query(`UPDATE users SET live = $1 WHERE id = $2`, [!!live, userId]);

// ---------- tokens ----------

export async function getTokens(userId) {
  const rows = await query(
    `SELECT * FROM tokens WHERE user_id = $1 ORDER BY symbol ASC`, [userId],
  );
  return rows.map(mapToken);
}

export async function getToken(userId, symbol) {
  const r = await one(
    `SELECT * FROM tokens WHERE user_id = $1 AND symbol = $2`, [userId, symbol],
  );
  return r ? mapToken(r) : null;
}

export const addToken = (userId, symbol) =>
  query(`INSERT INTO tokens (user_id, symbol, created_at) VALUES ($1, $2, $3)`, [userId, symbol, Date.now()]);

export const deleteToken = (userId, symbol) =>
  query(`DELETE FROM tokens WHERE user_id = $1 AND symbol = $2`, [userId, symbol]);

export const renameToken = (userId, oldSymbol, newSymbol) =>
  query(`UPDATE tokens SET symbol = $3 WHERE user_id = $1 AND symbol = $2`, [userId, oldSymbol, newSymbol]);

export async function countGridsBySymbol(userId, symbol) {
  const r = await one(`SELECT count(*)::int AS n FROM grids WHERE user_id = $1 AND symbol = $2`, [userId, symbol]);
  return r ? r.n : 0;
}

// ---------- grids ----------

export async function getGrids(userId) {
  const rows = await query(
    `SELECT * FROM grids WHERE user_id = $1 ORDER BY created_at DESC, id DESC`, [userId],
  );
  return rows.map(mapGrid);
}

export async function getGrid(userId, gridId) {
  const r = await one(`SELECT * FROM grids WHERE user_id = $1 AND id = $2`, [userId, gridId]);
  return r ? mapGrid(r) : null;
}

export async function getActiveGrids(userId) {
  const rows = await query(`SELECT * FROM grids WHERE user_id = $1 AND active = TRUE`, [userId]);
  return rows.map(mapGrid);
}

export async function getAllActiveGrids() {
  const rows = await query(`SELECT * FROM grids WHERE active = TRUE ORDER BY id ASC`);
  return rows.map(mapGrid);
}

export async function insertGrid(g) {
  const r = await one(
    `INSERT INTO grids
       (user_id, symbol, deposit, lower_price, grid_count, interval_pct, active,
        last_sync, last_price, cash, position, cost_basis, realized, trade_count, held_levels, created_at, live)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)
     RETURNING *`,
    [
      g.userId, g.symbol, g.deposit, g.lowerPrice, g.gridCount, g.intervalPct, g.active,
      g.lastSync, g.lastPrice, g.cash, g.position, g.costBasis, g.realized, g.tradeCount,
      g.heldLevels, g.created, !!g.live,
    ],
  );
  return mapGrid(r);
}

const GRID_PATCH_COLS = {
  lastSync: 'last_sync', lastPrice: 'last_price', cash: 'cash', position: 'position',
  costBasis: 'cost_basis', realized: 'realized', tradeCount: 'trade_count',
  heldLevels: 'held_levels', active: 'active', liveLock: 'live_lock',
};

export async function setGridState(gridId, patch) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = GRID_PATCH_COLS[key];
    if (!col) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(gridId);
  await query(`UPDATE grids SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

export const deleteGrid = (gridId) => query(`DELETE FROM grids WHERE id = $1`, [gridId]);

export const renameTokenInGrids = (userId, oldSymbol, newSymbol) =>
  query(`UPDATE grids SET symbol = $3 WHERE user_id = $1 AND symbol = $2`, [userId, oldSymbol, newSymbol]);

// ---------- trades ----------

export async function insertTrades(rows) {
  if (!rows.length) return;
  const values = rows.map((_, i) =>
    `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`);
  const params = rows.flatMap((r) => [r.gridId, r.userId, r.level, r.side, r.price, r.qty, r.t]);
  await query(
    `INSERT INTO trades (grid_id, user_id, level, side, price, qty, t) VALUES ${values.join(',')}`,
    params,
  );
}

export const deleteTradesOfGrid = (gridId) => query(`DELETE FROM trades WHERE grid_id = $1`, [gridId]);

export async function recentTrades(gridId, n = 10) {
  const rows = await query(
    `SELECT * FROM trades WHERE grid_id = $1 ORDER BY t DESC, id DESC LIMIT $2`, [gridId, n],
  );
  return rows.map(mapTrade);
}

// ---------- positions ----------

export async function getOpenPositions(userId) {
  const rows = await query(
    `SELECT * FROM positions WHERE user_id = $1 AND status = 'open' ORDER BY id ASC`, [userId],
  );
  return rows.map(mapPos);
}

export async function getAllOpenPositions() {
  const rows = await query(`SELECT * FROM positions WHERE status = 'open' ORDER BY id ASC`);
  return rows.map(mapPos);
}

export async function getRecentClosed(userId, n = 10) {
  const rows = await query(
    `SELECT * FROM positions WHERE user_id = $1 AND status = 'closed'
     ORDER BY close_time DESC, id DESC LIMIT $2`, [userId, n],
  );
  return rows.map(mapPos);
}

export async function getPosition(userId, id) {
  const r = await one(`SELECT * FROM positions WHERE user_id = $1 AND id = $2`, [userId, id]);
  return r ? mapPos(r) : null;
}

export async function countOpenPositions(userId) {
  const r = await one(
    `SELECT count(*)::int AS n FROM positions WHERE user_id = $1 AND status = 'open'`, [userId],
  );
  return r ? r.n : 0;
}

export async function insertPosition(p) {
  const r = await one(
    `INSERT INTO positions
       (user_id, symbol, side, entry_price, amount_usdt, leverage,
        take_profit, stop_loss, status, last_price, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10)
     RETURNING *`,
    [p.userId, p.symbol, p.side, p.entryPrice, p.amountUsdt, p.leverage,
     p.takeProfit, p.stopLoss, p.entryPrice, p.created],
  );
  return mapPos(r);
}

const POS_PATCH_COLS = {
  lastPrice: 'last_price', status: 'status', closePrice: 'close_price',
  closeTime: 'close_time', closeReason: 'close_reason', pnl: 'pnl', roiPct: 'roi_pct',
};

export async function setPositionState(id, patch) {
  const sets = [];
  const params = [];
  for (const [key, value] of Object.entries(patch)) {
    const col = POS_PATCH_COLS[key];
    if (!col) continue;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(id);
  await query(`UPDATE positions SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

/**
 * Conditional close: only wins while the row is still 'open'
 * (safe against webhook/cron running at the same moment). Returns true if it closed.
 */
export async function closePositionRow(id, { closePrice, closeTime, closeReason, pnl, roiPct, lastPrice }) {
  const res = await queryFull(
    `UPDATE positions
        SET status = 'closed', close_price = $1, close_time = $2, close_reason = $3,
            pnl = $4, roi_pct = $5, last_price = $6
      WHERE id = $7 AND status = 'open'`,
    [closePrice, closeTime, closeReason, pnl, roiPct, lastPrice, id],
  );
  return (res.rowCount || 0) > 0;
}

// ---------- live (real KuCoin) grids ----------

/** Try to take the per-grid lock (TTL 90 s). Returns true when acquired. */
export async function tryLockGrid(gridId, now = Date.now()) {
  const r = await one(
    `UPDATE grids SET live_lock = $2 WHERE id = $1 AND live_lock < $3 RETURNING id`,
    [gridId, now, now - 90000],
  );
  return !!r;
}
export const unlockGrid = (gridId) => query(`UPDATE grids SET live_lock = 0 WHERE id = $1`, [gridId]);

export async function getLiveGridsOfUser(userId) {
  const rows = await query(`SELECT * FROM grids WHERE user_id = $1 AND live = TRUE AND active = TRUE`, [userId]);
  return rows.map(mapGrid);
}

const mapLiveOrder = (r) => ({
  id: r.id, gridId: r.grid_id, level: r.level, side: r.side, clientOid: r.client_oid,
  orderId: r.order_id, price: r.price, size: r.size, status: r.status,
  buyFunds: r.buy_funds, buySize: r.buy_size, buyFee: r.buy_fee,
  dealSize: r.deal_size, dealFunds: r.deal_funds, fee: r.fee, attempts: r.attempts, created: r.created_at,
});

export async function insertLiveOrder(o) {
  const r = await one(
    `INSERT INTO live_orders
       (grid_id, level, side, client_oid, price, size, status, buy_funds, buy_size, buy_fee, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$10)
     RETURNING *`,
    [o.gridId, o.level, o.side, o.clientOid, o.price, o.size,
     o.buyFunds || 0, o.buySize || 0, o.buyFee || 0, Date.now()],
  );
  return mapLiveOrder(r);
}

const LIVE_ORDER_COLS = {
  orderId: 'order_id', status: 'status', dealSize: 'deal_size', dealFunds: 'deal_funds',
  fee: 'fee', attempts: 'attempts',
};
export async function updateLiveOrder(id, patch) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = LIVE_ORDER_COLS[k];
    if (!col) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return;
  params.push(id);
  await query(`UPDATE live_orders SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

/** Orders that still need attention (pending = not confirmed yet, open = resting on the exchange). */
export async function getLiveOrdersOpen(gridId) {
  const rows = await query(
    `SELECT * FROM live_orders WHERE grid_id = $1 AND status IN ('pending','open') ORDER BY id ASC`, [gridId],
  );
  return rows.map(mapLiveOrder);
}

export async function countLiveOrdersAtLevel(gridId, level) {
  const r = await one(`SELECT COUNT(*) AS n FROM live_orders WHERE grid_id = $1 AND level = $2`, [gridId, level]);
  return r ? Number(r.n) : 0;
}

/** Most recent order row of a level (any side/status). */
export async function lastRowAtLevel(gridId, level) {
  const r = await one(
    `SELECT * FROM live_orders WHERE grid_id = $1 AND level = $2 ORDER BY id DESC LIMIT 1`, [gridId, level],
  );
  return r ? mapLiveOrder(r) : null;
}

export const deleteLiveOrdersOfGrid = (gridId) => query(`DELETE FROM live_orders WHERE grid_id = $1`, [gridId]);
