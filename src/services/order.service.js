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
          global.io.to(`match_${marketId}`).emit('ordersUpdated', {
            userId: order.user_id,
            order: order.toJSON(),
          });
          global.io.to(`user_${order.user_id}`).emit('orderMatched', {
            order: order.toJSON(),
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
   settleEventBets  (Market Settlement)
   
   winningSelectionId = jo runner jeet gaya
   
   BACK on winner  → profit = (price-1)*size
   BACK on loser   → loss   = size
   LAY on winner   → loss   = (price-1)*size
   LAY on loser    → profit = size
────────────────────────────────────────────────────────────── */
async function settleEventBets(marketId, winningSelectionId) {
  const matchedOrders = await Order.findAll({
    where: { market_id: marketId, status: ORDER_STATUS.MATCHED },
  });

  if (!matchedOrders.length) {
    logger.warn(`settleEventBets: No matched orders for market ${marketId}`);
    return { settled: 0 };
  }

  const byUser = {};
  for (const o of matchedOrders) {
    const uid = String(o.user_id);
    (byUser[uid] = byUser[uid] || []).push(o);
  }

  let totalSettled = 0;

  for (const [userId, bets] of Object.entries(byUser)) {
    const user = await User.findByPk(userId);
    if (!user) continue;

    let totalProfit  = 0;
    let totalLoss    = 0;
    let totalRelease = 0;

    for (const bet of bets) {
      const price         = Number(bet.price);
      const effectiveSize = Number(bet.matched) > 0 ? Number(bet.matched) : Number(bet.size);
      const liable        = bet.side === BET_SIDE.BACK ? effectiveSize : (price - 1) * effectiveSize;
      totalRelease       += liable;

      const isWinner = String(bet.selection_id) === String(winningSelectionId);

      if (isWinner) {
        if (bet.side === BET_SIDE.BACK) totalProfit += (price - 1) * effectiveSize;
        else                            totalProfit += effectiveSize;
      } else {
        if (bet.side === BET_SIDE.BACK) totalLoss += effectiveSize;
        else                            totalLoss += (price - 1) * effectiveSize;
      }
    }

    const netChange    = totalProfit - totalLoss;
    const walletBefore = parseFloat(user.wallet_balance) || 0;
    const liableBefore = parseFloat(user.liable) || 0;
    const newWallet    = Math.max(0, walletBefore + totalRelease + netChange);
    const newLiable    = Math.max(0, liableBefore - totalRelease);

    await user.update({ wallet_balance: newWallet, liable: newLiable });

    await Transaction.create({
      user_id:      userId,
      type:         TRANSACTION_TYPE.BET_SETTLEMENT,
      amount:       netChange,
      description:  `Settlement: market ${marketId}, winner ${winningSelectionId}`,
      status:       'completed',
      reference_id: String(marketId),
    });

    await Order.update(
      { status: ORDER_STATUS.SETTLED, settled_at: new Date() },
      { where: { user_id: userId, market_id: marketId, status: ORDER_STATUS.MATCHED } },
    );

    if (global.io) {
      global.io.to(`user_${userId}`).emit('userUpdated', {
        wallet_balance: newWallet,
        liable:         newLiable,
        profit:         totalProfit,
        loss:           totalLoss,
        net:            netChange,
        event:          'settlement',
        marketId,
      });
    }

    totalSettled++;
    logger.info(`Settled userId=${userId}: profit=${totalProfit.toFixed(2)}, loss=${totalLoss.toFixed(2)}, net=${netChange.toFixed(2)}, released=${totalRelease.toFixed(2)}`);
  }

  for (const userId of Object.keys(byUser)) {
    await recalculateLiability(userId);
  }

  logger.info(`Settlement complete for market ${marketId}: ${totalSettled} users settled`);
  return { settled: totalSettled };
}

module.exports = { recalculateLiability, autoMatchPendingBets, settleEventBets };
