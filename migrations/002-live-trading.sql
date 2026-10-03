-- Run ONCE on an existing database (Vercel/Neon SQL editor) before deploying live trading.
-- New installs get all of this from schema.sql.

ALTER TABLE users ADD COLUMN IF NOT EXISTS live BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE grids ADD COLUMN IF NOT EXISTS live BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE grids ADD COLUMN IF NOT EXISTS live_lock BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS live_orders (
  id         SERIAL PRIMARY KEY,
  grid_id    INT NOT NULL,
  level      INT NOT NULL,
  side       TEXT NOT NULL,
  client_oid TEXT UNIQUE NOT NULL,
  order_id   TEXT,
  price      DOUBLE PRECISION NOT NULL,
  size       DOUBLE PRECISION NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',
  buy_funds  DOUBLE PRECISION NOT NULL DEFAULT 0,
  buy_size   DOUBLE PRECISION NOT NULL DEFAULT 0,
  buy_fee    DOUBLE PRECISION NOT NULL DEFAULT 0,
  deal_size  DOUBLE PRECISION NOT NULL DEFAULT 0,
  deal_funds DOUBLE PRECISION NOT NULL DEFAULT 0,
  fee        DOUBLE PRECISION NOT NULL DEFAULT 0,
  attempts   INT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_orders_grid ON live_orders (grid_id, status);
