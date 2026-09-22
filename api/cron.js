import { getConfig } from './_lib/config.js';
import { createRedis } from './_lib/redis.js';
import { syncAllActiveGrids } from './_lib/grid-service.js';

function authorized(req, secret) {
  const header = req.headers.authorization || '';
  return Boolean(secret) && header === `Bearer ${secret}`;
}

/** Vercel Cron calls this endpoint. It never creates real exchange orders. */
export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const config = getConfig();
    if (!authorized(req, config.cronSecret)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized cron request' });
    }

    const redis = createRedis(config);
    const result = await syncAllActiveGrids(redis);
    return res.status(200).json({
      ok: true,
      synced: result.synced,
      newTrades: result.trades,
      at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Cron failed:', error);
    return res.status(503).json({ ok: false, error: error.message || 'Sync failed' });
  }
}
