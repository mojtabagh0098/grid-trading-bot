// api/cron.js — Vercel Cron endpoint: replays all active grids' candle history
// and sweeps every user's open positions for TP/SL hits.
// Vercel sends CRON_SECRET automatically as `Authorization: Bearer <secret>`.

import { syncAllActiveGrids, syncAllPositions } from '../lib/sim.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  const auth = req.headers['authorization'];
  if (!cronSecret || auth !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const grids = await syncAllActiveGrids();
    const positions = await syncAllPositions();
    console.log('cron sync done', { grids, positions });
    res.status(200).json({ ok: true, grids, positions });
  } catch (e) {
    console.error('cron sync failed:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
}
