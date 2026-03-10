'use strict';

const { sequelize } = require('../config/database');
const { User, Order, Transaction } = require('../models');
const { sendSuccess, sendError } = require('../utils/response');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE, ROLES } = require('../config/constants');
const { calculateLiability, computeTotalLiability } = require('../services/matching.service');
const { recalculateLiability, autoMatchPendingBets } = require('../services/order.service');
const { getEventDetails, getRunnerBook } = require('../services/betfair.service');
const { evaluateMatch } = require('../services/matching.service');
const logger = require('../utils/logger');

/* ── POST /api/v1/orders ─────────────────────────────────── */
async function placeBets(req, res) {
  const bets = req.body;
  const userId = req.user.id;

  if (req.user.role !== ROLES.USER) {
    return sendError(res, 'Only User role can place bets', 403);
  }
  if (!Array.isArray(bets) || bets.length === 0) {
    return sendError(res, 'Request body must be a non-empty array of bets', 400);
  }

  const user = await User.findByPk(userId);
  if (!user) return sendError(res, 'User not found', 404);

  /* ── Enrich with event details ───────────────────────────── */
  const enriched = await Promise.all(
    bets.map(async (bet) => {
      const { eventName, category } = await getEventDetails(bet.marketId).catch(() => ({
        eventName: 'Unknown',
        category: 'Other',
      }));
      return { ...bet, event_name: eventName, category };
    }),
  );

  /* ── Normalise orders ────────────────────────────────────── */
  const now = Date.now();
  const normalized = enriched.map((bet, i) => ({
    request_id: now + i,
    user_id: userId,
    market_id: bet.marketId,
    selection_id: bet.selectionId,
    event_name: bet.event_name,
    category: bet.category,
    side: bet.side,
    type: bet.side === BET_SIDE.BACK ? 'BACK' : 'LAY',
    price: parseFloat(bet.price),
    size: parseFloat(bet.size),
    matched: 0,
    liable: calculateLiability(bet),
    status: ORDER_STATUS.PENDING,
  }));

  /* ── Tentative liability check ───────────────────────────── */
  const existingOrders = await Order.findAll({
    where: { user_id: userId, status: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    raw: true,
  });

  const allOrders = [...existingOrders, ...normalized];
  const tentativeLiability = computeTotalLiability(allOrders);
  const walletBalance = parseFloat(user.wallet_balance) || 0;
  const totalPositiveProfit = Object.values(user.runner_pnl || {}).filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const available = walletBalance + totalPositiveProfit;

  if (tentativeLiability > available) {
    return sendError(res, 'Insufficient funds for this bet', 400);
  }

  /* ── Persist orders ──────────────────────────────────────── */
  const created = await Order.bulkCreate(normalized);

  await Transaction.create({
    user_id: userId,
    type: TRANSACTION_TYPE.BET_PLACED,
    amount: -tentativeLiability,
    description: `Placed ${normalized.length} bet(s)`,
    status: 'completed',
  });

  /* ── Immediate match attempt (async) ─────────────────────── */
  const matchTasks = created.map(async (order) => {
    try {
      const runner = await getRunnerBook(order.market_id, order.selection_id);
      if (!runner) return;
      const { matchedSize, status, executedPrice } = evaluateMatch(order.toJSON(), runner);
      if (status === ORDER_STATUS.MATCHED) {
        await order.update({ matched: matchedSize, status, price: executedPrice });
        if (global.io) {
          global.io.to(`match_${order.market_id}`).emit('ordersUpdated', { userId, order: order.toJSON() });
        }
      }
    } catch (e) {
      logger.warn(`Immediate match attempt failed for request_id ${order.request_id}: ${e.message}`);
    }
  });

  // Fire and forget – do NOT await, return 200 immediately
  Promise.all(matchTasks)
    .then(() => recalculateLiability(userId))
    .catch((e) => logger.error(`Post-bet recalc failed: ${e.message}`));

  // Also trigger autoMatch for unique market/selection combos
  const pairs = [...new Map(normalized.map((o) => [`${o.market_id}_${o.selection_id}`, o])).values()];
  pairs.forEach(({ market_id, selection_id }) => {
    autoMatchPendingBets(market_id, selection_id).catch(() => {});
  });

  return sendSuccess(res, { orders: created.map((o) => o.toJSON()) }, 'Bet(s) placed successfully');
}

/* ── GET /api/v1/orders/pending ──────────────────────────── */
async function getPendingOrders(req, res) {
  const where = { user_id: req.user.id, status: ORDER_STATUS.PENDING };
  if (req.query.marketId) where.market_id = req.query.marketId;
  const orders = await Order.findAll({ where, order: [['created_at', 'DESC']] });
  return sendSuccess(res, { orders });
}

/* ── GET /api/v1/orders/matched ──────────────────────────── */
async function getMatchedOrders(req, res) {
  const where = { user_id: req.user.id, status: ORDER_STATUS.MATCHED };
  if (req.query.marketId) where.market_id = req.query.marketId;
  const orders = await Order.findAll({ where, order: [['created_at', 'DESC']] });
  return sendSuccess(res, { orders });
}

/* ── GET /api/v1/orders ──────────────────────────────────── */
async function getAllOrders(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const where = { user_id: req.user.id };
  if (status) where.status = status;

  const { count, rows } = await Order.findAndCountAll({
    where,
    limit: parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
    order: [['created_at', 'DESC']],
  });

  return sendSuccess(res, {
    orders: rows,
    pagination: { total: count, page: parseInt(page, 10), limit: parseInt(limit, 10) },
  });
}

/* ── POST /api/v1/orders/:requestId/cancel ───────────────── */
async function cancelOrder(req, res) {
  const order = await Order.findOne({
    where: { request_id: req.params.requestId, user_id: req.user.id },
  });

  if (!order) return sendError(res, 'Order not found', 404);
  if (order.status !== ORDER_STATUS.PENDING) {
    return sendError(res, 'Only PENDING orders can be cancelled', 400);
  }

  const refund = calculateLiability(order.toJSON());

  await order.update({ status: ORDER_STATUS.CANCELLED });
  await Transaction.create({
    user_id: req.user.id,
    type: TRANSACTION_TYPE.BET_CANCELLED,
    amount: refund,
    description: `Cancelled order ${order.request_id}`,
    status: 'completed',
    reference_id: String(order.request_id),
  });

  await recalculateLiability(req.user.id);
  return sendSuccess(res, { orderId: order.request_id }, 'Order cancelled');
}

/* ── POST /api/v1/orders/cancel-all ─────────────────────── */
async function cancelAllPendingOrders(req, res) {
  const count = await Order.update(
    { status: ORDER_STATUS.CANCELLED },
    { where: { user_id: req.user.id, status: ORDER_STATUS.PENDING } },
  );

  await Transaction.create({
    user_id: req.user.id,
    type: TRANSACTION_TYPE.BET_CANCELLED_ALL,
    amount: 0,
    description: `Cancelled all pending bets`,
    status: 'completed',
  });

  await recalculateLiability(req.user.id);
  return sendSuccess(res, { cancelledCount: count[0] }, 'All pending bets cancelled');
}

/* ── POST /api/v1/orders/auto-match/:marketId ────────────── */
async function triggerAutoMatch(req, res) {
  const { marketId } = req.params;
  const { selectionId } = req.body;

  if (selectionId) {
    await autoMatchPendingBets(marketId, selectionId);
    return sendSuccess(res, null, `Auto-match triggered for market ${marketId}, selection ${selectionId}`);
  }

  const pending = await Order.findAll({
    attributes: ['selection_id'],
    where: { market_id: marketId, status: ORDER_STATUS.PENDING },
    raw: true,
  });

  const unique = [...new Set(pending.map((o) => o.selection_id))];
  await Promise.all(unique.map((selId) => autoMatchPendingBets(marketId, selId)));
  return sendSuccess(res, { selections: unique.length }, `Auto-match triggered for ${unique.length} selections`);
}

module.exports = {
  placeBets,
  getPendingOrders,
  getMatchedOrders,
  getAllOrders,
  cancelOrder,
  cancelAllPendingOrders,
  triggerAutoMatch,
};
