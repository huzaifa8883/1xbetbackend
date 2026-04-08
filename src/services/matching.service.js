'use strict';

const { BET_SIDE } = require('../config/constants');

/* ── Liability for a single bet ─────────────────────────── */
function calculateLiability(bet) {
  const price = parseFloat(bet.price);
  const size  = parseFloat(bet.size);
  if (bet.side === BET_SIDE.BACK) return size;           // BACK: stake
  return (price - 1) * size;                             // LAY: (price-1)*stake
}

/* ── evaluateMatch (aka checkMatch from orders.js) ──────── */
function evaluateMatch(order, runner) {
  let matchedSize  = 0;
  let status       = 'PENDING';
  let executedPrice = parseFloat(order.price);

  const backs = runner.ex?.availableToBack || [];
  const lays  = runner.ex?.availableToLay  || [];
  const selectedPrice = Number(order.price);

  if (order.side === BET_SIDE.BACK || order.type === 'BACK') {
    if (!backs.length) return { matchedSize, status, executedPrice };
    const prices      = backs.map(b => b.price);
    const highestBack = Math.max(...prices);
    const lowestBack  = Math.min(...prices);

    // Rule 1: selected ≤ lowest → MATCHED at highest back
    // Rule 2: selected > highest → PENDING
    // Rule 3: between → MATCHED at highest back
    if (selectedPrice > highestBack) {
      status = 'PENDING';
    } else {
      executedPrice = highestBack;
      matchedSize   = parseFloat(order.size);
      status        = 'MATCHED';
    }
  } else if (order.side === BET_SIDE.LAY || order.type === 'LAY') {
    if (!lays.length) return { matchedSize, status, executedPrice };
    const prices     = lays.map(l => l.price);
    const lowestLay  = Math.min(...prices);
    const highestLay = Math.max(...prices);

    // Rule 1: selected ≥ highest → MATCHED at lowest lay
    // Rule 2: selected < lowest  → PENDING
    // Rule 3: between → MATCHED at lowest lay
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

/* ── computeTotalLiability (green-book + pending) ───────── */
// Exact port of recalculateUserLiableAndPnL logic from orders.js
function computeTotalLiability(orders) {
  const matched = orders.filter(o => o.status === 'MATCHED');
  const pending = orders.filter(o => o.status === 'PENDING');

  let totalLiability = 0;

  // --- MATCHED: market-wise green-book ---
  const markets = [...new Set(matched.map(o => o.market_id || o.marketId))];
  for (const marketId of markets) {
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
    const minPnL     = Math.min(...potentials);
    totalLiability  += minPnL < 0 ? Math.abs(minPnL) : 0;
  }

  // --- PENDING: simple sum ---
  for (const bet of pending) {
    totalLiability += calculateLiability(bet);
  }

  return totalLiability;
}

module.exports = { calculateLiability, evaluateMatch, computeTotalLiability };
