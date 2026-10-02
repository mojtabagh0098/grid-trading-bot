// api/webhook.js — Telegram webhook endpoint (POST).
// Acknowledges the update immediately (fast 200 for Telegram), then processes
// it; Vercel keeps the function alive until the async work finishes (max 60s).

import { handleUpdate, backgroundSyncForUser } from '../lib/bot.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // Verify the request really comes from Telegram (set via secret_token on setWebhook).
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
    res.status(403).end();
    return;
  }

  const update = req.body;
  res.status(200).json({ ok: true });
  if (!update || typeof update !== 'object' || (!update.message && !update.callback_query)) return;

  try {
    await handleUpdate(update);
    // keep grids fresh in the background while the user is around
    if (update.message && update.message.from) {
      await backgroundSyncForUser(update.message.from.id);
    }
  } catch (e) {
    console.error('update handling failed:', e);
  }
}
