'use strict';

const { sequelize } = require('../config/database');
const { User, Order, Transaction } = require('../models');
const { sendSuccess, sendError } = require('../utils/response');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE, ROLES } = require('../config/constants');
const { calculateLiability, computeTotalLiability } = require('../services/matching.service');
const { recalculateLiability, autoMatchPendingBets, settleEventBets } = require('../services/order.service');
const { getEventDetails, getRunnerBook } = require('../services/betfair.service');
const { evaluateMatch } = require('../services/matching.service');
const logger = require('../utils/logger');

async function placeBets(req, res) {
  const bets   = req.body;
  const userId = req.user.id;

  if (req.user.role !== ROLES.USER)
    return sendError(res, 'Only User role can place bets', 403);
  if (!Array.isArray(bets) || bets.length === 0)
    return sendError(res, 'Request body must be a non-empty array of bets', 400);

  const user = await User.findByPk(userId);
  if (!user) return sendError(res, 'User not found', 404);

  const enriched = await Promise.all(
    bets.map(async (bet) => {
      const { eventName, category } = await getEventDetails(bet.marketId).catch(() => ({
        eventName: 'Unknown', category: 'Other',
      }));
      return { ...bet, event_name: eventName, category };
    }),
  );

  const now = Date.now();
  const normalized = enriched.map((bet, i) => {
    const price  = parseFloat(bet.price);
    const size   = parseFloat(bet.size);
    const liable = bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
    return {
      request_id: now + i, user_id: userId,
      market_id: bet.marketId, selection_id: bet.selectionId,
      event_name: bet.event_name, category: bet.category,
      side: bet.side, type: bet.side === BET_SIDE.BACK ? 'BACK' : 'LAY',
      price, size, matched: 0, liable, status: ORDER_STATUS.PENDING,
    };
  });

  const existingOrders = await Order.findAll({
    where: { user_id: userId, status: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    raw: true,
  });

  const tentativeLiability = computeTotalLiability([...existingOrders, ...normalized]);
  const walletBalance      = parseFloat(user.wallet_balance) || 0;
  const positiveRunnerPnL  = Object.values(user.runner_pnl || {})
    .filter(v => v > 0).reduce((a, b) => a + b, 0);

  if (tentativeLiability > walletBalance + positiveRunnerPnL) {
    return sendError(res,
      `Insufficient funds. Required: ${tentativeLiability.toFixed(2)}, Available: ${(walletBalance + positiveRunnerPnL).toFixed(2)}`,
      400);
  }

  const created = await Order.bulkCreate(normalized);

  await Transaction.create({
    user_id: userId, type: TRANSACTION_TYPE.BET_PLACED,
    amount: -tentativeLiability,
    description: `Placed ${normalized.length} bet(s)`, status: 'completed',
  });

  const matchTasks = created.map(async (order) => {
    try {
      const runner = await getRunnerBook(order.market_id, order.selection_id);
      if (!runner) return;
      const { matchedSize, status, executedPrice } = evaluateMatch(order.toJSON(), runner);
      if (status === ORDER_STATUS.MATCHED) {
        await order.update({ matched: matchedSize, status, price: executedPrice });
        if (global.io)
          global.io.to(`match_${order.market_id}`).emit('ordersUpdated', { userId, order: order.toJSON() });
        logger.info(`Immediately matched order ${order.request_id}`);
      }
    } catch (e) {
      logger.warn(`Immediate match failed for ${order.request_id}: ${e.message}`);
    }
  });

  Promise.all(matchTasks)
    .then(() => recalculateLiability(userId))
    .catch(e => logger.error(`Post-bet recalc failed: ${e.message}`));

  const pairs = [...new Map(normalized.map(o => [`${o.market_id}_${o.selection_id}`, o])).values()];
  pairs.forEach(({ market_id, selection_id }) => {
    autoMatchPendingBets(market_id, selection_id).catch(() => {});
  });

  const preliminaryWallet = Math.max(0, walletBalance - tentativeLiability);
  const preliminaryLiable = (parseFloat(user.liable) || 0) + tentativeLiability;

  return sendSuccess(res, {
    orders: created.map(o => o.toJSON()),
    wallet: parseFloat(preliminaryWallet.toFixed(2)),
    liable: parseFloat(preliminaryLiable.toFixed(2)),
  }, 'Bet(s) placed successfully');
}

async function getPendingOrders(req, res) {
  const where = { user_id: req.user.id, status: ORDER_STATUS.PENDING };
  if (req.query.marketId) where.market_id = req.query.marketId;
  const orders = await Order.findAll({ where, order: [['created_at', 'DESC']] });
  return sendSuccess(res, { orders });
}

async function getMatchedOrders(req, res) {
  const where = { user_id: req.user.id, status: ORDER_STATUS.MATCHED };
  if (req.query.marketId) where.market_id = req.query.marketId;
  const orders = await Order.findAll({ where, order: [['created_at', 'DESC']] });
  return sendSuccess(res, { orders });
}

async function getAllOrders(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const where = { user_id: req.user.id };
  if (status) where.status = status;
  const { count, rows } = await Order.findAndCountAll({
    where, limit: parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
    order: [['created_at', 'DESC']],
  });
  return sendSuccess(res, { orders: rows, pagination: { total: count, page: parseInt(page, 10), limit: parseInt(limit, 10) } });
}

async function cancelOrder(req, res) {
  const order = await Order.findOne({
    where: { request_id: req.params.requestId, user_id: req.user.id },
  });
  if (!order) return sendError(res, 'Order not found', 404);
  if (order.status !== ORDER_STATUS.PENDING)
    return sendError(res, 'Only PENDING orders can be cancelled', 400);

  await order.update({ status: ORDER_STATUS.CANCELLED });
  await Transaction.create({
    user_id: req.user.id, type: TRANSACTION_TYPE.BET_CANCELLED,
    amount: parseFloat(order.liable) || 0,
    description: `Cancelled order ${order.request_id}`,
    status: 'completed', reference_id: String(order.request_id),
  });

  const freshData = await recalculateLiability(req.user.id);
  return sendSuccess(res, { orderId: order.request_id, wallet: freshData?.wallet_balance, liable: freshData?.liable }, 'Order cancelled');
}

async function cancelAllPendingOrders(req, res) {
  const [cancelledCount] = await Order.update(
    { status: ORDER_STATUS.CANCELLED },
    { where: { user_id: req.user.id, status: ORDER_STATUS.PENDING } },
  );
  await Transaction.create({
    user_id: req.user.id, type: TRANSACTION_TYPE.BET_CANCELLED_ALL,
    amount: 0, description: `Cancelled all pending bets`, status: 'completed',
  });
  const freshData = await recalculateLiability(req.user.id);
  return sendSuccess(res, { cancelledCount, wallet: freshData?.wallet_balance, liable: freshData?.liable }, 'All pending bets cancelled');
}

async function triggerAutoMatch(req, res) {
  const { marketId } = req.params;
  const { selectionId } = req.body;
  if (selectionId) {
    await autoMatchPendingBets(marketId, selectionId);
    return sendSuccess(res, null, `Auto-match triggered for market ${marketId}, sel ${selectionId}`);
  }
  const pending = await Order.findAll({
    attributes: ['selection_id'],
    where: { market_id: marketId, status: ORDER_STATUS.PENDING }, raw: true,
  });
  const unique = [...new Set(pending.map(o => o.selection_id))];
  await Promise.all(unique.map(selId => autoMatchPendingBets(marketId, selId)));
  return sendSuccess(res, { selections: unique.length }, `Auto-match triggered for ${unique.length} selections`);
}

async function settleMarket(req, res) {
  const { marketId } = req.params;
  const { winningSelectionId } = req.body;
  if (!winningSelectionId)
    return sendError(res, 'winningSelectionId is required', 400);
  const result = await settleEventBets(marketId, winningSelectionId);
  return sendSuccess(res, result, `Market ${marketId} settled. ${result.settled} users processed.`);
}

async function getOrdersByEvent(req, res) {
  const { marketId, maxResults } = req.query;
  const userId = req.user.id;
  const where = { user_id: userId };
  if (marketId && marketId !== 'undefined') where.market_id = marketId;
  const limit = parseInt(maxResults, 10);
  const orders = await Order.findAll({
    where, order: [['created_at', 'DESC']], ...(limit > 0 ? { limit } : {}),
  });
  const formatted = orders.map(o => ({
    id: String(o.request_id), marketId: o.market_id, selectionId: String(o.selection_id),
    eventName: o.event_name || '', side: o.side,
    price: parseFloat(o.price), size: parseFloat(o.size),
    matched: parseFloat(o.matched), status: o.status, placedDate: o.created_at,
  }));
  return sendSuccess(res, { orders: formatted });
}

module.exports = {
  placeBets, getPendingOrders, getMatchedOrders, getAllOrders,
  cancelOrder, cancelAllPendingOrders, triggerAutoMatch,
  settleMarket, getOrdersByEvent,
};
