
'use strict';

const { BET_SIDE, ORDER_STATUS } = require('../config/constants');

/* ─────────────────────────────────────────────────────────────
   calculateLiability  — single bet ka liability
   BACK : stake
   LAY  : (price - 1) * stake
────────────────────────────────────────────────────────────── */
function calculateLiability(bet) {
  const price = parseFloat(bet.price);
  const size  = parseFloat(bet.size);
  const side  = normalizeSide(bet.side || bet.type);
  if (side === BET_SIDE.BACK || side === 'BACK') return size;
  return (price - 1) * size;
}

function normalizeSide(side) {
  const s = String(side || '').trim().toUpperCase();
  if (s === 'B' || s === 'BACK' || s === String(BET_SIDE.BACK).toUpperCase()) return 'BACK';
  if (s === 'L' || s === 'LAY'  || s === String(BET_SIDE.LAY).toUpperCase())  return 'LAY';
  return s;
}

/* ─────────────────────────────────────────────────────────────
   evaluateMatch  — orders.js / SQL backend

   BACK BET:
     - selected price > highest available back  → PENDING
     - selected price ≤ highest available back  → MATCHED at highest back

   LAY BET:
     - selected price < lowest available lay    → PENDING
     - selected price ≥ lowest available lay    → MATCHED at lowest lay

   FIXES vs old:
     1) Empty ladder: pehle seedha PENDING return hota tha — board pe
        price dikh ke bhi match nahi hota tha (getRunnerBook aksar
        empty ex deta hai). Ab empty ladder pe requested price pe
        full stake MATCHED (platform scraped-odds model).
     2) side 'B'/'L' / 'b'/'l' normalize
     3) status ORDER_STATUS constants se (string mismatch avoid)
     4) invalid price/size → PENDING
────────────────────────────────────────────────────────────── */
function evaluateMatch(order, runner) {
  let matchedSize   = 0;
  let status        = ORDER_STATUS.PENDING;
  let executedPrice = parseFloat(order.price);

  const selectedPrice = Number(order.price);
  const orderSize     = parseFloat(order.size);

  if (!isFinite(selectedPrice) || selectedPrice <= 1 || !isFinite(orderSize) || orderSize <= 0) {
    return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: selectedPrice || 0 };
  }

  const side  = normalizeSide(order.side || order.type);
  const backs = (runner && runner.ex && Array.isArray(runner.ex.availableToBack))
    ? runner.ex.availableToBack.filter(b => Number(b.price) > 1)
    : [];
  const lays  = (runner && runner.ex && Array.isArray(runner.ex.availableToLay))
    ? runner.ex.availableToLay.filter(l => Number(l.price) > 1)
    : [];

  if (side === 'BACK') {
    // Empty ladder → auto-match at clicked price (scraped board model)
    if (!backs.length) {
      return {
        matchedSize: orderSize,
        status: ORDER_STATUS.MATCHED,
        executedPrice: selectedPrice,
      };
    }
    const prices      = backs.map(b => Number(b.price));
    const highestBack = Math.max(...prices);

    if (selectedPrice > highestBack) {
      status = ORDER_STATUS.PENDING;
      matchedSize = 0;
      executedPrice = selectedPrice;
    } else {
      // Match at best available back (your original rule)
      executedPrice = highestBack;
      matchedSize   = orderSize;
      status        = ORDER_STATUS.MATCHED;
    }
  } else if (side === 'LAY') {
    if (!lays.length) {
      return {
        matchedSize: orderSize,
        status: ORDER_STATUS.MATCHED,
        executedPrice: selectedPrice,
      };
    }
    const prices    = lays.map(l => Number(l.price));
    const lowestLay = Math.min(...prices);

    if (selectedPrice < lowestLay) {
      status = ORDER_STATUS.PENDING;
      matchedSize = 0;
      executedPrice = selectedPrice;
    } else {
      executedPrice = lowestLay;
      matchedSize   = orderSize;
      status        = ORDER_STATUS.MATCHED;
    }
  } else {
    // Unknown side — keep pending
    status = ORDER_STATUS.PENDING;
  }

  return { matchedSize, status, executedPrice };
}

/* ─────────────────────────────────────────────────────────────
   computeTotalLiability  — green-book + pending combined

   MATCHED bets  → market-wise green-book calculation
   PENDING bets  → simple per-bet liability sum
────────────────────────────────────────────────────────────── */
function computeTotalLiability(orders) {
  if (!Array.isArray(orders) || !orders.length) return 0;

  const matched = orders.filter(o => String(o.status).toUpperCase() === 'MATCHED'
    || o.status === ORDER_STATUS.MATCHED);
  const pending = orders.filter(o => String(o.status).toUpperCase() === 'PENDING'
    || o.status === ORDER_STATUS.PENDING);

  let totalLiability = 0;

  // ── MATCHED: market-wise green-book ──────────────────────
  const marketIds = [...new Set(matched.map(o => o.market_id || o.marketId))];
  for (const marketId of marketIds) {
    const marketOrders = matched.filter(o => (o.market_id || o.marketId) === marketId);
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

  // ── PENDING: simple per-bet sum ───────────────────────────
  for (const bet of pending) {
    totalLiability += calculateLiability(bet);
  }

  return totalLiability;
}

module.exports = {
  calculateLiability,
  evaluateMatch,
  computeTotalLiability,
};
