// lib/tg.js — UI layer: Persian texts, inline keyboards, view renderers.
// Talks to the classic Bot API (token in URL, form-encoded params) via global fetch.

import * as repo from './repo.js';
import * as sim from './sim.js';
import { getTicker } from './prices.js';
import { gridMetrics } from './grid.js';
import { posPnl } from './pos.js';
import { fmtPrice, fmtUsd, fmtPct, fmtQty, tTime, topPrice } from './util.js';

export class TgApiError extends Error {
  constructor(code, description, method) {
    super(description);
    this.name = 'TgApiError';
    this.code = code;
    this.method = method;
  }
}

async function tg(method, params = {}) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error('BOT_TOKEN is not set');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    body.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new TgApiError(json.error_code, json.description || `HTTP ${res.status}`, method);
  return json.result;
}

// Same shape as the Serverless SDK's `api` so the rest of the code reads identically.
export const api = {
  sendMessage: (p) => tg('sendMessage', p),
  editMessageText: (p) => tg('editMessageText', p),
  answerCallbackQuery: (p) => tg('answerCallbackQuery', p),
};

const LINE = '──────────────';

export const MAIN_TEXT =
  '🏠 منوی اصلی\n' +
  '📈 شبیه‌ساز گرید ترید\n\n' +
  'توکن‌های خودت را ثبت کن، گرید بساز و سود شبیه‌سازی را دنبال کن.';

export const HELP_TEXT =
  '📖 راهنما\n\n' +
  '۱) با «➕ افزودن توکن» نمادهای موردنظرت (مثل BTC یا SOL) را ثبت کن.\n' +
  '۲) با «➕ ساخت گرید» یک شبیه‌ساز گرید بساز. از تو این موارد را می‌گیرد:\n' +
  '   • مبلغ سرمایه (deposit) به USDT\n' +
  '   • قیمت پایین (lower price)\n' +
  '   • تعداد کل گریدها\n' +
  '   • فاصله گریدها (درصد)\n' +
  '۳) ربات با کندل‌های ۱ دقیقه‌ای، خرید روی هر سطح و فروش یک سطح بالاتر را شبیه‌سازی می‌کند.\n' +
  '🔴 مالک ربات می‌تواند با /live معامله واقعی روی KuCoin را روشن کند (توقف اضطراری: /panic).\n' +
  '۴) با «📊 لیست گریدها» سود محقق‌شده، ارزش کل و معاملات هر گرید را ببین.\n' +
  '۵) با «⚡ پوزیشن‌های من» یک پوزیشن لانگ/شورت با اهرم باز کن: توکن + قیمت ورود + موجودی + اهرم را می‌دهی، حد سود و ضرر را ربات از روی نوسان قیمت (ATR کندل‌های ۱ ساعته، نسبت ۲:۱) می‌گذارد. اگر قیمت به حد سود، حد ضرر (یا حد لیکوئید) رسید، پوزیشن خودکار بسته می‌شود، در تاریخچه ثبت و بهت اطلاع می‌دهم. دکمه «🔄 بروزرسانی» قیمت لحظه‌ای و سود/زیان بازها را نشان می‌دهد.\n\n' +
  'ℹ️ قیمت‌ها از صرافی KuCoin (در صورت نبود: Binance، Bybit و OKX) خوانده می‌شوند.\n' +
  'ℹ️ هر بار که لیست گریدها را باز می‌کنی، شبیه‌سازی تا لحظه‌ی فعلی به‌روز می‌شود.\n' +
  '⚠️ به‌طور پیش‌فرض همه‌چیز شبیه‌سازی است؛ فقط وقتی مالک با /live حالت واقعی را روشن کند، گریدهای جدید روی KuCoin با پول واقعی سفارش می‌گذارند (پوزیشن‌های اهرمی همیشه شبیه‌سازی‌اند).';

export const PROMPT_ADD_TOKEN =
  '🪙 نماد توکن را بنویس.\n' +
  'فقط حروف و اعداد انگلیسی، مثال: BTC یا SOL\n' +
  '(نماد باید در یک از صرافی‌های KuCoin / Binance / Bybit / OKX با جفت USDT باشد)';

export const PROMPT_GRID_TOKEN =
  '🪙 کدام توکن را برای ساخت گرید انتخاب می‌کنی؟\n' +
  'روی دکمه بزن یا نماد را بنویس.';

export const PROMPTS_GRID = {
  deposit: '💵 مبلغ سرمایه (deposit) را به USDT بنویس.\nمثال: 1000',
  lower: '📉 قیمت پایین (lower price) را بنویس.\nمثال: 95000',
  count: '🧵 تعداد کل گریدها را بنویس (۱ تا ۲۰۰).\nمثال: 20',
  interval: '📏 فاصله گریدها را به درصد بنویس (۰.۱ تا ۵۰).\nمثال: 1.5',
};

export const PROMPTS_POS = {
  token: '🪙 برای کدام توکن پوزیشن می‌زنی؟\nروی دکمه بزن یا نماد را بنویس.',
  entry: '📍 قیمت ورود را بنویس.\n(قیمتی که ربات پوزیشن را با آن باز می‌کند) مثال: 95000',
  amount: '💵 موجودی پوزیشن (مارجن) را به USDT بنویس (10 تا 100000000).\nمثال: 500',
  leverage: '⚡ اهرم را بنویس (عدد صحیح 1 تا 50).\nمثال: 10',
};

export const SIDE_LABEL = { long: '🟢 لانگ', short: '🔴 شورت' };
export const CLOSE_LABEL = { tp: 'حد سود', sl: 'حد ضرر', liq: 'لیکوئید شدن', manual: 'بستن دستی' };
export function posEmoji(reason) {
  return reason === 'tp' ? '✅' : reason === 'sl' ? '⛔' : reason === 'liq' ? '💥' : '✋';
}

/** Telegram notification text for a closed position. */
export function positionClosedText(p) {
  return (
    `${posEmoji(p.closeReason)} پوزیشن بسته شد — ${p.symbol}\n` +
    `${SIDE_LABEL[p.side]} ${p.leverage}×\n` +
    `نتیجه: ${CLOSE_LABEL[p.closeReason]}\n` +
    `📍 ورود: ${fmtPrice(p.entryPrice)} → خروج: ${fmtPrice(p.closePrice)}\n` +
    `💰 PnL: ${p.pnl >= 0 ? '+' : ''}${fmtUsd(p.pnl)} USDT (${fmtPct(p.roiPct)})\n` +
    `⏱ ${tTime(p.closeTime)}`
  );
}

/** Fire a notification about a closed position. */
export const notifyPositionClosed = (tgId, p) =>
  api.sendMessage({ chat_id: tgId, text: positionClosedText(p) });

// ---------- low-level helpers ----------

export function mainRows() {
  return [
    [{ text: '🪙 لیست توکن‌ها', callback_data: 'tokens' },
     { text: '➕ افزودن توکن', callback_data: 'add_token' }],
    [{ text: '📊 لیست گریدها', callback_data: 'grids' },
     { text: '➕ ساخت گرید', callback_data: 'grid_new' }],
    [{ text: '⚡ پوزیشن‌های من', callback_data: 'positions' }],
    [{ text: '📖 راهنما', callback_data: 'help' }],
  ];
}

export function cancelRows() {
  return [[{ text: '❌ لغو', callback_data: 'flow_cancel' }]];
}

export function backToMenuRow() {
  return [[{ text: '🏠 منو', callback_data: 'main' }]];
}

/**
 * Edit the given message in place; if that fails (e.g. it was deleted), send a new one.
 * @returns the message id (the edited one, or the fresh one).
 */
/**
 * Telegram wants inline_keyboard = array of ROWS, each row an array of BUTTON objects.
 * Helpers like backToMenuRow()/cancelRows() return a list of rows ([[btn]]) while callers
 * often drop them in as if they were a single row -> a 3-level nesting Telegram rejects
 * ("InlineKeyboardButton must be an Object"). Flatten any such over-nesting.
 */
export function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    if (r.length && r.every(Array.isArray)) out.push(...normalizeRows(r)); // a list of rows
    else if (r.length) out.push(r);                                         // a proper row
  }
  return out;
}

export async function editOrSend(chatId, text, rows, msgId) {
  // an empty keyboard clears buttons when editing
  const markup = { inline_keyboard: normalizeRows(rows) };
  if (msgId) {
    try {
      await api.editMessageText({ chat_id: chatId, message_id: msgId, text, reply_markup: markup });
      return msgId;
    } catch (e) {
      // "message is not modified" -> the message already shows exactly this; keep it.
      if (e instanceof TgApiError && /not modified/i.test(e.message || '')) return msgId;
      // otherwise (message deleted, too old, …) fall through to a fresh message.
    }
  }
  const m = await api.sendMessage({ chat_id: chatId, text, reply_markup: markup });
  return m.message_id;
}

// ---------- views ----------

/** Main menu (sent on /start, sent as a new message). */
export async function sendMain(chatId) {
  const m = await api.sendMessage({ chat_id: chatId, text: MAIN_TEXT, reply_markup: { inline_keyboard: mainRows() } });
  return m.message_id;
}

/**
 * Token list view. Fetches current prices in parallel (capped).
 * @param {string} [prefix] optional notice line prepended to the view.
 */
export async function showTokenList(user, chatId, msgId, prefix = '') {
  const toks = await repo.getTokens(user.tgId);
  const shown = toks.slice(0, 15);

  const priced = await Promise.all(shown.map(async (t) => {
    try {
      const { price, source } = await getTicker(t.symbol);
      return `🪙 ${t.symbol} — ${fmtPrice(price)} USDT  (${source})`;
    } catch {
      return `🪙 ${t.symbol} — قیمت فعلاً در دسترس نیست`;
    }
  }));

  let body = priced.length ? priced.join('\n') : 'لیست توکن‌ها خالی است.';
  if (toks.length > shown.length) body += `\n… و ${toks.length - shown.length} توکن دیگر`;

  const rows = shown.map((t) => [
    { text: `✏️ ${t.symbol}`, callback_data: 'token_edit.' + t.symbol },
    { text: `🗑 ${t.symbol}`, callback_data: 'token_del.' + t.symbol },
  ]);
  rows.push([{ text: '➕ افزودن توکن', callback_data: 'add_token' }], backToMenuRow());

  const text = (prefix ? prefix + '\n\n' : '') + '🪙 لیست توکن‌ها\n' + LINE + '\n' + body;
  return editOrSend(chatId, text, rows, msgId);
}

export async function confirmTokenDel(user, chatId, msgId, symbol) {
  const n = await repo.countGridsBySymbol(user.tgId, symbol);
  const note = n
    ? `توجه: ${n} گرید روی ${symbol} هست؛ آن‌ها بعد از حذف هم با همین نماد ادامه می‌دهند (فقط باید دوباره توکن را ثبت کنی تا گرید جدید بسازی).`
    : 'این کار فقط ثبت توکن را حذف می‌کند.';
  const rows = [
    [{ text: '✔️ بله، حذف کن', callback_data: 'token_del_y.' + symbol }],
    [{ text: '❌ خیر', callback_data: 'tokens' }],
  ];
  return editOrSend(chatId, `🗑 مطمئنیم ${symbol} را حذف کنیم؟\n\n${note}`, rows, msgId);
}

/**
 * Grid list view: syncs every active grid through its candle history, then renders.
 */
export async function showGridList(user, chatId, msgId, notice = '') {
  const all = await repo.getGrids(user.tgId);
  const shown = all.slice(0, 20);
  const priceCache = {};
  const deadline = Date.now() + 40000; // stay inside the function timeout

  const blocks = [];
  for (const g0 of shown) {
    let g;
    try {
      g = Date.now() > deadline
        ? { ...g0, lastPrice: g0.lastPrice, source: null }
        : await sim.safeSync(user.tgId, g0, priceCache);
    } catch (e) {
      g = { ...g0, lastPrice: g0.lastPrice, source: null };
    }
    const m = gridMetrics(g, g.lastPrice);
    const status = g.active ? '✅ فعال' : '⏸ متوقف';
    blocks.push(
      `🪙 ${g.symbol} — ${status}${g.live ? ' 🔴 واقعی' : ''}\n` +
      `💵 ${fmtUsd(g.deposit)} USDT | 🧵 ${g.gridCount}×${g.intervalPct}% | 📉 ${fmtPrice(g.lowerPrice)} → ${fmtPrice(topPrice(g))}\n` +
      `💰 سود: ${fmtUsd(m.totalPnl)} USDT (${fmtPct(m.totalPct)}) | 🔁 ${g.tradeCount} معامله\n` +
      `💹 قیمت: ${fmtPrice(g.lastPrice)}${g.source ? ' (' + g.source + ')' : ''} | ⏱ ${tTime(Date.now())}`,
    );
  }

  let body = blocks.length ? blocks.join('\n\n' + LINE + '\n\n') : 'هنوز گریدی نداری.\nبا «➕ ساخت گرید» اولین شبیه‌سازی را بساز.';
  if (all.length > shown.length) body += `\n\n… و ${all.length - shown.length} گرید دیگر`;

  const rows = shown.map((g) => [
    { text: `📈 ${g.symbol}`, callback_data: 'grid_info.' + g.id },
    { text: g.active ? '🛑 توقف' : '▶️ شروع', callback_data: 'grid_stop.' + g.id },
    { text: '🗑', callback_data: 'grid_del.' + g.id },
  ]);
  rows.push([{ text: '➕ ساخت گرید', callback_data: 'grid_new' }], backToMenuRow());

  const text = (notice ? notice + '\n\n' : '') + '📊 لیست گریدها\n' + LINE + '\n' + body;
  return editOrSend(chatId, text, rows, msgId);
}

/** Grid detail view: full parameters, metrics and the last 10 fills. */
export async function showGridDetail(user, chatId, msgId, gridId) {
  const g0 = await repo.getGrid(user.tgId, gridId);
  if (!g0) return editOrSend(chatId, '⚠️ این گرید پیدا نشد.', backToMenuRow(), msgId);
  let g;
  try {
    g = await sim.safeSync(user.tgId, g0, {});
  } catch {
    g = { ...g0, lastPrice: g0.lastPrice, source: null };
  }
  const m = gridMetrics(g, g.lastPrice);
  const trs = await repo.recentTrades(gridId, 10);

  let lines =
    `🔍 جزئیات گرید — ${g.symbol}${g.live ? ' 🔴 واقعی (KuCoin)' : ''}\n` +
    `وضعیت: ${g.active ? '✅ فعال' : '⏸ متوقف'}  (ID: ${g.id})\n\n` +
    'پارامترها:\n' +
    `💵 سرمایه: ${fmtUsd(g.deposit)} USDT (هر گرید ${fmtUsd(g.deposit / g.gridCount)})\n` +
    `🧵 تعداد: ${g.gridCount} | 📏 فاصله: ${g.intervalPct}%\n` +
    `📉 قیمت پایین: ${fmtPrice(g.lowerPrice)} → 🎯 سقف: ${fmtPrice(topPrice(g))}\n\n` +
    'وضعیت شبیه‌سازی:\n' +
    `💹 قیمت فعلی: ${fmtPrice(g.lastPrice)}${g.source ? ' (' + g.source + ')' : ''}\n` +
    `💰 سود محقق‌شده: ${fmtUsd(g.realized)} USDT\n` +
    `💼 ارزش کل: ${fmtUsd(m.equity)} USDT (${fmtPct(m.totalPct)})\n` +
    `🪙 موزیون فعلی: ${fmtQty(g.position)} ${g.symbol}\n` +
    `💵 نقدی باقی‌مانده: ${fmtUsd(g.cash)} USDT\n` +
    `🔁 تعداد معاملات: ${g.tradeCount}\n` +
    `⏱ آخرین به‌روزرسانی: ${tTime(Date.now())}`;

  if (trs.length) {
    lines += '\n\nآخرین معاملات:\n' + trs.slice().reverse().map((t) =>
      (t.side === 'sell' ? '✅ فروش L' : '⬇️ خرید L') + t.level +
      ` — ${fmtPrice(t.price)} × ${fmtQty(t.qty)}` +
      (t.side === 'sell' ? '' : ''),
    ).join('\n');
  } else {
    lines += '\n\nهنوز معامله‌ای ثبت نشده؛ منتظر حرکت قیمت روی سطوح گرید.';
  }

  const rows = [
    [{ text: g.active ? '🛑 توقف' : '▶️ شروع', callback_data: 'grid_stop.' + g.id },
     { text: '🗑 حذف گرید', callback_data: 'grid_del.' + g.id }],
    [{ text: '📊 لیست گریدها', callback_data: 'grids' }],
    backToMenuRow(),
  ];
  return editOrSend(chatId, lines, rows, msgId);
}

export async function confirmGridDel(user, chatId, msgId, gridId) {
  const g = await repo.getGrid(user.tgId, gridId);
  if (!g) return editOrSend(chatId, '⚠️ این گرید پیدا نشد.', backToMenuRow(), msgId);
  const rows = [
    [{ text: '✔️ بله، حذف کن', callback_data: 'grid_del_y.' + g.id }],
    [{ text: '❌ خیر', callback_data: 'grids' }],
  ];
  return editOrSend(
    chatId,
    `🗑 مطمئنیم گرید ${g.symbol} (ID: ${g.id}) را برای همیشه حذف کنیم؟\nحالت شبیه‌سازی و تاریخچه معاملات آن هم پاک می‌شود.`,
    rows,
    msgId,
  );
}

// ---------- positions ----------

/**
 * Open positions view. First refreshes live prices and auto-closes any
 * TP/SL/liq hits (with notifications), then renders each open position
 * with its unrealized PnL. `notice` (e.g. a manual-close summary) is prepended.
 */
export async function showPositions(user, chatId, msgId, notice = '') {
  let pre = notice;
  try {
    const res = await sim.checkUserPositions(user.tgId, 20000);
    if (res.closed.length) {
      pre = (pre ? pre + '\n' : '') + res.closed.map((c) => c.text).join('\n');
    }
  } catch (e) {
    console.warn('positions refresh failed:', e.message);
  }

  const all = await repo.getOpenPositions(user.tgId);
  const shown = all.slice(0, 8);

  const blocks = [];
  let total = 0;
  for (const p of shown) {
    const price = p.lastPrice > 0 ? p.lastPrice : p.entryPrice;
    const { pnl, roiPct } = posPnl(p, price);
    if (p.lastPrice > 0) total += pnl;
    blocks.push(
      `🪙 ${p.symbol} — ${SIDE_LABEL[p.side]} ${p.leverage}×  (ID: ${p.id})\n` +
      `📍 ورود: ${fmtPrice(p.entryPrice)} | 💹 فعلی: ${fmtPrice(p.lastPrice)}\n` +
      `🎯 حد سود: ${fmtPrice(p.takeProfit)} | 🛑 حد ضرر: ${fmtPrice(p.stopLoss)}\n` +
      `💰 PnL: ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} USDT (${fmtPct(roiPct)})`,
    );
  }

  let body = blocks.length
    ? blocks.join('\n\n' + LINE + '\n\n') +
      `\n\nΣ PnL کل: ${total >= 0 ? '+' : ''}${fmtUsd(total)} USDT`
    : 'پوزیشن بازی نداری.\nبا «➕ پوزیشن جدید» اولین پوزیشن را باز کن.';
  if (all.length > shown.length) body += `\n… و ${all.length - shown.length} پوزیشن دیگر`;

  const rows = shown.map((p) => [
    { text: `✋ بستن ${p.symbol}`, callback_data: 'pos_close.' + p.id },
  ]);
  rows.push([
    { text: '🔄 بروزرسانی', callback_data: 'pos_refresh' },
    { text: '➕ پوزیشن جدید', callback_data: 'pos_new' },
  ]);
  rows.push([
    { text: '📜 تاریخچه', callback_data: 'pos_history' },
    { text: '🏠 منو', callback_data: 'main' },
  ]);

  const text = (pre ? pre + '\n\n' : '') + '⚡ پوزیشن‌های باز\n' + LINE + '\n' + body;
  return editOrSend(chatId, text, rows, msgId);
}

/** Recent closed positions with the reason each one was closed. */
export async function showPosHistory(user, chatId, msgId, notice = '') {
  const closed = await repo.getRecentClosed(user.tgId, 10);
  const blocks = closed.map((p) =>
    `🪙 ${p.symbol} — ${SIDE_LABEL[p.side]} ${p.leverage}×\n` +
    `${posEmoji(p.closeReason)} ${CLOSE_LABEL[p.closeReason]} | ⏱ ${tTime(p.closeTime)}\n` +
    `📍 ورود: ${fmtPrice(p.entryPrice)} → خروج: ${fmtPrice(p.closePrice)} | ` +
    `💰 PnL: ${p.pnl >= 0 ? '+' : ''}${fmtUsd(p.pnl)} USDT (${fmtPct(p.roiPct)})`,
  );
  let total = 0;
  closed.forEach((p) => { total += p.pnl || 0; });
  let body = blocks.length
    ? blocks.join('\n\n' + LINE + '\n\n') +
      `\n\nΣ جمع این ${closed.length} مورد: ${total >= 0 ? '+' : ''}${fmtUsd(total)} USDT`
    : 'هنوز پوزیشن بسته‌ای نداری.';
  const rows = [
    [{ text: '⚡ پوزیشن‌های باز', callback_data: 'positions' }],
    backToMenuRow(),
  ];
  const text = (notice ? notice + '\n\n' : '') + '📜 تاریخچه پوزیشن‌ها\n' + LINE + '\n' + body;
  return editOrSend(chatId, text, rows, msgId);
}

/** Two-step confirm before manually closing an open position. */
export async function confirmPosClose(user, chatId, msgId, posId) {
  const p = await repo.getPosition(user.tgId, posId);
  if (!p || p.status !== 'open') {
    return editOrSend(chatId, '⚠️ این پوزیشن دیگر باز نیست (شاید حد سود/ضرر را زده باشد).', backToMenuRow(), msgId);
  }
  const price = p.lastPrice > 0 ? p.lastPrice : p.entryPrice;
  const { pnl, roiPct } = posPnl(p, price);
  const rows = [
    [{ text: '✔️ بله، ببند', callback_data: 'pos_close_y.' + p.id }],
    [{ text: '❌ خیر', callback_data: 'positions' }],
  ];
  return editOrSend(
    chatId,
    `✋ ${p.symbol} — ${SIDE_LABEL[p.side]} ${p.leverage}× را با قیمت فعلی (≈ ${fmtPrice(price)}) ببندیم؟\n` +
    `PnL تقریبی: ${pnl >= 0 ? '+' : ''}${fmtUsd(pnl)} USDT (${fmtPct(roiPct)})`,
    rows,
    msgId,
  );
}
