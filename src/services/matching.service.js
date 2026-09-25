
'use strict';

const { BET_SIDE, ORDER_STATUS } = require('../config/constants');

/* ─────────────────────────────────────────────────────────────
   MARKET KIND DETECTION
   Match Odds / Toss / Bookmaker → exchange decimal math
   Fancy / Fancy2                → Indian line (Yes/No) math
────────────────────────────────────────────────────────────── */
function detectMarketKind(betOrMeta = {}) {
  const name = String(
    betOrMeta.marketName || betOrMeta.market_name ||
    betOrMeta.runnerName || betOrMeta.runner_name || ''
  ).toLowerCase();
  const cat = String(
    betOrMeta.category || betOrMeta.marketType || betOrMeta.market_type ||
    betOrMeta.bettingType || ''
  ).toLowerCase();
  const flags = betOrMeta;

  if (flags.isFancy2 || /fancy\s*[-_]?2|fancy2|local\s*fancy/.test(cat + ' ' + name)) {
    return 'FANCY2';
  }
  if (
    flags.isFancy || flags.isLocalFancy || flags.hasFancyOdds ||
    /(^|[^a-z])fancy([^a-z]|$)/.test(cat) ||
    /\bfancy\b/.test(name) ||
    /session|over runs|wkt|wicket|only overs|boundaries|balls face|fall of/.test(name)
  ) {
    return 'FANCY';
  }
  if (/bookmaker|\bbm\b/.test(cat + ' ' + name) || flags.isBmMarket) return 'BOOKMAKER';
  if (/\btoss\b/.test(cat + ' ' + name)) return 'TOSS';
  return 'EXCHANGE';
}

function normalizeSide(side) {
  const s = String(side || '').trim().toUpperCase();
  if (s === 'B' || s === 'BACK' || s === String(BET_SIDE.BACK).toUpperCase()) return 'BACK';
  if (s === 'L' || s === 'LAY'  || s === String(BET_SIDE.LAY).toUpperCase())  return 'LAY';
  return s;
}

function isRatePrice(price) {
  const p = Number(price);
  return isFinite(p) && p >= 50 && p <= 1000;
}

function winProfit(price, size) {
  const p = Number(price);
  const s = Number(size);
  if (!isFinite(p) || !isFinite(s) || s <= 0) return 0;
  if (isRatePrice(p)) return s * (p / 100);
  return s * (p - 1);
}

function layLoss(price, size) {
  return winProfit(price, size);
}

/* ─────────────────────────────────────────────────────────────
   calculateLiability

   EXCHANGE / BOOKMAKER / TOSS:
     BACK → stake
     LAY  → (price - 1) * stake  (or rate/100 * stake)

   FANCY / FANCY2 (Yes/No line):
     BACK (Yes) → stake
     LAY  (No)  → winProfit(price, size)
────────────────────────────────────────────────────────────── */
function calculateLiability(bet) {
  const price = parseFloat(bet.price);
  const size  = parseFloat(bet.size);
  const side  = normalizeSide(bet.side || bet.type);
  const kind  = detectMarketKind(bet);

  if (!isFinite(price) || !isFinite(size) || size <= 0) return 0;

  if (side === 'BACK' || side === BET_SIDE.BACK) {
    return size;
  }

  if (kind === 'FANCY' || kind === 'FANCY2') {
    return layLoss(price, size);
  }
  if (isRatePrice(price)) return size * (price / 100);
  return Math.max(0, (price - 1) * size);
}

/* ─────────────────────────────────────────────────────────────
   evaluateMatch
────────────────────────────────────────────────────────────── */
function evaluateMatch(order, runner) {
  let matchedSize   = 0;
  let status        = ORDER_STATUS.PENDING;
  let executedPrice = parseFloat(order.price);

  const selectedPrice = Number(order.price);
  const orderSize     = parseFloat(order.size);
  const kind          = detectMarketKind(order);

  if (!isFinite(orderSize) || orderSize <= 0) {
    return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice || 0 };
  }

  const minPrice = (kind === 'FANCY' || kind === 'FANCY2') ? 0.01 : 1;
  if (!isFinite(selectedPrice) || selectedPrice <= minPrice) {
    return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice || 0 };
  }

  const side  = normalizeSide(order.side || order.type);
  const backs = (runner && runner.ex && Array.isArray(runner.ex.availableToBack))
    ? runner.ex.availableToBack.filter(b => Number(b.price) > minPrice)
    : [];
  const lays  = (runner && runner.ex && Array.isArray(runner.ex.availableToLay))
    ? runner.ex.availableToLay.filter(l => Number(l.price) > minPrice)
    : [];

  if (kind === 'FANCY' || kind === 'FANCY2') {
    if (side === 'BACK') {
      if (!backs.length) {
        return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: selectedPrice };
      }
      const bestBack = Math.max(...backs.map(b => Number(b.price)));
      if (selectedPrice <= bestBack) {
        return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: bestBack };
      }
      return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice };
    }
    if (side === 'LAY') {
      if (!lays.length) {
        return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: selectedPrice };
      }
      const bestLay = Math.min(...lays.map(l => Number(l.price)));
      if (selectedPrice >= bestLay) {
        return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: bestLay };
      }
      return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice };
    }
    return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice };
  }

  if (side === 'BACK') {
    if (!backs.length) {
      return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: selectedPrice };
    }
    const highestBack = Math.max(...backs.map(b => Number(b.price)));
    if (selectedPrice > highestBack) {
      return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice };
    }
    return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: highestBack };
  }

  if (side === 'LAY') {
    if (!lays.length) {
      return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: selectedPrice };
    }
    const lowestLay = Math.min(...lays.map(l => Number(l.price)));
    if (selectedPrice < lowestLay) {
      return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice };
    }
    return { matchedSize: orderSize, status: ORDER_STATUS.MATCHED, executedPrice: lowestLay };
  }

  return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice };
}

function settlePnL(bet, winnerSelectionId) {
  const price = Number(bet.price);
  const size  = Number(bet.matched || bet.size || 0);
  const side  = normalizeSide(bet.side || bet.type);
  const sel   = String(bet.selection_id || bet.selectionId || '');
  const winSel = String(winnerSelectionId || '');
  const won   = sel === winSel;

  if (!isFinite(size) || size <= 0) return 0;

  if (side === 'BACK') {
    return won ? winProfit(price, size) : -size;
  }
  return won ? -layLoss(price, size) : size;
}

function computeTotalLiability(orders) {
  if (!Array.isArray(orders) || !orders.length) return 0;

  const matched = orders.filter(o =>
    String(o.status).toUpperCase() === 'MATCHED' || o.status === ORDER_STATUS.MATCHED);
  const pending = orders.filter(o =>
    String(o.status).toUpperCase() === 'PENDING' || o.status === ORDER_STATUS.PENDING);

  let totalLiability = 0;

  const marketIds = [...new Set(matched.map(o => o.market_id || o.marketId))];
  for (const marketId of marketIds) {
    const marketOrders = matched.filter(o => (o.market_id || o.marketId) === marketId);
    if (!marketOrders.length) continue;

    const kind = detectMarketKind(marketOrders[0]);

    if (kind === 'FANCY' || kind === 'FANCY2') {
      const sels = [...new Set(marketOrders.map(b => String(b.selection_id || b.selectionId)))];
      let worst = 0;
      for (const winSel of sels) {
        let pnl = 0;
        for (const bet of marketOrders) {
          pnl += settlePnL(bet, winSel);
        }
        if (pnl < worst) worst = pnl;
      }
      if (sels.length === 1) {
        let pnlBack = 0;
        let pnlLay  = 0;
        for (const bet of marketOrders) {
          const side = normalizeSide(bet.side || bet.type);
          const price = Number(bet.price);
          const size  = Number(bet.matched || bet.size);
          if (side === 'BACK') {
            pnlBack += winProfit(price, size);
            pnlLay  -= size;
          } else {
            pnlBack -= layLoss(price, size);
            pnlLay  += size;
          }
        }
        worst = Math.min(worst, pnlBack, pnlLay);
      }
      if (worst < 0) totalLiability += Math.abs(worst);
      continue;
    }

    let globalPnL = 0;
    const runnerAdj = {};

    for (const bet of marketOrders) {
      const sel   = String(bet.selection_id || bet.selectionId);
      const price = Number(bet.price);
      const size  = Number(bet.matched || bet.size);
      const side  = normalizeSide(bet.side || bet.type);

      if (side === 'BACK') {
        globalPnL -= size;
        runnerAdj[sel] = (runnerAdj[sel] || 0) + price * size;
      } else {
        globalPnL += size;
        runnerAdj[sel] = (runnerAdj[sel] || 0) - price * size;
      }
    }

    const potentials = [globalPnL, ...Object.values(runnerAdj).map(adj => globalPnL + adj)];
    const worstCase  = Math.min(...potentials);
    totalLiability  += worstCase < 0 ? Math.abs(worstCase) : 0;
  }

  for (const bet of pending) {
    totalLiability += calculateLiability(bet);
  }

  return totalLiability;
}

module.exports = {
  calculateLiability,
  evaluateMatch,
  computeTotalLiability,
  detectMarketKind,
  settlePnL,
  winProfit,
  layLoss,
  isRatePrice,
  normalizeSide,
};
