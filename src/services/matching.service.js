'use strict';

const { BET_SIDE } = require('../config/constants');

/* ─────────────────────────────────────────────────────────────
   calculateLiability  — single bet ka liability
   BACK : stake
   LAY  : (price - 1) * stake
────────────────────────────────────────────────────────────── */
function calculateLiability(bet) {
  const price = parseFloat(bet.price);
  const size  = parseFloat(bet.size);
  if (bet.side === BET_SIDE.BACK) return size;
  return (price - 1) * size;
}

/* ─────────────────────────────────────────────────────────────
   evaluateMatch  — orders.js ka checkMatch, SQL backend ke liye
   
   BACK BET MATCHING RULES:
     - selected price > highest available back  → PENDING
     - selected price ≤ highest available back  → MATCHED at highest back
   
   LAY BET MATCHING RULES:
     - selected price < lowest available lay    → PENDING
     - selected price ≥ lowest available lay    → MATCHED at lowest lay
────────────────────────────────────────────────────────────── */
function evaluateMatch(order, runner) {
  let matchedSize   = 0;
  let status        = 'PENDING';
  let executedPrice = parseFloat(order.price);

  const backs = runner.ex?.availableToBack || [];
  const lays  = runner.ex?.availableToLay  || [];
  const selectedPrice = Number(order.price);

  if (order.side === BET_SIDE.BACK || order.type === 'BACK') {
    if (!backs.length) return { matchedSize, status, executedPrice };

    const prices      = backs.map(b => b.price);
    const highestBack = Math.max(...prices);

    if (selectedPrice > highestBack) {
      status = 'PENDING';
    } else {
      executedPrice = highestBack;
      matchedSize   = parseFloat(order.size);
      status        = 'MATCHED';
    }

  } else if (order.side === BET_SIDE.LAY || order.type === 'LAY') {
    if (!lays.length) return { matchedSize, status, executedPrice };

    const prices    = lays.map(l => l.price);
    const lowestLay = Math.min(...prices);

    if (selectedPrice < lowestLay) {
      status = 'PENDING';
    } else {
      executedPrice = lowestLay;
      matchedSize   = parseFloat(order.size);
      status        = 'MATCHED';
    }
  }

  return { matchedSize, status, executedPrice };
}

/* ─────────────────────────────────────────────────────────────
   computeTotalLiability  — green-book + pending combined
   
   MATCHED bets  → market-wise green-book calculation
   PENDING bets  → simple per-bet liability sum
   
   Green-book logic:
     globalPnL = sum of all stake adjustments
     runnerAdj[sel] = runner-specific profit/loss adjustment
     
     For BACK: globalPnL -= size; runnerAdj[sel] += price*size
     For LAY:  globalPnL += size; runnerAdj[sel] -= price*size
     
     Market liability = |min(globalPnL, all runner final PnLs)|
────────────────────────────────────────────────────────────── */
function computeTotalLiability(orders) {
  const matched = orders.filter(o => o.status === 'MATCHED');
  const pending = orders.filter(o => o.status === 'PENDING');

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

      if (bet.side === BET_SIDE.BACK) {
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

module.exports = { calculateLiability, evaluateMatch, computeTotalLiability };
