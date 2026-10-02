// lib/bot.js — routes incoming Telegram updates to the message/callback logic.

import * as repo from './repo.js';
import * as ui from './tg.js';
import * as flow from './flow.js';
import * as sim from './sim.js';
import { getTicker } from './prices.js';

const FRESH_MS = 5 * 60000;
const MAX_BACKGROUND_GRIDS = 5;
const MAX_CATCHUP_GAP = 3 * 24 * 3600e3;

export async function handleUpdate(update) {
  if (update.message) return handleIncomingMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
}

// ---------- messages (commands + flow inputs) ----------

async function handleIncomingMessage(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].toLowerCase();
    const user = await repo.getUser(message.from.id);

    if (cmd === '/cancel' || cmd === '/start' || cmd === '/menu') {
      if (user.pending) await repo.setPending(user.id, null);
      return ui.sendMain(chatId);
    }
    if (cmd === '/help') {
      const rows = [[{ text: '🏠 منو', callback_data: 'main' }]];
      await ui.editOrSend(chatId, ui.HELP_TEXT, rows, null);
      return;
    }
    await ui.api.sendMessage({
      chat_id: chatId,
      text: '🤔 این دستور را نمی‌شناسم. /menu را بزن تا منو را ببینی.',
    });
    return;
  }

  if (!text) return; // non-text messages are ignored

  const user = await repo.getUser(message.from.id);
  if (user.pending) return flow.handleText(user, chatId, text);
  return ui.sendMain(chatId);
}

// ---------- inline button presses ----------

async function handleCallback(cq) {
  const chatId = cq.message.chat.id;
  const msgId = cq.message.message_id;
  const data = cq.data || '';
  const user = await repo.getUser(cq.from.id);

  let answered = false;
  const answer = (text) => {
    if (answered) return;
    answered = true;
    ui.api.answerCallbackQuery({ callback_query_id: cq.id, text }).catch(() => {});
  };

  try {
    const dot = data.indexOf('.');
    const head = dot === -1 ? data : data.slice(0, dot);
    const arg = dot === -1 ? '' : data.slice(dot + 1);

    switch (head) {
      case 'main':
        await ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), msgId);
        break;

      case 'help':
        await ui.editOrSend(chatId, ui.HELP_TEXT, [[{ text: '🏠 منو', callback_data: 'main' }]], msgId);
        break;

      case 'tokens':
        await ui.showTokenList(user, chatId, msgId);
        break;

      case 'add_token':
        await ui.editOrSend(chatId, ui.PROMPT_ADD_TOKEN, ui.cancelRows(), msgId);
        await repo.setPending(user.id, { type: 'add_token', step: 'symbol', msgId, data: {} });
        break;

      case 'token_edit': {
        if (!(await repo.getToken(user.tgId, arg))) { answer('پیدا نشد'); break; }
        await ui.editOrSend(chatId,
          `✏️ نماد جدید برای ${arg} را بنویس.\n(نماد باید در صرافی‌های پشتیبانی‌شده با جفت USDT باشد)`,
          ui.cancelRows(), msgId);
        await repo.setPending(user.id, { type: 'edit_token', step: 'symbol', msgId, data: { old: arg } });
        break;
      }

      case 'token_del':
        await ui.confirmTokenDel(user, chatId, msgId, arg);
        break;

      case 'token_del_y': {
        await repo.deleteToken(user.tgId, arg);
        await ui.showTokenList(user, chatId, msgId, `✅ توکن ${arg} حذف شد.`);
        break;
      }

      case 'grids':
        await ui.showGridList(user, chatId, msgId);
        break;

      case 'grid_new':
        await flow.startGridFlow(user, chatId, msgId);
        break;

      case 'grid_pick':
        await flow.pickGridToken(user, chatId, arg, msgId);
        break;

      case 'grid_info':
        await ui.showGridDetail(user, chatId, msgId, +arg);
        break;

      case 'grid_stop': {
        const g = await repo.getGrid(user.tgId, +arg);
        if (!g) { answer('گرید پیدا نشد'); break; }
        if (g.active) {
          await repo.setGridState(g.id, { active: false });
          await ui.showGridList(user, chatId, msgId, `🛑 شبیه‌سازی گرید ${g.symbol} متوقف شد.`);
        } else {
          await repo.setGridState(g.id, { active: true });
          try {
            await sim.syncGrid(user.tgId, g); // catch up on the missed candles
            await ui.showGridList(user, chatId, msgId, `▶️ گرید ${g.symbol} از سر گرفته شد و به‌روز شد.`);
          } catch (e) {
            console.error('resume sync failed', e);
            await ui.showGridList(user, chatId, msgId, `▶️ گرید ${g.symbol} از سر گرفته شد (به‌روزرسانی قیمت بعدی بار).`);
          }
        }
        break;
      }

      case 'grid_del':
        await ui.confirmGridDel(user, chatId, msgId, +arg);
        break;

      case 'grid_del_y': {
        const g = await repo.getGrid(user.tgId, +arg);
        if (!g) { answer('گرید پیدا نشد'); break; }
        await repo.deleteTradesOfGrid(g.id);
        await repo.deleteGrid(g.id);
        await ui.showGridList(user, chatId, msgId, `🗑 گرید ${g.symbol} (ID: ${g.id}) حذف شد.`);
        break;
      }

      case 'positions':
      case 'pos_refresh':
        await ui.showPositions(user, chatId, msgId);
        break;

      case 'pos_new':
        await flow.startPosFlow(user, chatId, msgId);
        break;

      case 'pos_pick':
        await flow.pickPosToken(user, chatId, arg, msgId);
        break;

      case 'pos_side':
        await flow.setPosSide(user, chatId, arg, msgId);
        break;

      case 'pos_confirm':
        await flow.confirmPosOpen(user, chatId, msgId);
        break;

      case 'pos_history':
        await ui.showPosHistory(user, chatId, msgId);
        break;

      case 'pos_close':
        await ui.confirmPosClose(user, chatId, msgId, +arg);
        break;

      case 'pos_close_y': {
        const p = await repo.getPosition(user.tgId, +arg);
        if (!p || p.status !== 'open') {
          await ui.showPositions(user, chatId, msgId, '⚠️ این پوزیشن دیگر باز نیست.');
          break;
        }
        let price = p.lastPrice > 0 ? p.lastPrice : p.entryPrice;
        try {
          price = (await getTicker(p.symbol)).price; // best effort: live price for the fill
        } catch { /* fall back to last known */ }
        const done = await sim.closePosition(user.tgId, p.id, { reason: 'manual', price, last: price });
        await ui.showPositions(user, chatId, msgId,
          done ? ui.positionClosedText(done) : '⚠️ این پوزیشن همین لحظه بسته شده بود.');
        break;
      }

      case 'flow_cancel':
        await repo.setPending(user.id, null);
        await ui.editOrSend(chatId, ui.MAIN_TEXT, ui.mainRows(), msgId);
        break;

      default:
        break; // unknown callback data -> ignore
    }
  } catch (e) {
    console.error('callback error', data, e);
    try {
      await ui.editOrSend(chatId, '❌ خطایی رخ داد: ' + (e.message || String(e)), ui.cancelRows(), msgId);
    } catch { /* nothing more we can do */ }
  } finally {
    answer('⏳');
  }
}

// ---------- opportunistic background simulation ----------
// Runs (fire-and-forget) after a user's text message: keeps grids fresh while
// the user is around, without blocking the main reply.

export async function backgroundSyncForUser(tgId) {
  try {
    const grids = await repo.getActiveGrids(tgId);
    const now = Date.now();
    for (const g of grids.slice(0, MAX_BACKGROUND_GRIDS)) {
      const gap = now - (g.lastSync || 0);
      if (gap > FRESH_MS && gap < MAX_CATCHUP_GAP) {
        await sim.syncGrid(g.userId, g);
      }
    }
  } catch (e) {
    console.warn('background sync failed:', e.message);
  }
  // positions: close TP/SL/liq hits and notify, even between user messages
  try {
    const r = await sim.checkUserPositions(tgId, 15000);
    if (r.closed.length) console.log('background: closed positions', r.closed.map((c) => c.pos.id));
  } catch (e) {
    console.warn('background position check failed:', e.message);
  }
}
