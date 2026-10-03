// lib/db.js — Postgres client (Vercel Postgres / Neon or any Postgres via DATABASE_URL).

import pg from 'pg';

let pool = null;
let testPool = null; // set by local integration tests (pg-mem)

export function _setTestPool(p) {
  testPool = p;
}

function getPool() {
  if (testPool) return testPool;
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      // serverless: one function instance handles one request at a time,
      // so a big pool only wastes connections
      max: 2,
      // drop idle connections quickly so a frozen/thawed instance never
      // reuses a connection the server already closed
      idleTimeoutMillis: 5000,
      connectionTimeoutMillis: 10000,
      allowExitOnIdle: true,
      keepAlive: true,
      // Neon/managed Postgres requires SSL
      ssl: { rejectUnauthorized: false },
    });
    // an error on an idle client must not crash the function
    pool.on('error', (err) => console.warn('pg pool idle client error:', err.message));
  }
  return pool;
}

export async function query(text, params = []) {
  const res = await getPool().query(text, params);
  return res.rows;
}

/** Like query(), but returns the full result (rows + rowCount) for conditional updates. */
export async function queryFull(text, params = []) {
  return getPool().query(text, params);
}

export async function one(text, params = []) {
  const rows = await query(text, params);
  return rows[0] ?? null;
}
