// api/webhook.js — Telegram webhook endpoint (POST).
// Replies 200 to Telegram immediately, but keeps the function ALIVE until the
// real work finishes using waitUntil (otherwise Vercel freezes the function
// right after the response is sent and DB connections break).

import { waitUntil } from '@vercel/functions';
import { handleUpdate, backgroundSyncForUser } from '../lib/bot.js';

export const maxDuration = 60;

async function processUpdate(update) {
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
  if (update && typeof update === 'object' && (update.message || update.callback_query)) {
    const work = processUpdate(update);
    if (process.env.VERCEL) waitUntil(work); // on Vercel: stay alive until it finishes
    else await work;                         // locally / in tests: just wait for it
  }
  res.status(200).json({ ok: true });
}
