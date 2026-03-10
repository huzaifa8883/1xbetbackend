'use strict';

const { sequelize } = require('../config/database');
const { User, Order, Transaction } = require('../models');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE } = require('../config/constants');
const { evaluateMatch, calculateLiability, computeTotalLiability } = require('./matching.service');
const { getRunnerBook, getEventDetails, getMarketsWithDetails } = require('./betfair.service');
const logger = require('../utils/logger');
const { Op } = require('sequelize');

/* ── Liability Recalculation ─────────────────────────────── */

/**
 * Recalculate total liability for a user based on all PENDING/MATCHED orders,
 * then update wallet_balance and liable fields accordingly.
 */
async function recalculateLiability(userId) {
  const t = await sequelize.transaction();
  try {
    const user = await User.findByPk(userId, {
      include: [{ model: Order, as: 'orders', where: { status: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] }, required: false }],
      lock: t.LOCK.UPDATE,
      transaction: t,
    });

    if (!user) { await t.rollback(); return; }

    const activeOrders = user.orders || [];
    const newLiability = activeOrders.length ? computeTotalLiability(activeOrders.map((o) => o.toJSON())) : 0;
    const oldLiability = parseFloat(user.liable) || 0;
    const currentWallet = parseFloat(user.wallet_balance) || 0;
    const newWallet = Math.max(0, currentWallet + oldLiability - newLiability);

    await user.update({ wallet_balance: newWallet, liable: newLiability }, { transaction: t });
    await t.commit();

    // Push real-time update via Socket.IO
    if (global.io) {
      global.io.to(`user_${userId}`).emit('userUpdated', {
        wallet_balance: newWallet,
        liable: newLiability,
      });
    }
  } catch (err) {
    await t.rollback();
    logger.error(`recalculateLiability(${userId}): ${err.message}`);
  }
}

/* ── Auto-Matching ───────────────────────────────────────── */

/**
 * Attempt to match PENDING bets for a market/selection against live Betfair odds.
 */
async function autoMatchPendingBets(marketId, selectionId) {
  try {
    const runner = await getRunnerBook(marketId, selectionId);
    if (!runner) return;

    const pendingOrders = await Order.findAll({
      where: { market_id: marketId, selection_id: selectionId, status: ORDER_STATUS.PENDING },
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
        }
        logger.info(`Auto-matched order ${order.request_id} for user ${order.user_id}`);
      }
    }
  } catch (err) {
    logger.error(`autoMatchPendingBets(${marketId}, ${selectionId}): ${err.message}`);
  }
}

/* ── Settlement ──────────────────────────────────────────── */

const settledMarketIds = new Set();

/**
 * Settle all MATCHED bets for a closed market.
 */
async function settleMarket(marketId, winningSelectionId) {
  if (settledMarketIds.has(marketId)) return;
  settledMarketIds.add(marketId);

  const t = await sequelize.transaction();
  try {
    const matchedOrders = await Order.findAll({
      where: { market_id: marketId, status: ORDER_STATUS.MATCHED },
      transaction: t,
    });

    // Group by user
    const byUser = {};
    for (const o of matchedOrders) {
      if (!byUser[o.user_id]) byUser[o.user_id] = [];
      byUser[o.user_id].push(o);
    }

    for (const [userId, orders] of Object.entries(byUser)) {
      let totalProfit = 0;
      let totalLoss = 0;
      let releasedLiability = 0;

      for (const bet of orders) {
        const price = Number(bet.price);
        const size = Number(bet.size);
        const liable = bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
        releasedLiability += liable;

        if (String(bet.selection_id) === String(winningSelectionId)) {
          totalProfit += bet.side === BET_SIDE.BACK ? (price - 1) * size : size;
        } else {
          totalLoss += bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
        }
      }

      const netChange = totalProfit - totalLoss;
      const user = await User.findByPk(userId, { transaction: t });
      const newWallet = Math.max(0, (parseFloat(user.wallet_balance) || 0) + releasedLiability + netChange);
      const newLiable = Math.max(0, (parseFloat(user.liable) || 0) - releasedLiability);

      await user.update({ wallet_balance: newWallet, liable: newLiable }, { transaction: t });

      await Transaction.create({
        user_id: userId,
        type: TRANSACTION_TYPE.BET_SETTLEMENT,
        amount: netChange,
        description: `Settlement for market ${marketId}. Profit: ${totalProfit}, Loss: ${totalLoss}`,
        status: 'completed',
        reference_id: marketId,
      }, { transaction: t });

      // Mark bets as settled
      await Order.update(
        { status: ORDER_STATUS.SETTLED, settled_at: new Date() },
        { where: { user_id: userId, market_id: marketId, status: ORDER_STATUS.MATCHED }, transaction: t },
      );

      if (global.io) {
        global.io.to(`user_${userId}`).emit('userUpdated', { wallet_balance: newWallet, liable: newLiable });
      }
    }

    await t.commit();
    logger.info(`Market ${marketId} settled. Winner: ${winningSelectionId}`);
  } catch (err) {
    await t.rollback();
    settledMarketIds.delete(marketId); // allow retry
    logger.error(`settleMarket(${marketId}): ${err.message}`);
  }
}

/* ── Market Update Job helper ────────────────────────────── */

/**
 * Pull all active market IDs from the DB, check their status on Betfair,
 * trigger settlement for CLOSED markets, and auto-match pending bets.
 */
async function updateActiveMarkets() {
  const activeOrders = await Order.findAll({
    attributes: ['market_id', 'selection_id'],
    where: { status: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    raw: true,
  });

  if (!activeOrders.length) return;

  const uniqueMarketIds = [...new Set(activeOrders.map((o) => o.market_id))];
  const markets = await getMarketsWithDetails(uniqueMarketIds);

  for (const market of markets) {
    if (market.status === 'CLOSED') {
      const winner = market.runners?.find((r) => r.status === 'WINNER');
      if (winner) await settleMarket(market.marketId, winner.selectionId);
    }
  }

  // Auto-match pending bets per selection
  const selectionPairs = activeOrders
    .filter((o) => o.status === ORDER_STATUS.PENDING)
    .map((o) => ({ marketId: o.market_id, selectionId: o.selection_id }));

  const unique = [...new Map(selectionPairs.map((p) => [`${p.marketId}_${p.selectionId}`, p])).values()];

  for (const { marketId, selectionId } of unique) {
    await autoMatchPendingBets(marketId, selectionId).catch((e) =>
      logger.error(`autoMatch error: ${e.message}`),
    );
  }
}

module.exports = {
  recalculateLiability,
  autoMatchPendingBets,
  settleMarket,
  updateActiveMarkets,
};
