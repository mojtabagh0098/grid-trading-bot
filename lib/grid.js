// lib/grid.js — pure grid-trading simulation engine (no SDK imports; unit-testable with node).
//
// Model (infinity-style grid):
//   levels[i] = lowerPrice * (1 + i * intervalPct / 100),  i = 0 .. gridCount-1
//   - a limit BUY is resting at each open level
//   - when a buy at level i fills, a SELL is placed one interval above:
//       levels[i+1]  (or levels[last] * (1 + interval) for the top level — the "infinity" tail)
//   - each buy spends exactly deposit / gridCount USDT
//
// Candle path approximation: within one 1m candle we walk
//   bullish: open -> low -> high -> close ; bearish: open -> high -> low -> close,
// starting from the previously persisted price.

export function gridLevels(g) {
  const out = new Array(g.gridCount);
  for (let i = 0; i < g.gridCount; i++) {
    out[i] = g.lowerPrice * (1 + (i * g.intervalPct) / 100);
  }
  return out;
}

// One grid interval above level i. For levels below the top this is exactly
// levels[i+1]; for the top level it extends the arithmetic progression
// (that is what makes the grid "infinite" on the upside).
export function sellTarget(g, levels, i) {
  return g.lowerPrice * (1 + ((i + 1) * g.intervalPct) / 100);
}

/**
 * Advance a grid through a list of 1-minute candles.
 *
 * @param {object} s    grid state:
 *   { lowerPrice, gridCount, intervalPct, deposit,
 *     lastSync (ms), lastPrice, cash, position, costBasis, realized, tradeCount, heldLevels: [] }
 * @param {Array}  klines  [{ t, o, h, l, c }] ascending, all t >= s.lastSync
 * @param {number} [startPrice]  price at s.lastSync when s.lastPrice is unknown
 * @returns {{ lastSync, lastPrice, cash, position, costBasis, realized, tradeCount,
 *             heldLevels: number[], trades: Array<{level, side, price, qty, t}> }}
 */
export function processGrid(s, klines, startPrice) {
  if (!Array.isArray(klines) || klines.length === 0) {
    return {
      lastSync: s.lastSync,
      lastPrice: startPrice != null ? startPrice : s.lastPrice,
      cash: s.cash, position: s.position, costBasis: s.costBasis,
      realized: s.realized, tradeCount: s.tradeCount,
      heldLevels: Array.isArray(s.heldLevels) ? [...s.heldLevels] : [],
      trades: [],
    };
  }

  const levels = gridLevels(s);
  const perGrid = s.deposit / s.gridCount;
  const held = new Set(s.heldLevels);
  const trades = [];
  let { cash, position, costBasis, realized, tradeCount, lastPrice } = s;
  let lastSync = s.lastSync;

  const crossDown = (from, to) => {
    for (let i = levels.length - 1; i >= 0; i--) {
      const p = levels[i];
      if (p >= to && p < from && !held.has(i)) {
        if (cash + 1e-9 < perGrid) continue; // out of budget (float tolerance)
        const qty = perGrid / p;
        cash -= perGrid;
        position += qty;
        costBasis += perGrid;
        held.add(i);
        tradeCount++;
        trades.push({ level: i, side: 'buy', price: p, qty, t: lastSync });
      }
    }
  };

  const crossUp = (from, to) => {
    const open = [...held].sort((a, b) => b - a);
    for (const i of open) {
      const target = sellTarget(s, levels, i);
      if (target > from && target <= to) {
        const qty = perGrid / levels[i];
        cash += qty * target;
        position -= qty;
        costBasis -= perGrid;
        realized += qty * (target - levels[i]);
        held.delete(i);
        tradeCount++;
        trades.push({ level: i, side: 'sell', price: target, qty, t: lastSync });
      }
    }
  };

  const seg = (a, b) => {
    if (b < a) crossDown(a, b);
    else if (b > a) crossUp(a, b);
  };

  for (const k of klines) {
    const path = k.c >= k.o
      ? [[lastPrice, k.l], [k.l, k.h], [k.h, k.c]]
      : [[lastPrice, k.h], [k.h, k.l], [k.l, k.c]];
    for (const [a, b] of path) seg(a, b);
    lastPrice = k.c;
    lastSync = k.t + 60000;
  }

  if (Math.abs(position) < 1e-12) position = 0;
  if (Math.abs(costBasis) < 1e-9) costBasis = 0;
  return {
    lastSync, lastPrice, cash, position, costBasis, realized, tradeCount,
    heldLevels: [...held].sort((a, b) => a - b),
    trades,
  };
}

/** Convenience metrics used by the UI. */
export function gridMetrics(g, currentPrice) {
  const equity = g.cash + g.position * currentPrice;
  const totalPnl = equity - g.deposit;
  return {
    equity,
    totalPnl,
    totalPct: g.deposit > 0 ? (totalPnl / g.deposit) * 100 : 0,
    unrealized: g.position > 0 ? g.position * currentPrice - g.costBasis : 0,
  };
}
