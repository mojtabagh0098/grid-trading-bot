function apiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function telegram(config, method, payload) {
  const response = await fetch(apiUrl(config.telegramToken, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.description || `Telegram ${method} failed (${response.status})`);
  }
  return result.result;
}

export function sendMessage(config, chatId, text, replyMarkup) {
  return telegram(config, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}

export function answerCallback(config, callbackId, text = '') {
  return telegram(config, 'answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
    show_alert: false
  });
}

export const buttons = {
  inline_keyboard: []
};
