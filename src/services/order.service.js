'use strict';

const { Op } = require('sequelize');
const { User, Order, Transaction } = require('../models');
const { getRunnerBook } = require('./betfair.service');
const { evaluateMatch, calculateLiability, computeTotalLiability } = require('./matching.service');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE } = require('../config/constants');
const logger = require('../utils/logger');

/* ─────────────────────────────────────────────────────────────
   recalculateLiability

   Invariant: totalFunds = wallet_balance + liable  (constant)
   Naya wallet  = totalFunds - newLiability
   Naya liable  = newLiability
   Socket se frontend instantly update hota hai.
────────────────────────────────────────────────────────────── */
async function recalculateLiability(userId) {
  const user = await User.findByPk(userId);
  if (!user) return null;

  const allOrders = await Order.findAll({
    where: {
      user_id: userId,
      status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    },
    raw: true,
  });

  const matched = allOrders.filter(o => o.status === ORDER_STATUS.MATCHED);
  const pending = allOrders.filter(o => o.status === ORDER_STATUS.PENDING);

  const currentWallet = parseFloat(user.wallet_balance) || 0;
  const currentLiable = parseFloat(user.liable) || 0;
  const totalFunds    = currentWallet + currentLiable;

  let totalLiability      = 0;
  const combinedRunnerPnL = {};

  // ── MATCHED: Green-book market-wise ──────────────────────
  const marketIds = [...new Set(matched.map(o => o.market_id))];

  for (const marketId of marketIds) {
    const marketOrders = matched.filter(o => o.market_id === marketId);
    let globalPnL = 0;
    const runnerAdj = {};

    for (const bet of marketOrders) {
      const sel   = String(bet.selection_id);
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

    const potentials = [globalPnL];
    for (const [sel, adj] of Object.entries(runnerAdj)) {
      const runnerFinal = globalPnL + adj;
      potentials.push(runnerFinal);
      combinedRunnerPnL[sel] = (combinedRunnerPnL[sel] || 0) + runnerFinal;
    }

    const worstCase  = Math.min(...potentials);
    totalLiability  += worstCase < 0 ? Math.abs(worstCase) : 0;
  }

  // ── PENDING: simple per-bet liability ────────────────────
  for (const bet of pending) {
    const price = parseFloat(bet.price);
    const size  = parseFloat(bet.size);
    totalLiability += bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
  }

  const newWallet = Math.max(0, totalFunds - totalLiability);

  await user.update({
    wallet_balance: newWallet,
    liable:         totalLiability,
    runner_pnl:     combinedRunnerPnL,
  });

  const freshData = {
    wallet_balance: newWallet,
    liable:         totalLiability,
    runner_pnl:     combinedRunnerPnL,
  };

  if (global.io) {
    global.io.to(`user_${userId}`).emit('userUpdated', freshData);
  }

  logger.info(`Recalculated userId=${userId}: wallet=${newWallet.toFixed(2)}, liable=${totalLiability.toFixed(2)}`);
  return freshData;
}

/* ─────────────────────────────────────────────────────────────
   autoMatchPendingBets

   Betfair se live runner data le ke PENDING bets match karta hai.
   Match hone par recalculate + socket emit.

   ── FIXED: socket emit newOrders[] array format mein, runnerName ke saath ──
────────────────────────────────────────────────────────────── */
async function autoMatchPendingBets(marketId, selectionId) {
  try {
    const runner = await getRunnerBook(marketId, selectionId);
    if (!runner) return;

    const pendingOrders = await Order.findAll({
      where: {
        market_id:    marketId,
        selection_id: selectionId,
        status:       ORDER_STATUS.PENDING,
      },
    });

    for (const order of pendingOrders) {
      const { matchedSize, status, executedPrice } = evaluateMatch(order.toJSON(), runner);

      if (status === ORDER_STATUS.MATCHED) {
        await order.update({ matched: matchedSize, status, price: executedPrice });
        await recalculateLiability(order.user_id);

        if (global.io) {
          // ── FIXED: newOrders array format + runnerName field ──
          global.io.to(`match_${marketId}`).emit('ordersUpdated', {
            userId: order.user_id,
            newOrders: [{
              ...order.toJSON(),
              runnerName: order.runner_name || '',
            }],
          });
          global.io.to(`user_${order.user_id}`).emit('orderMatched', {
            order: {
              ...order.toJSON(),
              runnerName: order.runner_name || '',
            },
          });
        }

        logger.info(`Auto-matched order ${order.request_id} for user ${order.user_id} at price ${executedPrice}`);
      }
    }
  } catch (err) {
    logger.error(`autoMatchPendingBets error [market=${marketId}, sel=${selectionId}]: ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────
   calculateRunnerPnL  (per-user, per-market)

   Har runner ke liye "agar yeh runner jeeta to kya hoga" calculate karta hai.
   Returns: { [selectionId]: { profit, liability, net } }

   BACK on winner  → profit  = (price-1)*size
   BACK on loser   → loss    = size
   LAY on winner   → loss    = (price-1)*size
   LAY on loser    → profit  = size
────────────────────────────────────────────────────────────── */
function calculateRunnerPnL(marketOrders) {
  const runners = [...new Set(marketOrders.map(o => String(o.selection_id)))];
  const result  = {};

  for (const runnerId of runners) {
    let profitIfWin = 0;
    let lossIfWin   = 0;

    for (const bet of marketOrders) {
      const price = Number(bet.price);
      const size  = Number(bet.matched > 0 ? bet.matched : bet.size);
      const sel   = String(bet.selection_id);

      if (sel === runnerId) {
        // This runner wins:
        if (bet.side === BET_SIDE.BACK) profitIfWin += (price - 1) * size;
        else                            lossIfWin   += (price - 1) * size;
      } else {
        // This runner wins, the other lost:
        if (bet.side === BET_SIDE.BACK) lossIfWin   += size;
        else                            profitIfWin += size;
      }
    }

    const net = profitIfWin - lossIfWin;
    result[runnerId] = {
      profit:    parseFloat(profitIfWin.toFixed(2)),
      liability: parseFloat(lossIfWin.toFixed(2)),
      net:       parseFloat(net.toFixed(2)),
    };
  }

  return result;
}

/* ─────────────────────────────────────────────────────────────
   settleEventBets  (Market Settlement)

   winningSelectionId = jo runner jeet gaya

   SETTLEMENT RULES:
   BACK on winner  → credit = stake + (price-1)*stake
   BACK on loser   → loss   = stake (already deducted)
   LAY on winner   → loss   = (price-1)*stake (already deducted)
   LAY on loser    → credit = stake (bookmaker wins)

   Commission deducted from net profit only.
   commissionPct = 0..100 (default 0)
────────────────────────────────────────────────────────────── */
async function settleEventBets(marketId, winningSelectionId, { commissionPct = 0 } = {}) {
  const matchedOrders = await Order.findAll({
    where: { market_id: marketId, status: ORDER_STATUS.MATCHED },
  });

  if (!matchedOrders.length) {
    logger.warn(`settleEventBets: No matched orders for market ${marketId}`);
    return { settled: 0, details: [] };
  }

  const byUser = {};
  for (const o of matchedOrders) {
    const uid = String(o.user_id);
    (byUser[uid] = byUser[uid] || []).push(o);
  }

  let totalSettled = 0;
  const details    = [];

  for (const [userId, bets] of Object.entries(byUser)) {
    const user = await User.findByPk(userId);
    if (!user) continue;

    let totalWinCredit   = 0;
    let totalLoss        = 0;
    let totalLiableHeld  = 0;

    for (const bet of bets) {
      const price         = Number(bet.price);
      const effectiveSize = Number(bet.matched) > 0 ? Number(bet.matched) : Number(bet.size);
      const liableHeld    = bet.side === BET_SIDE.BACK
        ? effectiveSize
        : (price - 1) * effectiveSize;

      totalLiableHeld += liableHeld;

      const isWinner = String(bet.selection_id) === String(winningSelectionId);

      if (isWinner) {
        if (bet.side === BET_SIDE.BACK) {
          totalWinCredit += effectiveSize + (price - 1) * effectiveSize;
        } else {
          totalLoss += (price - 1) * effectiveSize;
        }
      } else {
        if (bet.side === BET_SIDE.BACK) {
          totalLoss += effectiveSize;
        } else {
          totalWinCredit += effectiveSize + effectiveSize;
        }
      }
    }

    const grossProfit = totalWinCredit - totalLiableHeld - totalLoss;
    const commission  = grossProfit > 0 ? parseFloat((grossProfit * commissionPct / 100).toFixed(2)) : 0;
    const netCredit   = totalWinCredit - commission;

    const walletBefore = parseFloat(user.wallet_balance) || 0;
    const liableBefore = parseFloat(user.liable) || 0;

    const newWallet = Math.max(0, walletBefore + totalLiableHeld + (netCredit - totalLiableHeld));
    const newLiable = Math.max(0, liableBefore - totalLiableHeld);

    await user.update({ wallet_balance: newWallet, liable: newLiable });

    const txnAmount = netCredit - totalLiableHeld;
    await Transaction.create({
      user_id:      userId,
      type:         TRANSACTION_TYPE.BET_SETTLEMENT,
      amount:       parseFloat(txnAmount.toFixed(2)),
      description:  `Settlement: market ${marketId}, winner ${winningSelectionId}. Gross profit: ${grossProfit.toFixed(2)}, Commission: ${commission.toFixed(2)}`,
      status:       'completed',
      reference_id: String(marketId),
    });

    await Order.update(
      { status: ORDER_STATUS.SETTLED, settled_at: new Date(), winning_selection_id: String(winningSelectionId) },
      { where: { user_id: userId, market_id: marketId, status: ORDER_STATUS.MATCHED } },
    );

    const runnerPnLMap = calculateRunnerPnL(bets.map(b => b.toJSON()));

    if (global.io) {
      global.io.to(`user_${userId}`).emit('userUpdated', {
        wallet_balance: newWallet,
        liable:         newLiable,
        event:          'settlement',
        marketId,
        winningSelectionId,
        settlement: {
          grossProfit:    parseFloat(grossProfit.toFixed(2)),
          commission,
          netCredit:      parseFloat(netCredit.toFixed(2)),
          totalLoss:      parseFloat(totalLoss.toFixed(2)),
          totalWinCredit: parseFloat(totalWinCredit.toFixed(2)),
          liableReleased: totalLiableHeld,
        },
        runnerPnL: runnerPnLMap,
      });
    }

    details.push({
      userId,
      grossProfit:    parseFloat(grossProfit.toFixed(2)),
      commission,
      netCredit:      parseFloat(netCredit.toFixed(2)),
      totalLoss:      parseFloat(totalLoss.toFixed(2)),
      liableReleased: parseFloat(totalLiableHeld.toFixed(2)),
      walletBefore,
      walletAfter:    newWallet,
      runnerPnL:      runnerPnLMap,
    });

    totalSettled++;
    logger.info(
      `Settled userId=${userId}: grossProfit=${grossProfit.toFixed(2)}, ` +
      `commission=${commission.toFixed(2)}, netCredit=${netCredit.toFixed(2)}, ` +
      `loss=${totalLoss.toFixed(2)}, liableReleased=${totalLiableHeld.toFixed(2)}`
    );
  }

  for (const userId of Object.keys(byUser)) {
    await recalculateLiability(userId);
  }

  if (global.io) {
    global.io.to(`match_${marketId}`).emit('marketSettled', {
      marketId,
      winningSelectionId,
      settledUsers: totalSettled,
    });
  }

  logger.info(`Settlement complete for market ${marketId}: ${totalSettled} users settled`);
  return { settled: totalSettled, details };
}

/* ─────────────────────────────────────────────────────────────
   voidMarketBets  — Market VOID / Cancel karo

   Har user ka MATCHED aur PENDING bets cancel karo.
   Poora liable wapas wallet mein dalo.
────────────────────────────────────────────────────────────── */
async function voidMarketBets(marketId) {
  const affectedOrders = await Order.findAll({
    where: {
      market_id: marketId,
      status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    },
  });

  if (!affectedOrders.length) {
    logger.warn(`voidMarketBets: No active orders for market ${marketId}`);
    return { voided: 0 };
  }

  const byUser = {};
  for (const o of affectedOrders) {
    const uid = String(o.user_id);
    (byUser[uid] = byUser[uid] || []).push(o);
  }

  let totalVoided = 0;

  for (const [userId, bets] of Object.entries(byUser)) {
    const user = await User.findByPk(userId);
    if (!user) continue;

    await Order.update(
      { status: ORDER_STATUS.CANCELLED },
      {
        where: {
          user_id:   userId,
          market_id: marketId,
          status:    { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
        },
      }
    );

    await Transaction.create({
      user_id:      userId,
      type:         TRANSACTION_TYPE.BET_CANCELLED,
      amount:       0,
      description:  `VOID: market ${marketId} cancelled — all ${bets.length} bets voided`,
      status:       'completed',
      reference_id: String(marketId),
    });

    totalVoided++;
  }

  for (const userId of Object.keys(byUser)) {
    const freshData = await recalculateLiability(userId);
    if (global.io && freshData) {
      global.io.to(`user_${userId}`).emit('userUpdated', {
        ...freshData,
        event: 'void',
        marketId,
      });
    }
  }

  if (global.io) {
    global.io.to(`match_${marketId}`).emit('marketVoided', { marketId, voidedUsers: totalVoided });
  }

  logger.info(`Void complete for market ${marketId}: ${totalVoided} users affected`);
  return { voided: totalVoided };
}

/* ─────────────────────────────────────────────────────────────
   getMarketPnLSummary  — Market ke liye per-runner PnL summary
────────────────────────────────────────────────────────────── */
async function getMarketPnLSummary(marketId, userId) {
  const orders = await Order.findAll({
    where: {
      market_id: marketId,
      user_id:   userId,
      status:    ORDER_STATUS.MATCHED,
    },
    raw: true,
  });

  if (!orders.length) return {};

  return calculateRunnerPnL(orders);
}

module.exports = {
  recalculateLiability,
  autoMatchPendingBets,
  settleEventBets,
  voidMarketBets,
  calculateRunnerPnL,
  getMarketPnLSummary,
};
