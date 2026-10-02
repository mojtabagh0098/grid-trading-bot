#!/usr/bin/env bash
# Set the Telegram webhook to point at this app.
# Usage:
#   ./scripts/setup-webhook.sh <BOT_TOKEN> <APP_URL> <WEBHOOK_SECRET>
# Example:
#   ./scripts/setup-webhook.sh "123:ABC" "https://mybot.vercel.app" "$(openssl rand -hex 16)"
set -euo pipefail

TOKEN="${1:?BOT_TOKEN (from @BotFather) is required}"
URL="${2:?public app URL, e.g. https://mybot.vercel.app}"
SECRET="${3:?WEBHOOK_SECRET (must match the env var on Vercel)}"

curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  --data-urlencode "url=${URL%/}/api/webhook" \
  --data-urlencode "secret_token=${SECRET}" \
  --data-urlencode 'allowed_updates=["message","callback_query"]'
echo
