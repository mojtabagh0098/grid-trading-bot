-- schema.sql — Postgres schema for the Grid Trading Simulator bot.
-- Apply once (idempotent): Vercel dashboard -> Postgres -> SQL editor, or: scripts/init-db.sh

CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  tg_id      BIGINT UNIQUE NOT NULL,
  pending    JSONB,
  live       BOOLEAN NOT NULL DEFAULT FALSE,   -- owner only: new grids trade for REAL on KuCoin
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id         SERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  symbol     TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens (user_id);

CREATE TABLE IF NOT EXISTS grids (
  id           SERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  symbol       TEXT NOT NULL,
  deposit      DOUBLE PRECISION NOT NULL,
  lower_price  DOUBLE PRECISION NOT NULL,
  grid_count   INT NOT NULL,
  interval_pct DOUBLE PRECISION NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- simulation state
  last_sync    BIGINT NOT NULL DEFAULT 0,
  last_price   DOUBLE PRECISION NOT NULL DEFAULT 0,
  cash         DOUBLE PRECISION NOT NULL DEFAULT 0,
  position     DOUBLE PRECISION NOT NULL DEFAULT 0,
  cost_basis   DOUBLE PRECISION NOT NULL DEFAULT 0,
  realized     DOUBLE PRECISION NOT NULL DEFAULT 0,
  trade_count  INT NOT NULL DEFAULT 0,
  held_levels  JSONB NOT NULL DEFAULT '[]',
  live         BOOLEAN NOT NULL DEFAULT FALSE, -- real orders on KuCoin (limit orders per level)
  live_lock    BIGINT NOT NULL DEFAULT 0,      -- ms timestamp; serialises concurrent syncs of one grid
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_grids_user ON grids (user_id);
CREATE INDEX IF NOT EXISTS idx_grids_active ON grids (user_id, active);

CREATE TABLE IF NOT EXISTS trades (
  id      SERIAL PRIMARY KEY,
  grid_id INT NOT NULL,
  user_id BIGINT NOT NULL,
  level   INT NOT NULL,
  side    TEXT NOT NULL,
  price   DOUBLE PRECISION NOT NULL,
  qty     DOUBLE PRECISION NOT NULL,
  t       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_grid ON trades (grid_id);

-- Leveraged positions (simulated long/short with bot-computed TP/SL)
CREATE TABLE IF NOT EXISTS positions (
  id           SERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  symbol       TEXT NOT NULL,
  side         TEXT NOT NULL CHECK (side IN ('long', 'short')),
  entry_price  DOUBLE PRECISION NOT NULL,
  amount_usdt  DOUBLE PRECISION NOT NULL,     -- margin committed
  leverage     INT NOT NULL,
  take_profit  DOUBLE PRECISION NOT NULL,     -- set by the bot (ATR-based)
  stop_loss    DOUBLE PRECISION NOT NULL,     -- set by the bot (ATR-based)
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  last_price   DOUBLE PRECISION NOT NULL DEFAULT 0,
  close_price  DOUBLE PRECISION,
  close_time   BIGINT,
  close_reason TEXT,                          -- 'tp' | 'sl' | 'liq' | 'manual'
  pnl          DOUBLE PRECISION,
  roi_pct      DOUBLE PRECISION,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pos_user ON positions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_pos_status ON positions (status);

-- Real KuCoin limit orders placed by live grids (one open order per grid level at a time)
CREATE TABLE IF NOT EXISTS live_orders (
  id         SERIAL PRIMARY KEY,
  grid_id    INT NOT NULL,
  level      INT NOT NULL,
  side       TEXT NOT NULL,                       -- 'buy' | 'sell'
  client_oid TEXT UNIQUE NOT NULL,                -- deterministic -> idempotent placement
  order_id   TEXT,                                -- KuCoin order id (NULL until accepted)
  price      DOUBLE PRECISION NOT NULL,
  size       DOUBLE PRECISION NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',     -- pending | open | filled | canceled | failed
  buy_funds  DOUBLE PRECISION NOT NULL DEFAULT 0, -- sell rows: USDT cost of the buy being closed
  buy_size   DOUBLE PRECISION NOT NULL DEFAULT 0,
  buy_fee    DOUBLE PRECISION NOT NULL DEFAULT 0,
  deal_size  DOUBLE PRECISION NOT NULL DEFAULT 0,
  deal_funds DOUBLE PRECISION NOT NULL DEFAULT 0,
  fee        DOUBLE PRECISION NOT NULL DEFAULT 0,
  attempts   INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_orders_grid ON live_orders (grid_id, status);
