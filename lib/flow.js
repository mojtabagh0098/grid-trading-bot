// lib/flow.js — conversational flows driven by text messages
// (add token / edit token / create grid). Flow state lives in users.pending:
//   { type, step, msgId, data }

import * as repo from './repo.js';
import * as ui from './tg.js';
import * as sim from './sim.js';
import { getTicker, getAtr } from './prices.js';
import { computeTpsl, liqPrice } from './pos.js';
import { toNum, fmtPrice } from './util.js';

const VALID_SYMBOL = /^[A-Z0-9]{1,10}$/;

/** Show an error inside the flow message, keeping the flow alive. */
async function fail(user, chatId, pending, msg) {
  const rows = ui.cancelRows();
  await ui.editOrSend(chatId, '⚠️ ' + msg + '\n\nدوباره وارد کن یا لغو کن.', rows, pending.msgId);
}

/** Save the mutated pending doc back. */
async function savePending(userId, pending) {
  await repo.setPending(userId, pending);
  return pending.msgId;
}

async function nextStep(user, chatId, pending, text, rows) {
  const msgId = await ui.editOrSend(chatId, text, rows, pending.msgId);
  pending.msgId = msgId; // keep the id even if a fresh message was sent
  return savePending(user.id, pending);
}

export async function handleText(user, chatId, text) {
  const p = user.pending;
  if (!p) return;
  try {
    if (p.type === 'add_token') return await stepAddToken(user, chatId, p, text);
    if (p.type === 'edit_token') return await stepEditToken(user, chatId, p, text);
    if (p.type === 'grid_new') return await stepGridNew(user, chatId, p, text);
    if (p.type === 'pos_new') return await stepPosNew(user, chatId, p, text);
  } catch (e) {
    console.error('flow error', e);
    await ui.editOrSend(chatId, '❌ خطایی رخ داد: ' + (e.message || String(e)), ui.cancelRows(), p.msgId).catch(() => {});
  }
}

// ---------- add token ----------

async function stepAddToken(user, chatId, p, text) {
  const sym = text.toUpperCase().trim();
  if (!VALID_SYMBOL.test(sym)) {
    return fail(user, chatId, p, 'نماد معتبر نیست. فقط حروف و اعداد انگلیسی، مثال: BTC');
  }
  if (await repo.getToken(user.tgId, sym)) {
    return fail(user, chatId, p, `توکن ${sym} قبلاً ثبت شده است.`);
  }
  let ticker;
  try {
    ticker = await getTicker(sym);
  } catch {
    return fail(user, chatId, p, `نماد ${sym} را با جفت USDT در Binance / Bybit / OKX پیدا نکردم.`);
  }
  await repo.addToken(user.tgId, sym);
  await repo.setPending(user.id, null);
  return ui.showTokenList(user, chatId, p.msgId,
    `✅ توکن ${sym} ثبت شد.\n💹 قیمت فعلی: ${fmtPrice(ticker.price)} USDT (${ticker.source})`);
}

// ---------- edit token ----------

async function stepEditToken(user, chatId, p, text) {
  const oldSym = p.data.old;
  const sym = text.toUpperCase().trim();
  if (!VALID_SYMBOL.test(sym)) {
    return fail(user, chatId, p, 'نماد معتبر نیست. فقط حروف و اعداد انگلیسی، مثال: BTC');
  }
  if (sym === oldSym) {
    await repo.setPending(user.id, null);
    return ui.showTokenList(user, chatId, p.msgId, `نماد عوض نشد (${sym}).`);
  }
  let ticker;
  try {
    ticker = await getTicker(sym);
  } catch {
    return fail(user, chatId, p, `نماد ${sym} را با جفت USDT در Binance / Bybit / OKX پیدا نکردم.`);
  }
  if (await repo.getToken(user.tgId, sym)) {
    return fail(user, chatId, p, `توکن ${sym} قبلاً ثبت شده است.`);
  }
  await repo.renameToken(user.tgId, oldSym, sym);
  await repo.renameTokenInGrids(user.tgId, oldSym, sym);
  await repo.setPending(user.id, null);
  const n = await repo.countGridsBySymbol(user.tgId, sym);
  const note = n ? `\n📊 ${n} گرید مرتبط هم به ${sym} بروزرسانی شد.` : '';
  return ui.showTokenList(user, chatId, p.msgId, `✅ ${oldSym} به ${sym} تغییر کرد.${note}`);
}

// ---------- create grid ----------

export async function stepGridNew(user, chatId, p, text) {
  const d = (p.data = p.data || {});

  switch (p.step) {
    case 'token': {
      const sym = text.toUpperCase().trim();
      if (!VALID_SYMBOL.test(sym)) {
        return fail(user, chatId, p, 'نماد معتبر نیست.');
      }
      if (!(await repo.getToken(user.tgId, sym))) {
        return fail(user, chatId, p,
          `توکن ${sym} در لیست تو نیست. اول با «➕ افزودن توکن» ثبتش کن یا از دکمه‌ها انتخاب کن.`);
      }
      d.symbol = sym;
      p.step = 'deposit';
      return nextStep(user, chatId, p, `🪙 توکن: ${sym}\n\n` + ui.PROMPTS_GRID.deposit, ui.cancelRows());
    }
    case 'deposit': {
      const v = toNum(text);
      if (!(v >= 10 && v <= 100000000)) {
        return fail(user, chatId, p, 'مبلغ سرمایه باید عددی بین 10 تا 100000000 USDT باشد.');
      }
      d.deposit = v;
      p.step = 'lower';
      return nextStep(user, chatId, p,
        `💵 سرمایه: ${fmtPrice(v)} USDT\n\n` + ui.PROMPTS_GRID.lower, ui.cancelRows());
    }
    case 'lower': {
      const v = toNum(text);
      if (!(v > 0)) {
        return fail(user, chatId, p, 'قیمت پایین باید عددی بزرگ‌تر از صفر باشد.');
      }
      d.lowerPrice = v;
      p.step = 'count';
      return nextStep(user, chatId, p,
        `📉 قیمت پایین: ${fmtPrice(v)}\n\n` + ui.PROMPTS_GRID.count, ui.cancelRows());
    }
    case 'count': {
      const v = toNum(text);
      if (!Number.isInteger(v) || v < 1 || v > 200) {
        return fail(user, chatId, p, 'تعداد گریدها باید عدد صحیح بین ۱ تا ۲۰۰ باشد.');
      }
      d.gridCount = v;
      p.step = 'interval';
      return nextStep(user, chatId, p,
        `🧵 تعداد گرید: ${v}\n\n` + ui.PROMPTS_GRID.interval, ui.cancelRows());
    }
    case 'interval': {
      const v = toNum(text);
      if (!(v >= 0.1 && v <= 50)) {
        return fail(user, chatId, p, 'فاصله گریدها باید عددی بین ۰.۱ تا ۵۰ درصد باشد.');
      }
      d.intervalPct = v;
      p.step = 'creating';
      await ui.editOrSend(chatId, '⏳ در حال ساخت گرید و شروع شبیه‌سازی…', null, p.msgId);
      const { confirmText } = await sim.createGrid(user, d);
      await repo.setPending(user.id, null);
      const rows = [
        [{ text: '📊 لیست گریدها', callback_data: 'grids' }],
        ui.backToMenuRow(),
      ];
      return ui.editOrSend(chatId, confirmText, rows, p.msgId);
    }
    default:
      await repo.setPending(user.id, null);
      return ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), p.msgId);
  }
}

// ---------- helpers for the callback handler ----------

/** Token picked from the inline list during grid creation. */
export async function pickGridToken(user, chatId, symbol, msgId) {
  const p = user.pending;
  if (!p || p.type !== 'grid_new' || p.step !== 'token') {
    return ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), msgId);
  }
  const d = (p.data = p.data || {});
  d.symbol = symbol.toUpperCase();
  p.step = 'deposit';
  return nextStep(user, chatId, p,
    `🪙 توکن: ${d.symbol}\n\n` + ui.PROMPTS_GRID.deposit, ui.cancelRows());
}

/** Kick off the "new grid" flow: pick a token first. */
export async function startGridFlow(user, chatId, msgId) {
  const toks = await repo.getTokens(user.tgId);
  if (!toks.length) {
    const rows = [
      [{ text: '➕ افزودن توکن', callback_data: 'add_token' }],
      ui.backToMenuRow(),
    ];
    return ui.editOrSend(chatId,
      'برای ساخت گرید اول باید حداقل یک توکن ثبت کنی.', rows, msgId);
  }
  const rows = toks.slice(0, 25).map((t) => [
    { text: `🪙 ${t.symbol}`, callback_data: 'grid_pick.' + t.symbol },
  ]);
  rows.push(ui.cancelRows()[0]);
  const m = await ui.editOrSend(chatId, ui.PROMPT_GRID_TOKEN, rows, msgId);
  await repo.setPending(user.id, { type: 'grid_new', step: 'token', msgId: m, data: {} });
  return m;
}

// ---------- new position (leveraged long/short, bot-set TP/SL) ----------

/** Kick off the "new position" flow: pick a token first. */
export async function startPosFlow(user, chatId, msgId) {
  const open = await repo.countOpenPositions(user.tgId);
  if (open >= sim.MAX_OPEN_POSITIONS) {
    const rows = [
      [{ text: '⚡ پوزیشن‌های من', callback_data: 'positions' }],
      ui.backToMenuRow(),
    ];
    return ui.editOrSend(chatId,
      `حداکثر ${sim.MAX_OPEN_POSITIONS} پوزیشن هم‌زمان باز می‌ماند. اول یکی را ببند.`, rows, msgId);
  }
  const toks = await repo.getTokens(user.tgId);
  if (!toks.length) {
    const rows = [
      [{ text: '➕ افزودن توکن', callback_data: 'add_token' }],
      ui.backToMenuRow(),
    ];
    return ui.editOrSend(chatId,
      'برای باز کردن پوزیشن اول باید حداقل یک توکن ثبت کنی.', rows, msgId);
  }
  const rows = toks.slice(0, 25).map((t) => [
    { text: `🪙 ${t.symbol}`, callback_data: 'pos_pick.' + t.symbol },
  ]);
  rows.push(ui.cancelRows()[0]);
  const m = await ui.editOrSend(chatId, ui.PROMPTS_POS.token, rows, msgId);
  await repo.setPending(user.id, { type: 'pos_new', step: 'token', msgId: m, data: {} });
  return m;
}

/** Token picked from the inline list (callback pos_pick.<SYM>). */
export async function pickPosToken(user, chatId, symbol, msgId) {
  const p = user.pending;
  if (!p || p.type !== 'pos_new' || p.step !== 'token') {
    return ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), msgId);
  }
  const d = (p.data = p.data || {});
  d.symbol = symbol.toUpperCase();
  p.step = 'entry';
  return nextStep(user, chatId, p,
    `🪙 توکن: ${d.symbol}\n\n` + ui.PROMPTS_POS.entry, ui.cancelRows());
}

/** Text steps of the position flow: token -> entry -> amount -> leverage. */
export async function stepPosNew(user, chatId, p, text) {
  const d = (p.data = p.data || {});

  switch (p.step) {
    case 'token': {
      const sym = text.toUpperCase().trim();
      if (!VALID_SYMBOL.test(sym)) {
        return fail(user, chatId, p, 'نماد معتبر نیست.');
      }
      if (!(await repo.getToken(user.tgId, sym))) {
        return fail(user, chatId, p,
          `توکن ${sym} در لیست تو نیست. اول با «➕ افزودن توکن» ثبتش کن یا از دکمه‌ها انتخاب کن.`);
      }
      d.symbol = sym;
      p.step = 'entry';
      return nextStep(user, chatId, p,
        `🪙 توکن: ${sym}\n\n` + ui.PROMPTS_POS.entry, ui.cancelRows());
    }
    case 'entry': {
      const v = toNum(text);
      if (!(v > 0) || v > 1e12) {
        return fail(user, chatId, p, 'قیمت ورود باید عددی بزرگ‌تر از صفر باشد.');
      }
      d.entry = v;
      p.step = 'amount';
      return nextStep(user, chatId, p,
        `📍 قیمت ورود: ${fmtPrice(v)}\n\n` + ui.PROMPTS_POS.amount, ui.cancelRows());
    }
    case 'amount': {
      const v = toNum(text);
      if (!(v >= 10 && v <= 100000000)) {
        return fail(user, chatId, p, 'موجودی باید عددی بین 10 تا 100000000 USDT باشد.');
      }
      d.amount = v;
      p.step = 'leverage';
      return nextStep(user, chatId, p,
        `💵 موجودی: ${fmtPrice(v)} USDT\n\n` + ui.PROMPTS_POS.leverage, ui.cancelRows());
    }
    case 'leverage': {
      const v = toNum(text);
      if (!Number.isInteger(v) || v < 1 || v > 50) {
        return fail(user, chatId, p, 'اهرم باید عدد صحیح بین 1 تا 50 باشد.');
      }
      d.leverage = v;
      p.step = 'side';
      const rows = [
        [{ text: '🟢 لانگ (خرید)', callback_data: 'pos_side.long' },
         { text: '🔴 شورت (فروش)', callback_data: 'pos_side.short' }],
        ui.cancelRows()[0],
      ];
      return nextStep(user, chatId, p,
        `💵 موجودی: ${fmtPrice(d.amount)} USDT\n⚡ اهرم: ${v}×\n\n` +
        'کدام‌سو می‌زنی؟', rows);
    }
    default:
      await repo.setPending(user.id, null);
      return ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), p.msgId);
  }
}

/**
 * Side picked (callback pos_side.long / pos_side.short): compute TP/SL from
 * ATR(14) of 1h candles and show the confirmation screen.
 */
export async function setPosSide(user, chatId, side, msgId) {
  const p = user.pending;
  if (!p || p.type !== 'pos_new' || p.step !== 'side' || (side !== 'long' && side !== 'short')) {
    return ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), msgId);
  }
  const d = (p.data = p.data || {});
  d.side = side;
  p.step = 'confirm';
  await ui.editOrSend(chatId,
    '⏳ در حال محاسبه حد سود و ضرر از روی نوسان قیمت (ATR کندل‌های ۱ ساعته)…', null, p.msgId);

  let atr = null;
  let atrSource = null;
  try {
    const r = await getAtr(d.symbol);
    atr = r.atr;
    atrSource = r.source;
  } catch { /* computeTpsl falls back to 3% */ }

  const { takeProfit, stopLoss } = computeTpsl(side, d.entry, atr);
  d.takeProfit = takeProfit;
  d.stopLoss = stopLoss;
  const liq = liqPrice({ side, entryPrice: d.entry, leverage: d.leverage });
  const notional = d.amount * d.leverage;
  const atrLine = atr == null
    ? '⚠️ نوسان‌سنج فعلاً در دسترس نبود؛ حد سود/ضرر با ۳٪ پیش‌فرض گذاشته شد.'
    : `📈 ATR(1h): ${fmtPrice(atr)}${atrSource ? ' (' + atrSource + ')' : ''}  →  حد سود ۲ برابر، حد ضرر ۱ برابر ATR`;

  const text =
    `🧾 مشخصات پوزیشن — ${d.symbol}\n\n` +
    `📍 قیمت ورود: ${fmtPrice(d.entry)}\n` +
    `💵 موجودی (مارژن): ${fmtPrice(d.amount)} USDT\n` +
    `⚡ اهرم: ${d.leverage}×  (ارزش پوزیشن: ${fmtPrice(notional)} USDT)\n` +
    `🎯 حد سود (ربات): ${fmtPrice(takeProfit)}\n` +
    `🛑 حد ضرر (ربات): ${fmtPrice(stopLoss)}\n` +
    `💥 حدود لیکوئید: ${fmtPrice(liq)}\n\n` +
    atrLine + '\n\n' +
    'اگر قیمت حد سود یا حد ضرر را بزند، پوزیشن خودکار بسته و بهت اطلاع می‌دهم. با «✅ باز کن» تأیید کن.';
  const rows = [
    [{ text: '✅ باز کن', callback_data: 'pos_confirm' }],
    ui.cancelRows()[0],
  ];
  const m = await ui.editOrSend(chatId, text, rows, p.msgId);
  p.msgId = m;
  return savePending(user.id, p);
}

/** Confirm (callback pos_confirm): open the position. */
export async function confirmPosOpen(user, chatId, msgId) {
  const p = user.pending;
  if (!p || p.type !== 'pos_new' || p.step !== 'confirm') {
    return ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), msgId);
  }
  const d = p.data;
  await ui.editOrSend(chatId, '⏳ در حال باز کردن پوزیشن…', null, p.msgId);
  try {
    const { pos } = await sim.openPosition(user, d);
    await repo.setPending(user.id, null);
    const text =
      `✅ پوزیشن باز شد!\n\n` +
      `🪙 ${pos.symbol} — ${ui.SIDE_LABEL[pos.side]} ${pos.leverage}×  (ID: ${pos.id})\n` +
      `📍 ورود: ${fmtPrice(pos.entryPrice)} | 💵 مارژن: ${fmtPrice(pos.amountUsdt)} USDT\n` +
      `🎯 حد سود: ${fmtPrice(pos.takeProfit)}\n` +
      `🛑 حد ضرر: ${fmtPrice(pos.stopLoss)}\n\n` +
      'هر بار قیمت یکی از این حدّها را بزند، خودکار بسته و بهت اطلاع می‌دهم.';
    const rows = [
      [{ text: '⚡ پوزیشن‌های من', callback_data: 'positions' }],
      ui.backToMenuRow(),
    ];
    return ui.editOrSend(chatId, text, rows, p.msgId);
  } catch (e) {
    await repo.setPending(user.id, null);
    const rows = [
      [{ text: '⚡ پوزیشن‌های من', callback_data: 'positions' }],
      ui.backToMenuRow(),
    ];
    return ui.editOrSend(chatId, '❌ باز نشد: ' + (e.message || String(e)), rows, p.msgId);
  }
}
