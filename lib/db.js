// lib/db.js — Postgres client (Vercel Postgres / Neon or any Postgres via DATABASE_URL).

import pg from 'pg';

let pool = null;
let testPool = null; // set by local integration tests (pg-mem)

export function _setTestPool(p) {
  testPool = p;
}

/**
 * Convert a postgres:// URL into explicit pg connection fields.
 *
 * Vercel Postgres (Neon) hands out URLs like
 *   postgresql://user:pass@ep-…-pooler.region.aws.neon.tech/db?sslmode=require
 * Newer pg-connection-string versions warn at parse time that `sslmode=require`
 * will change meaning in pg v9. We never want the URL to drive the TLS config:
 * we always connect over TLS with certificate verification disabled (there is
 * no CA bundle in the function), so the URL is parsed here and the `ssl` option
 * is set explicitly.
 */
export function poolConfig(connectionString) {
  const u = new URL(connectionString);
  return {
    host: u.hostname,
    port: u.port ? Number(u.port) : 5432,
    // URL keeps userinfo percent-encoded; pg needs the raw credentials
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    ssl: { rejectUnauthorized: false },
  };
}

function getPool() {
  if (testPool) return testPool;
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is not set');
    }
    pool = new pg.Pool({
      ...poolConfig(process.env.DATABASE_URL),
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
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
