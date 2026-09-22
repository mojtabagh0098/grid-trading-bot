const required = [
  'TELEGRAM_BOT_TOKEN',
  'ADMIN_TELEGRAM_ID',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN'
];

export function getConfig() {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) {
    throw new Error(`Missing environment variables: ${missing.join(', ')}`);
  }

  const feeRatePct = Number(process.env.DEFAULT_FEE_RATE_PCT ?? '0.1');
  if (!Number.isFinite(feeRatePct) || feeRatePct < 0 || feeRatePct > 5) {
    throw new Error('DEFAULT_FEE_RATE_PCT must be a number between 0 and 5.');
  }

  return {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    adminTelegramId: String(process.env.ADMIN_TELEGRAM_ID),
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    upstashUrl: process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, ''),
    upstashToken: process.env.UPSTASH_REDIS_REST_TOKEN,
    cronSecret: process.env.CRON_SECRET || '',
    feeRatePct,
    sendTradeNotifications: process.env.SEND_TRADE_NOTIFICATIONS === 'true'
  };
}

export function isAdmin(userId, config) {
  return String(userId) === config.adminTelegramId;
}
