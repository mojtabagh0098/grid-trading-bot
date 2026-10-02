-- schema.sql — Postgres schema for the Grid Trading Simulator bot.
-- Apply once (idempotent): Vercel dashboard -> Postgres -> SQL editor, or: scripts/init-db.sh

CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  tg_id      BIGINT UNIQUE NOT NULL,
  pending    JSONB,
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
