'use strict';

/**
 * Pure matching-engine logic.
 * Determines whether an order should be MATCHED and at what price.
 */

const { BET_SIDE, ORDER_STATUS } = require('../config/constants');

/**
 * @typedef {{ matchedSize: number, status: string, executedPrice: number }} MatchResult
 */

/**
 * Evaluate a single order against live Betfair runner data.
 *
 * @param {Object} order         - The bet order (price, size, side)
 * @param {Object} runner        - Betfair runner book (ex.availableToBack, ex.availableToLay)
 * @returns {MatchResult}
 */
function evaluateMatch(order, runner) {
  const backs = runner.ex?.availableToBack || [];
  const lays = runner.ex?.availableToLay || [];
  const selectedPrice = Number(order.price);

  /* ── BACK bet ──────────────────────────────────────────── */
  if (order.side === BET_SIDE.BACK || order.type === 'BACK') {
    if (!backs.length) return _pending(order);

    const prices = backs.map((b) => b.price);
    const highest = Math.max(...prices);
    const lowest = Math.min(...prices);

    if (selectedPrice <= highest) {
      return { matchedSize: order.size, status: ORDER_STATUS.MATCHED, executedPrice: highest };
    }
    if (selectedPrice <= lowest || selectedPrice <= highest) {
      return { matchedSize: order.size, status: ORDER_STATUS.MATCHED, executedPrice: highest };
    }
    return _pending(order);
  }

  /* ── LAY bet ───────────────────────────────────────────── */
  if (order.side === BET_SIDE.LAY || order.type === 'LAY') {
    if (!lays.length) return _pending(order);

    const prices = lays.map((l) => l.price);
    const lowest = Math.min(...prices);

    if (selectedPrice >= lowest) {
      return { matchedSize: order.size, status: ORDER_STATUS.MATCHED, executedPrice: lowest };
    }
    return _pending(order);
  }

  return _pending(order);
}

/**
 * Calculate the liability for an order.
 * Back bet → stake; Lay bet → (price - 1) × stake.
 */
function calculateLiability(order) {
  const price = Number(order.price);
  const size = Number(order.size);
  return order.side === BET_SIDE.BACK ? size : (price - 1) * size;
}

/**
 * Compute per-runner P&L across all active orders for one market.
 *
 * Returns an object: { [selectionId]: netPnl }
 */
function computeRunnerPnL(orders) {
  const selections = [...new Set(orders.map((o) => String(o.selection_id)))];
  const pnl = {};
  for (const s of selections) pnl[s] = 0;

  for (const bet of orders) {
    const sel = String(bet.selection_id);
    const price = Number(bet.price);
    const size = Number(bet.status === ORDER_STATUS.MATCHED ? (bet.matched || bet.size) : bet.size);

    if (bet.side === BET_SIDE.BACK) {
      pnl[sel] += (price - 1) * size;
      selections.forEach((s) => { if (s !== sel) pnl[s] -= size; });
    } else if (bet.side === BET_SIDE.LAY) {
      pnl[sel] -= (price - 1) * size;
      selections.forEach((s) => { if (s !== sel) pnl[s] += size; });
    }
  }

  return pnl;
}

/**
 * Total liability across multiple markets.
 * Uses MAX-liability logic for multi-runner markets, SUM for single-runner.
 *
 * @param {Array}  activeOrders   - PENDING + MATCHED orders
 * @returns {number}              - Total liability amount
 */
function computeTotalLiability(activeOrders) {
  const byMarket = {};
  for (const o of activeOrders) {
    if (!byMarket[o.market_id]) byMarket[o.market_id] = [];
    byMarket[o.market_id].push(o);
  }

  let total = 0;
  for (const [, orders] of Object.entries(byMarket)) {
    const pnl = computeRunnerPnL(orders);
    const losses = Object.values(pnl).filter((v) => v < 0).map(Math.abs);

    if (losses.length === 0) continue;

    // Single runner → sum; Multi runner → max
    const uniqueSel = new Set(orders.map((o) => String(o.selection_id)));
    const liability = uniqueSel.size === 1 ? losses.reduce((a, b) => a + b, 0) : Math.max(...losses);
    total += liability;
  }
  return total;
}

/* ── Private helpers ─────────────────────────────────────── */
function _pending(order) {
  return { matchedSize: 0, status: ORDER_STATUS.PENDING, executedPrice: Number(order.price) };
}

module.exports = { evaluateMatch, calculateLiability, computeRunnerPnL, computeTotalLiability };
