import { getConfig, isAdmin } from './_lib/config.js';
import { createRedis } from './_lib/redis.js';
import { getPrices, normalizeSymbol, validateTokenOnBinance } from './_lib/market.js';
import {
  clearSession,
  createGrid,
  getGrid,
  getSession,
  getToken,
  listGrids,
  listTokens,
  removeGrid,
  removeToken,
  renameToken,
  saveGrid,
  saveToken,
  setSession
} from './_lib/repository.js';
import { buildGrid, gridIndexForPrice } from './_lib/simulator.js';
import { refreshOneGrid, syncAllActiveGrids } from './_lib/grid-service.js';
import { answerCallback, sendMessage } from './_lib/telegram.js';
import {
  escapeHtml,
  gridCreateTokenKeyboard,
  gridDeleteKeyboard,
  gridDetailKeyboard,
  gridDetailText,
  gridsKeyboard,
  gridsText,
  mainMenu,
  tokenDeleteKeyboard,
  tokenDetailKeyboard,
  tokenDetailText,
  tokensMenu,
  tokensText,
  welcomeText
} from './_lib/ui.js';

function toLatinDigits(value) {
  const persian = '۰۱۲۳۴۵۶۷۸۹';
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  return String(value)
    .replace(/[۰-۹]/g, (char) => String(persian.indexOf(char)))
    .replace(/[٠-٩]/g, (char) => String(arabic.indexOf(char)))
    .replace(/,/g, '')
    .trim();
}

function parsePositive(value, label) {
  const parsed = Number(toLatinDigits(value));
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} باید یک عدد مثبت باشد.`);
  return parsed;
}

function parseInteger(value, label, min, max) {
  const parsed = Number(toLatinDigits(value));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} باید یک عدد صحیح بین ${min} تا ${max} باشد.`);
  }
  return parsed;
}

async function send(config, chatId, text, keyboard) {
  return sendMessage(config, chatId, text, keyboard);
}

async function showHome(config, chatId) {
  return send(config, chatId, welcomeText(), mainMenu());
}

async function showTokens(config, redis, chatId) {
  const tokens = await listTokens(redis);
  return send(config, chatId, tokensText(tokens), { inline_keyboard: tokensMenu(tokens) });
}


async function showGrids(config, redis, chatId, { refresh = true } = {}) {
  let grids;
  let notice = '';
  try {
    grids = refresh ? (await syncAllActiveGrids(redis)).grids : await listGrids(redis);
  } catch (error) {
    grids = await listGrids(redis);
    notice = `\n\n⚠️ به‌روزرسانی قیمت ناموفق بود؛ آخرین دادهٔ ذخیره‌شده نمایش داده می‌شود.\n<code>${escapeHtml(error.message)}</code>`;
  }
  const tokens = await listTokens(redis);
  return send(config, chatId, `${gridsText(grids)}${notice}`, gridsKeyboard(grids, tokens));
}

async function showGridDetail(config, redis, chatId, id, { refresh = true } = {}) {
  const grid = await getGrid(redis, id);
  if (!grid) throw new Error('گرید پیدا نشد یا حذف شده است.');
  let notice = '';
  if (refresh) {
    try {
      const prices = await getPrices([grid.symbol]);
      await refreshOneGrid(redis, grid, prices);
    } catch (error) {
      notice = `\n\n⚠️ قیمت تازه دریافت نشد: <code>${escapeHtml(error.message)}</code>`;
    }
  }
  return send(config, chatId, `${gridDetailText(grid)}${notice}`, gridDetailKeyboard(grid));
}

async function startGridCreation(config, redis, chatId) {
  const tokens = await listTokens(redis);
  if (!tokens.length) {
    return send(config, chatId, 'ابتدا دست‌کم یک توکن در فهرست توکن‌ها ثبت کنید.', mainMenu());
  }
  return send(config, chatId, '<b>ساخت گرید جدید — مرحله ۱ از ۵</b>\nتوکن را انتخاب کنید:', gridCreateTokenKeyboard(tokens));
}

async function beginGridForToken(redis, chatId, rawSymbol) {
  const symbol = normalizeSymbol(rawSymbol);
  if (!(await getToken(redis, symbol))) throw new Error('این توکن در فهرست ثبت نشده است.');
  await setSession(redis, chatId, { action: 'grid_create', stage: 'deposit', data: { symbol } });
  return `<b>ساخت گرید ${escapeHtml(symbol)} — مرحله ۲ از ۵</b>\nمقدار <b>Deposit</b> را برحسب USDT بفرستید.\nنمونه: <code>1000</code>`;
}

async function processSession(config, redis, chatId, session, text) {
  if (session.action === 'token_add') {
    const token = await validateTokenOnBinance(text);
    if (await getToken(redis, token.symbol)) throw new Error('این توکن از قبل ثبت شده است.');
    await saveToken(redis, token.symbol);
    await clearSession(redis, chatId);
    return send(config, chatId, `✅ <b>${token.symbol} / USDT</b> با قیمت فعلی <b>${token.price}</b> اضافه شد.`, mainMenu());
  }

  if (session.action === 'token_edit') {
    const token = await validateTokenOnBinance(text);
    const updated = await renameToken(redis, session.data.oldSymbol, token.symbol);
    await clearSession(redis, chatId);
    return send(config, chatId, `✅ نماد به <b>${updated.symbol} / USDT</b> تغییر کرد.`, mainMenu());
  }

  if (session.action !== 'grid_create') return null;
  const data = session.data;

  if (session.stage === 'deposit') {
    data.deposit = parsePositive(text, 'Deposit');
    await setSession(redis, chatId, { action: 'grid_create', stage: 'lowerPrice', data });
    return send(config, chatId, '<b>مرحله ۳ از ۵</b>\n<b>Lower price</b> را برحسب USDT بفرستید. این مقدار باید پایین‌تر از قیمت فعلی باشد.\nنمونه: <code>55000</code>');
  }
  if (session.stage === 'lowerPrice') {
    data.lowerPrice = parsePositive(text, 'Lower price');
    await setSession(redis, chatId, { action: 'grid_create', stage: 'totalGridNumber', data });
    return send(config, chatId, '<b>مرحله ۴ از ۵</b>\n<b>Total grid number</b> را بین ۲ تا ۵۰۰ بفرستید.\nاین عدد سرمایه را به همین تعداد tranche تقسیم می‌کند.\nنمونه: <code>20</code>');
  }
  if (session.stage === 'totalGridNumber') {
    data.totalGridNumber = parseInteger(text, 'Total grid number', 2, 500);
    await setSession(redis, chatId, { action: 'grid_create', stage: 'gridIntervalPct', data });
    return send(config, chatId, '<b>مرحله ۵ از ۵</b>\n<b>Grid interval</b> را به درصد بفرستید (بین ۰.۱ تا ۵۰).\nنمونه: <code>1.5</code> یعنی ۱.۵٪');
  }
  if (session.stage === 'gridIntervalPct') {
    data.gridIntervalPct = parsePositive(text, 'Grid interval');
    const token = await getToken(redis, data.symbol);
    if (!token) throw new Error('توکن انتخاب‌شده دیگر وجود ندارد. از ابتدا گرید بسازید.');
    const { price: startPrice } = await validateTokenOnBinance(data.symbol);
    const grid = buildGrid({ ...data, startPrice, feeRatePct: config.feeRatePct });
    const saved = await createGrid(redis, grid);
    await clearSession(redis, chatId);
    await send(config, chatId, '✅ گرید شبیه‌سازی ساخته و فعال شد. سفارش واقعی ثبت نشده است.', mainMenu());
    return showGridDetail(config, redis, chatId, saved.id, { refresh: false });
  }
  throw new Error('مرحلهٔ ثبت گرید نامعتبر است. /cancel را بزنید و دوباره تلاش کنید.');
}

async function handleText(config, redis, message) {
  const chatId = message.chat.id;
  const text = String(message.text || '').trim();
  if (!text) return;

  if (/^\/(start|menu)(?:@\w+)?$/i.test(text)) {
    await clearSession(redis, chatId);
    return showHome(config, chatId);
  }
  if (/^\/cancel(?:@\w+)?$/i.test(text)) {
    await clearSession(redis, chatId);
    return send(config, chatId, 'عملیات جاری لغو شد.', mainMenu());
  }

  const session = await getSession(redis, chatId);
  if (!session) {
    return send(config, chatId, 'برای کار با ربات، از منو استفاده کنید یا /start را بزنید.', mainMenu());
  }
  return processSession(config, redis, chatId, session, text);
}

async function handleCallback(config, redis, callback) {
  const chatId = callback.message?.chat?.id;
  if (!chatId) return;
  const data = callback.data || '';
  await answerCallback(config, callback.id).catch(() => undefined);

  if (data === 'menu:home') return showHome(config, chatId);
  if (data === 'menu:tokens') return showTokens(config, redis, chatId);
  if (data === 'menu:grids') return showGrids(config, redis, chatId);
  if (data === 'menu:refresh') {
    await send(config, chatId, 'در حال دریافت قیمت‌ها و محاسبهٔ شبیه‌سازی…');
    return showGrids(config, redis, chatId, { refresh: true });
  }

  if (data === 'tok:add') {
    await setSession(redis, chatId, { action: 'token_add', stage: 'symbol', data: {} });
    return send(config, chatId, '<b>افزودن توکن</b>\nنماد را بدون USDT بفرستید. مثال: <code>BTC</code> یا <code>PEPE</code>\nبرای لغو: /cancel');
  }
  if (data.startsWith('tok:view:')) {
    const symbol = data.slice('tok:view:'.length);
    const token = await getToken(redis, symbol);
    if (!token) throw new Error('توکن پیدا نشد.');
    return send(config, chatId, tokenDetailText(token), tokenDetailKeyboard(token));
  }
  if (data.startsWith('tok:edit:')) {
    const symbol = data.slice('tok:edit:'.length);
    if (!(await getToken(redis, symbol))) throw new Error('توکن پیدا نشد.');
    await setSession(redis, chatId, { action: 'token_edit', stage: 'symbol', data: { oldSymbol: symbol } });
    return send(config, chatId, `<b>ویرایش ${escapeHtml(symbol)}</b>\nنماد جدید را بفرستید. اگر برای توکن گرید وجود داشته باشد، تغییر نام مجاز نیست.\nبرای لغو: /cancel`);
  }
  if (data.startsWith('tok:delete:')) {
    const symbol = data.slice('tok:delete:'.length);
    return send(config, chatId, `آیا از حذف <b>${escapeHtml(symbol)} / USDT</b> مطمئن هستید؟\nتوکنی که گرید وابسته داشته باشد حذف نمی‌شود.`, tokenDeleteKeyboard(symbol));
  }
  if (data.startsWith('tok:confirmdelete:')) {
    const symbol = data.slice('tok:confirmdelete:'.length);
    await removeToken(redis, symbol);
    return send(config, chatId, `✅ ${escapeHtml(symbol)} حذف شد.`, mainMenu());
  }

  if (data === 'grid:add') return startGridCreation(config, redis, chatId);
  if (data.startsWith('gc:')) {
    const prompt = await beginGridForToken(redis, chatId, data.slice(3));
    return send(config, chatId, prompt);
  }
  if (data.startsWith('grid:view:')) return showGridDetail(config, redis, chatId, data.slice('grid:view:'.length));
  if (data.startsWith('grid:refresh:')) return showGridDetail(config, redis, chatId, data.slice('grid:refresh:'.length), { refresh: true });
  if (data.startsWith('grid:pause:')) {
    const grid = await getGrid(redis, data.slice('grid:pause:'.length));
    if (!grid) throw new Error('گرید پیدا نشد.');
    grid.status = 'paused';
    await saveGrid(redis, grid);
    return showGridDetail(config, redis, chatId, grid.id, { refresh: true });
  }
  if (data.startsWith('grid:resume:')) {
    const grid = await getGrid(redis, data.slice('grid:resume:'.length));
    if (!grid) throw new Error('گرید پیدا نشد.');
    const prices = await getPrices([grid.symbol]);
    const currentPrice = prices.get(grid.pair);
    grid.status = 'active';
    grid.lastPrice = currentPrice;
    grid.lastGridIndex = gridIndexForPrice(grid, currentPrice);
    grid.belowLower = grid.lastGridIndex < 0;
    grid.lastSyncAt = new Date().toISOString();
    await saveGrid(redis, grid);
    return showGridDetail(config, redis, chatId, grid.id, { refresh: false });
  }
  if (data.startsWith('grid:delete:')) {
    const id = data.slice('grid:delete:'.length);
    if (!(await getGrid(redis, id))) throw new Error('گرید پیدا نشد.');
    return send(config, chatId, 'آیا از حذف دائمی این گرید و سوابق شبیه‌سازی آن مطمئن هستید؟', gridDeleteKeyboard(id));
  }
  if (data.startsWith('grid:confirmdelete:')) {
    const id = data.slice('grid:confirmdelete:'.length);
    await removeGrid(redis, id);
    return send(config, chatId, '✅ گرید حذف شد.', mainMenu());
  }

  return send(config, chatId, 'این دکمه دیگر معتبر نیست. /start را بزنید.', mainMenu());
}

function requestBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'telegram-infinity-grid-webhook' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  let config;
  try {
    config = getConfig();
    if (config.telegramWebhookSecret) {
      const supplied = req.headers['x-telegram-bot-api-secret-token'];
      if (supplied !== config.telegramWebhookSecret) return res.status(401).json({ ok: false });
    }

    const update = requestBody(req);
    const actor = update.callback_query?.from || update.message?.from;
    if (!actor || !isAdmin(actor.id, config)) {
      return res.status(200).json({ ok: true, ignored: 'not-admin' });
    }

    const redis = createRedis(config);
    if (update.callback_query) await handleCallback(config, redis, update.callback_query);
    else if (update.message) await handleText(config, redis, update.message);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Webhook failed:', error);
    const update = requestBody(req);
    const chatId = update.callback_query?.message?.chat?.id || update.message?.chat?.id;
    if (config && chatId) {
      await send(config, chatId, `❌ خطا: ${escapeHtml(error.message || 'خطای ناشناخته')}\nمی‌توانید /cancel را بزنید و دوباره تلاش کنید.`).catch(() => undefined);
    }
    return res.status(200).json({ ok: true, handledError: true });
  }
}
