import { normalizeSymbol, pairFor } from './market.js';

const MAX_STEPS_PER_SYNC = 1_000;
const EPSILON = 1e-10;

function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} باید بزرگ‌تر از صفر باشد.`);
}

function asFiniteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} معتبر نیست.`);
  return number;
}

function cleanNumber(value) {
  return Math.abs(value) < EPSILON ? 0 : value;
}

export function priceAtIndex(lowerPrice, factor, index) {
  const result = lowerPrice * Math.pow(factor, index);
  if (!Number.isFinite(result) || result <= 0) throw new Error('قیمت یکی از پله‌های گرید قابل محاسبه نیست.');
  return result;
}

export function gridIndexForPrice(grid, marketPrice) {
  if (marketPrice < grid.lowerPrice) return -1;
  const raw = Math.log(marketPrice / grid.lowerPrice) / Math.log(grid.factor);
  return Math.max(0, Math.floor(raw + EPSILON));
}

function addTrade(grid, trade) {
  grid.tradeCount += 1;
  grid.volumeQuote += trade.grossQuote;
  grid.recentTrades.unshift(trade);
  grid.recentTrades = grid.recentTrades.slice(0, 20);
}

function buyAtIndex(grid, index, timestamp) {
  if (grid.lots.length >= grid.totalGridNumber) return false;
  const price = priceAtIndex(grid.lowerPrice, grid.factor, index);
  const feeMultiplier = 1 + grid.feeRatePct / 100;
  const grossQuote = Math.min(grid.orderQuote, grid.quoteBalance / feeMultiplier);
  if (grossQuote <= EPSILON) return false;

  const fee = grossQuote * grid.feeRatePct / 100;
  const quantity = grossQuote / price;
  const costQuote = grossQuote + fee;
  const lot = {
    quantity,
    costQuote,
    entryPrice: price,
    entryGridIndex: index,
    targetIndex: index + 1,
    openedAt: timestamp
  };
  grid.lots.push(lot);
  grid.quoteBalance = cleanNumber(grid.quoteBalance - costQuote);
  grid.baseBalance += quantity;
  grid.baseCostQuote += costQuote;
  grid.feesPaid += fee;
  addTrade(grid, {
    side: 'BUY',
    gridIndex: index,
    price,
    quantity,
    grossQuote,
    fee,
    pnl: null,
    at: timestamp
  });
  return true;
}

function sellAtIndex(grid, index, timestamp) {
  const matchingLots = grid.lots.filter((lot) => lot.targetIndex === index);
  if (!matchingLots.length) return false;

  const retainedLots = grid.lots.filter((lot) => lot.targetIndex !== index);
  const quantity = matchingLots.reduce((sum, lot) => sum + lot.quantity, 0);
  const costQuote = matchingLots.reduce((sum, lot) => sum + lot.costQuote, 0);
  if (quantity <= EPSILON) return false;

  const price = priceAtIndex(grid.lowerPrice, grid.factor, index);
  const grossQuote = quantity * price;
  const fee = grossQuote * grid.feeRatePct / 100;
  const netQuote = grossQuote - fee;
  const pnl = netQuote - costQuote;

  grid.lots = retainedLots;
  grid.baseBalance = cleanNumber(grid.baseBalance - quantity);
  grid.baseCostQuote = cleanNumber(grid.baseCostQuote - costQuote);
  grid.quoteBalance += netQuote;
  grid.realizedPnl += pnl;
  grid.feesPaid += fee;
  addTrade(grid, {
    side: 'SELL',
    gridIndex: index,
    price,
    quantity,
    grossQuote,
    fee,
    pnl,
    at: timestamp
  });
  return true;
}

/**
 * Creates a paper-only, upward-extending grid.
 * Deposit is split into equal grid tranches. Half of the capacity is seeded as
 * BTC/alt inventory at the current market price and the rest is held in USDT.
 * Every buy made on a downward crossing is assigned a sell target one level above.
 */
export function buildGrid(input) {
  const symbol = normalizeSymbol(input.symbol);
  const deposit = asFiniteNumber(input.deposit, 'Deposit');
  const lowerPrice = asFiniteNumber(input.lowerPrice, 'Lower price');
  const totalGridNumber = asFiniteNumber(input.totalGridNumber, 'Total grid number');
  const gridIntervalPct = asFiniteNumber(input.gridIntervalPct, 'Grid interval');
  const startPrice = asFiniteNumber(input.startPrice, 'قیمت فعلی');
  const feeRatePct = asFiniteNumber(input.feeRatePct ?? 0.1, 'کارمزد');

  assertPositive(deposit, 'Deposit');
  assertPositive(lowerPrice, 'Lower price');
  assertPositive(startPrice, 'قیمت فعلی');
  if (!Number.isInteger(totalGridNumber) || totalGridNumber < 2 || totalGridNumber > 500) {
    throw new Error('Total grid number باید یک عدد صحیح بین ۲ تا ۵۰۰ باشد.');
  }
  if (gridIntervalPct < 0.1 || gridIntervalPct > 50) {
    throw new Error('Grid interval باید بین ۰.۱ تا ۵۰ درصد باشد.');
  }
  if (feeRatePct < 0 || feeRatePct > 5) throw new Error('کارمزد باید بین ۰ تا ۵ درصد باشد.');
  if (lowerPrice >= startPrice) throw new Error('Lower price باید از قیمت فعلی بازار کمتر باشد.');

  const factor = 1 + gridIntervalPct / 100;
  const initialGridIndex = Math.max(0, Math.floor(Math.log(startPrice / lowerPrice) / Math.log(factor) + EPSILON));
  const orderQuote = deposit / totalGridNumber;
  const seedLotCount = Math.max(1, Math.floor(totalGridNumber / 2));
  const initialGrossBaseQuote = orderQuote * seedLotCount;
  const initialFee = initialGrossBaseQuote * feeRatePct / 100;
  const basePerLot = orderQuote / startPrice;
  const now = new Date().toISOString();
  const lots = Array.from({ length: seedLotCount }, (_, offset) => ({
    quantity: basePerLot,
    costQuote: orderQuote * (1 + feeRatePct / 100),
    entryPrice: startPrice,
    entryGridIndex: initialGridIndex,
    targetIndex: initialGridIndex + offset + 1,
    openedAt: now,
    seed: true
  }));

  return {
    symbol,
    pair: pairFor(symbol),
    status: 'active',
    deposit,
    lowerPrice,
    totalGridNumber,
    gridIntervalPct,
    factor,
    feeRatePct,
    orderQuote,
    initialGridIndex,
    initialUpperPrice: priceAtIndex(lowerPrice, factor, totalGridNumber),
    startPrice,
    lastPrice: startPrice,
    lastGridIndex: initialGridIndex,
    quoteBalance: deposit - initialGrossBaseQuote - initialFee,
    baseBalance: basePerLot * seedLotCount,
    baseCostQuote: initialGrossBaseQuote + initialFee,
    realizedPnl: 0,
    feesPaid: initialFee,
    tradeCount: 0,
    volumeQuote: 0,
    lots,
    recentTrades: [],
    missedGridSteps: 0,
    belowLower: false,
    startedAt: now,
    lastSyncAt: now
  };
}

/** Mutates and returns grid after applying all observable price crossings. */
export function syncGrid(grid, marketPrice, timestamp = new Date().toISOString()) {
  if (grid.status !== 'active') return grid;
  assertPositive(marketPrice, 'قیمت بازار');
  const currentIndex = gridIndexForPrice(grid, marketPrice);
  grid.lastPrice = marketPrice;
  grid.lastSyncAt = timestamp;

  // The configured lower price is a hard floor: no new buys are made below it.
  if (currentIndex < 0) {
    grid.lastGridIndex = -1;
    grid.belowLower = true;
    return grid;
  }

  // Returning from below the floor re-anchors the watcher; no imaginary fill is created.
  if (grid.lastGridIndex < 0) {
    grid.lastGridIndex = currentIndex;
    grid.belowLower = false;
    return grid;
  }

  const previousIndex = grid.lastGridIndex;
  const difference = Math.abs(currentIndex - previousIndex);
  const stepsToProcess = Math.min(difference, MAX_STEPS_PER_SYNC);
  if (difference > MAX_STEPS_PER_SYNC) grid.missedGridSteps += difference - MAX_STEPS_PER_SYNC;

  if (currentIndex > previousIndex) {
    for (let index = previousIndex + 1; index <= previousIndex + stepsToProcess; index += 1) {
      sellAtIndex(grid, index, timestamp);
    }
  } else if (currentIndex < previousIndex) {
    for (let index = previousIndex; index > previousIndex - stepsToProcess; index -= 1) {
      buyAtIndex(grid, index, timestamp);
    }
  }

  // The level sequence has no top cap: this is the automatic upward extension.
  grid.lastGridIndex = currentIndex;
  grid.belowLower = false;
  return grid;
}

export function getGridStats(grid, marketPrice = grid.lastPrice) {
  const assetValue = grid.baseBalance * marketPrice;
  const equity = grid.quoteBalance + assetValue;
  const unrealizedPnl = assetValue - grid.baseCostQuote;
  const totalPnl = equity - grid.deposit;
  return {
    assetValue,
    equity,
    unrealizedPnl,
    totalPnl,
    totalPnlPct: (totalPnl / grid.deposit) * 100,
    openLots: grid.lots.length
  };
}
