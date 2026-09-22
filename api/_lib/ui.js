import { getGridStats, priceAtIndex } from './simulator.js';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function number(value, digits = 2) {
  if (!Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(Number(value));
}

export function price(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  if (numeric >= 1000) return number(numeric, 2);
  if (numeric >= 1) return number(numeric, 5);
  return number(numeric, 10);
}

export function signed(value, digits = 2) {
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${number(numeric, digits)}`;
}

export function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: '💠 فهرست توکن‌ها', callback_data: 'menu:tokens' }],
      [{ text: '📈 فهرست گریدها و سود', callback_data: 'menu:grids' }],
      [{ text: '🔄 به‌روزرسانی قیمت‌ها', callback_data: 'menu:refresh' }]
    ]
  };
}

export function welcomeText() {
  return [
    '<b>ربات شبیه‌ساز Infinity Grid آماده است.</b>',
    '',
    '• منبع قیمت: <b>Binance Spot / USDT</b>',
    '• فقط شبیه‌سازی است؛ هیچ سفارش واقعی یا اتصال API صرافی انجام نمی‌شود.',
    '• برای دقت بهتر، گریدها با Cron همگام‌سازی می‌شوند.',
    '',
    'یکی از منوها را انتخاب کنید.'
  ].join('\n');
}

export function tokensMenu(tokens) {
  const rows = [
    [{ text: '➕ افزودن توکن', callback_data: 'tok:add' }],
    [{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]
  ];
  for (const token of tokens) {
    rows.splice(rows.length - 1, 0, [{ text: `💠 ${token.symbol} / USDT`, callback_data: `tok:view:${token.symbol}` }]);
  }
  return rows;
}

export function tokensText(tokens) {
  if (!tokens.length) {
    return '<b>فهرست توکن‌ها خالی است.</b>\nبا «افزودن توکن» یک نماد Spot در Binance، مانند BTC یا ETH، ثبت کنید.';
  }
  return `<b>توکن‌های ثبت‌شده (${tokens.length})</b>\nبرای ویرایش یا حذف، روی یک توکن بزنید.`;
}

export function tokenDetailText(token) {
  return `<b>${escapeHtml(token.symbol)} / USDT</b>\nنماد در Binance Spot ثبت شده است.`;
}

export function tokenDetailKeyboard(token) {
  return {
    inline_keyboard: [
      [
        { text: '✏️ ویرایش نماد', callback_data: `tok:edit:${token.symbol}` },
        { text: '🗑 حذف', callback_data: `tok:delete:${token.symbol}` }
      ],
      [{ text: '◀️ بازگشت به توکن‌ها', callback_data: 'menu:tokens' }]
    ]
  };
}

export function tokenDeleteKeyboard(symbol) {
  return {
    inline_keyboard: [
      [
        { text: 'بله، حذف شود', callback_data: `tok:confirmdelete:${symbol}` },
        { text: 'خیر', callback_data: `tok:view:${symbol}` }
      ]
    ]
  };
}

export function gridCreateTokenKeyboard(tokens) {
  const rows = tokens.map((token) => [{ text: `${token.symbol} / USDT`, callback_data: `gc:${token.symbol}` }]);
  rows.push([{ text: '◀️ بازگشت', callback_data: 'menu:grids' }]);
  return { inline_keyboard: rows };
}

function gridLabel(grid) {
  const stats = getGridStats(grid);
  const pnlIcon = stats.totalPnl > 0 ? '🟢' : stats.totalPnl < 0 ? '🔴' : '⚪️';
  const status = grid.status === 'active' ? 'فعال' : 'متوقف';
  return `${pnlIcon} ${grid.symbol} | ${signed(stats.totalPnl)} USDT | ${status}`;
}

export function gridsText(grids) {
  if (!grids.length) return '<b>هنوز گریدی ثبت نشده است.</b>\nابتدا یک توکن ثبت کنید، سپس گرید بسازید.';
  const totalEquity = grids.reduce((sum, grid) => sum + getGridStats(grid).equity, 0);
  const totalDeposit = grids.reduce((sum, grid) => sum + grid.deposit, 0);
  const totalPnl = totalEquity - totalDeposit;
  return [
    `<b>گریدهای ثبت‌شده (${grids.length})</b>`,
    `سرمایهٔ اولیه: <b>${number(totalDeposit)} USDT</b>`,
    `ارزش فعلی: <b>${number(totalEquity)} USDT</b>`,
    `سود/زیان کل: <b>${signed(totalPnl)} USDT</b>`,
    '',
    'برای جزئیات هر گرید روی آن بزنید.'
  ].join('\n');
}

export function gridsKeyboard(grids, tokens) {
  const rows = grids.map((grid) => [{ text: gridLabel(grid), callback_data: `grid:view:${grid.id}` }]);
  if (tokens.length) rows.push([{ text: '➕ ساخت گرید جدید', callback_data: 'grid:add' }]);
  rows.push([{ text: '🏠 منوی اصلی', callback_data: 'menu:home' }]);
  return { inline_keyboard: rows };
}

export function gridDetailText(grid) {
  const stats = getGridStats(grid);
  const upper = priceAtIndex(grid.lowerPrice, grid.factor, grid.totalGridNumber);
  const recent = grid.recentTrades.slice(0, 5);
  const lines = [
    `<b>📈 ${escapeHtml(grid.symbol)} / USDT</b>  |  ${grid.status === 'active' ? '🟢 فعال' : '⏸ متوقف'}`,
    '',
    `<b>قیمت فعلی:</b> ${price(grid.lastPrice)} USDT`,
    `<b>Deposit اولیه:</b> ${number(grid.deposit)} USDT`,
    `<b>ارزش فعلی پورتفو:</b> ${number(stats.equity)} USDT`,
    `<b>سود/زیان کل:</b> ${signed(stats.totalPnl)} USDT (${signed(stats.totalPnlPct)}%)`,
    `<b>سود تحقق‌یافته:</b> ${signed(grid.realizedPnl)} USDT`,
    `<b>سود/زیان باز:</b> ${signed(stats.unrealizedPnl)} USDT`,
    '',
    `<b>USDT آزاد:</b> ${number(grid.quoteBalance)} | <b>${escapeHtml(grid.symbol)}:</b> ${number(grid.baseBalance, 8)}`,
    `<b>تعداد معامله:</b> ${grid.tradeCount} | <b>کارمزد شبیه‌سازی:</b> ${number(grid.feesPaid, 4)} USDT`,
    `<b>پله‌های باز:</b> ${stats.openLots}/${grid.totalGridNumber}`,
    '',
    `<b>Lower:</b> ${price(grid.lowerPrice)} | <b>Interval:</b> ${number(grid.gridIntervalPct, 4)}%`,
    `<b>Grid number:</b> ${grid.totalGridNumber} | <b>سقف اولیهٔ نمایشی:</b> ${price(upper)}`,
    '<i>سقف عملیاتی ندارد و با حرکت قیمت به بالا توسعه می‌یابد.</i>',
    grid.belowLower ? '\n⚠️ قیمت پایین‌تر از Lower است؛ تا بازگشت به محدوده، خرید جدیدی ثبت نمی‌شود.' : '',
    grid.missedGridSteps ? `\n⚠️ ${grid.missedGridSteps} پلهٔ بسیار سریع پردازش نشده است.` : ''
  ];

  if (recent.length) {
    lines.push('', '<b>۵ رویداد آخر:</b>');
    for (const trade of recent) {
      const pnl = trade.pnl === null ? '' : ` | PnL ${signed(trade.pnl, 4)}`;
      lines.push(`• ${trade.side === 'BUY' ? 'خرید' : 'فروش'} @ ${price(trade.price)} | ${number(trade.quantity, 8)} ${escapeHtml(grid.symbol)}${pnl}`);
    }
  }
  return lines.filter(Boolean).join('\n');
}

export function gridDetailKeyboard(grid) {
  const control = grid.status === 'active'
    ? { text: '⏸ توقف گرید', callback_data: `grid:pause:${grid.id}` }
    : { text: '▶️ شروع مجدد', callback_data: `grid:resume:${grid.id}` };
  return {
    inline_keyboard: [
      [{ text: '🔄 به‌روزرسانی این گرید', callback_data: `grid:refresh:${grid.id}` }],
      [control, { text: '🗑 حذف گرید', callback_data: `grid:delete:${grid.id}` }],
      [{ text: '◀️ بازگشت به گریدها', callback_data: 'menu:grids' }]
    ]
  };
}

export function gridDeleteKeyboard(id) {
  return {
    inline_keyboard: [
      [
        { text: 'بله، حذف گرید', callback_data: `grid:confirmdelete:${id}` },
        { text: 'خیر', callback_data: `grid:view:${id}` }
      ]
    ]
  };
}
