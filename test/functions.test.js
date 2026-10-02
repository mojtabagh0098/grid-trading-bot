// test/functions.test.js — the Vercel function handlers (webhook + cron) with mocked req/res.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pgMem from 'pg-mem';

import { _setTestPool } from '../lib/db.js';

let webhook, cron;
let db;

before(async () => {
  process.env.BOT_TOKEN = '123456:TEST-TOKEN';
  process.env.WEBHOOK_SECRET = 'wh-secret-123';
  process.env.CRON_SECRET = 'cron-secret-456';

  db = pgMem.newDb();
  db.public.none(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const { Pool } = db.adapters.createPg();
  _setTestPool(new Pool());

  // fetch stub: telegram + binance
  let msgId = 1;
  const T_END = Math.floor(Date.now() / 60000) * 60000;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const tgOk = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if (u.startsWith('https://api.telegram.org/bot')) {
      const method = u.split('/').pop();
      return tgOk(method === 'sendMessage' ? { message_id: ++msgId, chat: { id: 1 } } : true);
    }
    const rows = [];
    for (let i = 40; i > 0; i--) {
      const t = T_END - i * 60000;
      const p = 100 + Math.sin(i / 9) * 2;
      rows.push([t, String(p), String(p + 0.2), String(p - 0.2), String(p), '1', t + 59999, 'x', 0, '0', '0', '0']);
    }
    return { ok: true, status: 200, json: async () => rows };
  };

  webhook = (await import('../api/webhook.js')).default;
  cron = (await import('../api/cron.js')).default;
});

after(() => {
  delete process.env.WEBHOOK_SECRET;
  delete process.env.CRON_SECRET;
  delete process.env.BOT_TOKEN;
});

function mockReq({ method = 'POST', headers = {}, body }) {
  return { method, headers, body };
}

function mockRes() {
  const res = { code: null, payload: null, ended: false };
  res.status = (c) => { res.code = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

test('webhook: rejects non-POST', async () => {
  const res = mockRes();
  await webhook(mockReq({ method: 'GET' }), res);
  assert.equal(res.code, 405);
});

test('webhook: rejects a request with the wrong secret', async () => {
  const res = mockRes();
  await webhook(mockReq({ headers: { 'x-telegram-bot-api-secret-token': 'nope' }, body: { message: {} } }), res);
  assert.equal(res.code, 403);
});

test('webhook: accepts a valid update and processes it (200 even before processing)', async () => {
  const res = mockRes();
  const update = { message: { chat: { id: 55 }, from: { id: 55 }, text: '/start' } };
  await webhook(mockReq({ headers: { 'x-telegram-bot-api-secret-token': 'wh-secret-123' }, body: update }), res);
  assert.equal(res.code, 200);
  assert.deepEqual(res.payload, { ok: true });
  // the update was processed: the user row exists (created while handling /start)
  const u = await (await import('../lib/repo.js')).getUser(55);
  assert.ok(u.id > 0, 'user row created by the update');
});

test('cron: rejects without the bearer secret', async () => {
  const res = mockRes();
  await cron(mockReq({ method: 'GET', headers: { authorization: 'Bearer wrong' } }), res);
  assert.equal(res.code, 401);
});

test('cron: accepts the CRON_SECRET bearer and syncs active grids + positions', async () => {
  const repo = await import('../lib/repo.js');
  const sim = await import('../lib/sim.js');
  const user = await repo.getUser(66);
  await repo.addToken(66, 'BTC');
  const { grid } = await sim.createGrid(user, { symbol: 'BTC', deposit: 500, lowerPrice: 96, gridCount: 5, intervalPct: 1 });
  assert.ok(grid.id > 0);
  // one open position (TP far away -> not closed by the sweep)
  const pos = await repo.insertPosition({
    userId: 66, symbol: 'BTC', side: 'long', entryPrice: 100,
    amountUsdt: 100, leverage: 5, takeProfit: 10000, stopLoss: 0.01, created: Date.now(),
  });
  assert.ok(pos.id > 0);

  const res = mockRes();
  await cron(mockReq({ method: 'GET', headers: { authorization: 'Bearer cron-secret-456' } }), res);
  assert.equal(res.code, 200);
  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.grids.total >= 1, 'found the active grid');
  assert.ok(res.payload.grids.synced >= 1, 'synced the active grid');
  assert.ok(res.payload.positions.total >= 1, 'found the open position');
  assert.ok(res.payload.positions.checked >= 1, 'checked the open position');
  const p = await repo.getPosition(66, pos.id);
  assert.equal(p.status, 'open', 'TP not hit: position stays open');
});
