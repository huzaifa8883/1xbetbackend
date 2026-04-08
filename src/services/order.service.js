'use strict';

const { Op } = require('sequelize');
const { User, Order, Transaction } = require('../models');
const { getRunnerBook } = require('./betfair.service');
const { evaluateMatch, calculateLiability, computeTotalLiability } = require('./matching.service');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE } = require('../config/constants');
const logger = require('../utils/logger');

/* ── recalculateLiability ────────────────────────────────── */
// Direct port of recalculateUserLiableAndPnL from orders.js
async function recalculateLiability(userId) {
  const user = await User.findByPk(userId);
  if (!user) return null;

  const allOrders = await Order.findAll({
    where: { user_id: userId, status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] } },
    raw: true,
  });

  const matched = allOrders.filter(o => o.status === ORDER_STATUS.MATCHED);
  const pending = allOrders.filter(o => o.status === ORDER_STATUS.PENDING);

  // Total funds invariant = wallet + current stored liability
  const currentWallet    = parseFloat(user.wallet_balance) || 0;
  const currentLiable    = parseFloat(user.liable) || 0;
  const totalFunds       = currentWallet + currentLiable;

  let totalLiability = 0;
  const combinedRunnerPnL = {};

  // MATCHED: market-wise green-book
  const markets = [...new Set(matched.map(o => o.market_id))];
  for (const marketId of markets) {
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

    const minPnL = Math.min(...potentials);
    totalLiability += minPnL < 0 ? Math.abs(minPnL) : 0;
  }

  // PENDING: simple sum
  for (const bet of pending) {
    totalLiability += calculateLiability(bet);
  }

  const newWallet = Math.max(0, totalFunds - totalLiability);

  await user.update({
    wallet_balance: newWallet,
    liable: totalLiability,
    runner_pnl: combinedRunnerPnL,
  });

  const freshData = { wallet_balance: newWallet, liable: totalLiability, runner_pnl: combinedRunnerPnL };

  if (global.io) {
    global.io.to(`user_${userId}`).emit('userUpdated', freshData);
  }

  return freshData;
}

/* ── autoMatchPendingBets ────────────────────────────────── */
async function autoMatchPendingBets(marketId, selectionId) {
  try {
    const runner = await getRunnerBook(marketId, selectionId);
    if (!runner) return;

    const pending = await Order.findAll({
      where: { market_id: marketId, selection_id: selectionId, status: ORDER_STATUS.PENDING },
    });

    for (const order of pending) {
      const { matchedSize, status, executedPrice } = evaluateMatch(order.toJSON(), runner);

      if (status === ORDER_STATUS.MATCHED) {
        await order.update({ matched: matchedSize, status, price: executedPrice });
        await recalculateLiability(order.user_id);

        if (global.io) {
          global.io.to(`match_${marketId}`).emit('ordersUpdated', {
            userId: order.user_id,
            order: order.toJSON(),
          });
        }

        logger.info(`Auto-matched order ${order.request_id} for user ${order.user_id}`);
      }
    }
  } catch (err) {
    logger.error(`autoMatchPendingBets error: ${err.message}`);
  }
}

/* ── settleEventBets ──────────────────────────────────────── */
// winningSelectionId — string or number of the winning runner
async function settleEventBets(marketId, winningSelectionId) {
  const matchedOrders = await Order.findAll({
    where: { market_id: marketId, status: ORDER_STATUS.MATCHED },
  });

  if (!matchedOrders.length) return;

  // Group by user
  const byUser = {};
  for (const o of matchedOrders) {
    const uid = String(o.user_id);
    (byUser[uid] = byUser[uid] || []).push(o);
  }

  for (const [userId, bets] of Object.entries(byUser)) {
    const user = await User.findByPk(userId);
    if (!user) continue;

    let totalProfit  = 0;
    let totalLoss    = 0;
    let totalRelease = 0;

    for (const bet of bets) {
      const price = Number(bet.price);
      const size  = Number(bet.size);
      const liable = bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
      totalRelease += liable;

      const isWinner = String(bet.selection_id) === String(winningSelectionId);
      if (isWinner) {
        if (bet.side === BET_SIDE.BACK) totalProfit += (price - 1) * size;
        else totalProfit += size;
      } else {
        if (bet.side === BET_SIDE.BACK) totalLoss += size;
        else totalLoss += (price - 1) * size;
      }
    }

    const netChange    = totalProfit - totalLoss;
    const walletBefore = parseFloat(user.wallet_balance) || 0;
    const liableBefore = parseFloat(user.liable) || 0;
    let newWallet = Math.max(0, walletBefore + totalRelease + netChange);

    await user.update({
      wallet_balance: newWallet,
      liable: Math.max(0, liableBefore - totalRelease),
    });

    await Transaction.create({
      user_id: userId,
      type: TRANSACTION_TYPE.BET_SETTLEMENT,
      amount: netChange,
      description: `Settlement for market ${marketId}`,
      status: 'completed',
      reference_id: String(marketId),
    });

    // Mark bets settled
    await Order.update(
      { status: ORDER_STATUS.SETTLED, settled_at: new Date() },
      { where: { user_id: userId, market_id: marketId, status: ORDER_STATUS.MATCHED } }
    );

    if (global.io) {
      global.io.to(`user_${userId}`).emit('userUpdated', {
        wallet_balance: newWallet,
        profit: totalProfit,
        loss: totalLoss,
        net: netChange,
      });
    }

    logger.info(`Settled bets for user ${userId}: profit=${totalProfit}, loss=${totalLoss}, net=${netChange}`);
  }

  // Final recalculate for all affected users
  for (const userId of Object.keys(byUser)) {
    await recalculateLiability(userId);
  }

  logger.info(`Settlement complete for market: ${marketId}`);
}

module.exports = { recalculateLiability, autoMatchPendingBets, settleEventBets };
