'use strict';

const { sequelize } = require('../config/database');
const { User, Order, Transaction } = require('../models');
const { sendSuccess, sendError } = require('../utils/response');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE, ROLES } = require('../config/constants');
const { calculateLiability, computeTotalLiability } = require('../services/matching.service');
const {
  recalculateLiability,
  autoMatchPendingBets,
  settleEventBets,
  voidMarketBets,
  calculateRunnerPnL,
  getMarketPnLSummary,
} = require('../services/order.service');
const { getEventDetails, getRunnerBook } = require('../services/betfair.service');
const { evaluateMatch } = require('../services/matching.service');
const logger = require('../utils/logger');

/* ─────────────────────────────────────────────────────────────
   computeSettlementPnL — settled order ka net P&L calculate karo
   Returns positive = profit, negative = loss
────────────────────────────────────────────────────────────── */
function computeSettlementPnL(order) {
  const price  = parseFloat(order.price);
  const size   = parseFloat(order.matched > 0 ? order.matched : order.size);
  const isWin  = String(order.selection_id) === String(order.winning_selection_id);

  if (order.side === BET_SIDE.BACK) {
    return isWin ? parseFloat(((price - 1) * size).toFixed(2)) : -parseFloat(size.toFixed(2));
  } else {
    // LAY
    return isWin ? -parseFloat(((price - 1) * size).toFixed(2)) : parseFloat(size.toFixed(2));
  }
}

/* ─────────────────────────────────────────────────────────────
   placeBets  — Bet lagao
────────────────────────────────────────────────────────────── */
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
      return {
        ...bet,
        event_name:  eventName,
        category,
        runner_name: bet.runnerName || bet.runner_name || '',
      };
    }),
  );

  const now = Date.now();
  const normalized = enriched.map((bet, i) => {
    const price  = parseFloat(bet.price);
    const size   = parseFloat(bet.size);
    const liable = bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
    return {
      request_id:   now + i,
      user_id:      userId,
      market_id:    bet.marketId,
      selection_id: bet.selectionId,
      runner_name:  bet.runner_name || '',
      event_name:   bet.event_name,
      category:     bet.category,
      side:         bet.side,
      type:         bet.side === BET_SIDE.BACK ? 'BACK' : 'LAY',
      price,
      size,
      matched:      0,
      liable,
      status:       ORDER_STATUS.PENDING,
    };
  });

  const existingOrders = await Order.findAll({
    where: { user_id: userId, status: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    raw: true,
  });

  const tentativeLiability = computeTotalLiability([...existingOrders, ...normalized]);
  const walletBalance      = parseFloat(user.wallet_balance) || 0;
  const positiveRunnerPnL  = Object.values(user.runner_pnl || {})
    .filter(v => (typeof v === 'object' ? v.net > 0 : v > 0))
    .reduce((a, b) => a + (typeof b === 'object' ? b.net : b), 0);

  if (tentativeLiability > walletBalance + positiveRunnerPnL) {
    return sendError(res,
      `Insufficient funds. Required: ${tentativeLiability.toFixed(2)}, Available: ${(walletBalance + positiveRunnerPnL).toFixed(2)}`,
      400);
  }

  const created = await Order.bulkCreate(normalized);

  const thisLiability = normalized.reduce((sum, b) => sum + b.liable, 0);
  await Transaction.create({
    user_id:     userId,
    type:        TRANSACTION_TYPE.BET_PLACED,
    amount:      -parseFloat(thisLiability.toFixed(2)),
    description: `Placed ${normalized.length} bet(s): ${normalized.map(b => `${b.side}@${b.price}`).join(', ')}`,
    status:      'completed',
  });

  const matchTasks = created.map(async (order) => {
    try {
      const runner = await getRunnerBook(order.market_id, order.selection_id);
      if (!runner) return;
      const { matchedSize, status, executedPrice } = evaluateMatch(order.toJSON(), runner);
      if (status === ORDER_STATUS.MATCHED) {
        await order.update({ matched: matchedSize, status, price: executedPrice });
        if (global.io) {
          global.io.to(`match_${order.market_id}`).emit('ordersUpdated', {
            userId,
            newOrders: [{
              ...order.toJSON(),
              runnerName: order.runner_name || '',
            }],
          });
        }
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

  const preliminaryWallet = Math.max(0, walletBalance - thisLiability);
  const preliminaryLiable = (parseFloat(user.liable) || 0) + thisLiability;

  const betsWithPnL = created.map(o => {
    const price  = parseFloat(o.price);
    const size   = parseFloat(o.size);
    const profit = o.side === BET_SIDE.BACK
      ? parseFloat(((price - 1) * size).toFixed(2))
      : parseFloat(size.toFixed(2));
    const liable = o.side === BET_SIDE.BACK
      ? parseFloat(size.toFixed(2))
      : parseFloat(((price - 1) * size).toFixed(2));
    return {
      ...o.toJSON(),
      profit,
      liable,
      runnerName: o.runner_name || '',
    };
  });

  if (global.io) {
    global.io.to(`match_${normalized[0]?.market_id}`).emit('ordersUpdated', {
      userId,
      newOrders: betsWithPnL.map(o => ({
        ...o,
        status: o.status || ORDER_STATUS.PENDING,
        runnerName: o.runner_name || '',
      })),
    });
  }

  return sendSuccess(res, {
    orders:  betsWithPnL,
    wallet:  parseFloat(preliminaryWallet.toFixed(2)),
    liable:  parseFloat(preliminaryLiable.toFixed(2)),
  }, 'Bet(s) placed successfully');
}

/* ─────────────────────────────────────────────────────────────
   getPendingOrders
────────────────────────────────────────────────────────────── */
async function getPendingOrders(req, res) {
  const where = { user_id: req.user.id, status: ORDER_STATUS.PENDING };
  // Support both ?marketId= and ?matchId=
  const filterById = req.query.marketId || req.query.matchId;
  if (filterById) where.market_id = filterById;
  const orders = await Order.findAll({ where, order: [['created_at', 'DESC']] });
  return sendSuccess(res, { orders: orders.map(o => enrichOrderWithPnL(o.toJSON())) });
}

/* ─────────────────────────────────────────────────────────────
   getMatchedOrders — MATCHED status wali bets (SETTLED nahi)
────────────────────────────────────────────────────────────── */
async function getMatchedOrders(req, res) {
  const where = { user_id: req.user.id, status: ORDER_STATUS.MATCHED };
  // Support both ?marketId= and ?matchId= for sub-market compatibility
  const filterById = req.query.marketId || req.query.matchId;
  if (filterById) where.market_id = filterById;
  const orders = await Order.findAll({ where, order: [['created_at', 'DESC']] });
  const enriched = orders.map(o => enrichOrderWithPnL(o.toJSON()));
  return sendSuccess(res, { orders: enriched });
}

/* ─────────────────────────────────────────────────────────────
   getAllOrders — MATCHED + PENDING bets (bet history page)
   SETTLED bets yahan NAHI aayenge — unke liye /settled route hai
────────────────────────────────────────────────────────────── */
async function getAllOrders(req, res) {
  const { status, page = 1, limit = 50 } = req.query;
  const { Op } = require('sequelize');
  const where = { user_id: req.user.id };

  if (status) {
    where.status = status;
  } else {
    // Default: sirf active bets (PENDING + MATCHED), SETTLED excluded
    where.status = { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] };
  }

  const { count, rows } = await Order.findAndCountAll({
    where,
    limit:  parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
    order:  [['created_at', 'DESC']],
  });
  return sendSuccess(res, {
    orders: rows.map(o => enrichOrderWithPnL(o.toJSON())),
    pagination: { total: count, page: parseInt(page, 10), limit: parseInt(limit, 10) },
  });
}

/* ─────────────────────────────────────────────────────────────
   getSettledOrders — SETTLED bets (statement/ledger page ke liye)
   winningSelectionId aur settlementPnL include karta hai
────────────────────────────────────────────────────────────── */
async function getSettledOrders(req, res) {
  const { page = 1, limit = 500, marketId, eventName, category } = req.query;
  const { Op } = require('sequelize');
  const where = { user_id: req.user.id, status: ORDER_STATUS.SETTLED };

  // Optional filters
  if (marketId && marketId !== 'undefined') where.market_id = marketId;
  if (eventName) where.event_name = { [Op.like]: `%${eventName}%` };
  if (category)  where.category   = { [Op.like]: `%${category}%` };

  const { count, rows } = await Order.findAndCountAll({
    where,
    limit:  parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
    order:  [['settled_at', 'DESC']],
  });

  return sendSuccess(res, {
    orders: rows.map(o => {
      const raw = o.toJSON();
      return {
        ...enrichOrderWithPnL(raw),
        marketId:             raw.market_id   || null,
        selectionId:          raw.selection_id || null,
        eventName:            raw.event_name  || null,
        category:             raw.category    || null,
        settled_at:           raw.settled_at  || null,
        winning_selection_id: raw.winning_selection_id || null,
        settlementPnL: raw.winning_selection_id
          ? computeSettlementPnL(raw)
          : null,
      };
    }),
    pagination: { total: count, page: parseInt(page, 10), limit: parseInt(limit, 10) },
  });
}

/* ─────────────────────────────────────────────────────────────
   cancelOrder
────────────────────────────────────────────────────────────── */
async function cancelOrder(req, res) {
  const order = await Order.findOne({
    where: { request_id: req.params.requestId, user_id: req.user.id },
  });
  if (!order) return sendError(res, 'Order not found', 404);
  if (order.status !== ORDER_STATUS.PENDING)
    return sendError(res, 'Only PENDING orders can be cancelled', 400);

  await order.update({ status: ORDER_STATUS.CANCELLED });

  await Transaction.create({
    user_id:      req.user.id,
    type:         TRANSACTION_TYPE.BET_CANCELLED,
    amount:       parseFloat(order.liable) || 0,
    description:  `Cancelled order ${order.request_id} (${order.side}@${order.price}, size:${order.size})`,
    status:       'completed',
    reference_id: String(order.request_id),
  });

  const freshData = await recalculateLiability(req.user.id);
  return sendSuccess(res, {
    orderId: order.request_id,
    wallet:  freshData?.wallet_balance,
    liable:  freshData?.liable,
  }, 'Order cancelled');
}

/* ─────────────────────────────────────────────────────────────
   cancelAllPendingOrders
────────────────────────────────────────────────────────────── */
async function cancelAllPendingOrders(req, res) {
  const [cancelledCount] = await Order.update(
    { status: ORDER_STATUS.CANCELLED },
    { where: { user_id: req.user.id, status: ORDER_STATUS.PENDING } },
  );
  await Transaction.create({
    user_id:     req.user.id,
    type:        TRANSACTION_TYPE.BET_CANCELLED_ALL,
    amount:      0,
    description: `Cancelled all ${cancelledCount} pending bets`,
    status:      'completed',
  });
  const freshData = await recalculateLiability(req.user.id);
  return sendSuccess(res, {
    cancelledCount,
    wallet: freshData?.wallet_balance,
    liable: freshData?.liable,
  }, 'All pending bets cancelled');
}

/* ─────────────────────────────────────────────────────────────
   triggerAutoMatch
────────────────────────────────────────────────────────────── */
async function triggerAutoMatch(req, res) {
  const { marketId } = req.params;
  const { selectionId } = req.body;
  if (selectionId) {
    await autoMatchPendingBets(marketId, selectionId);
    return sendSuccess(res, null, `Auto-match triggered for market ${marketId}, sel ${selectionId}`);
  }
  const pending = await Order.findAll({
    attributes: ['selection_id'],
    where: { market_id: marketId, status: ORDER_STATUS.PENDING },
    raw: true,
  });
  const unique = [...new Set(pending.map(o => o.selection_id))];
  await Promise.all(unique.map(selId => autoMatchPendingBets(marketId, selId)));
  return sendSuccess(res, { selections: unique.length }, `Auto-match triggered for ${unique.length} selections`);
}

/* ─────────────────────────────────────────────────────────────
   settleMarket — Admin route
────────────────────────────────────────────────────────────── */
async function settleMarket(req, res) {
  const { marketId } = req.params;
  const { winningSelectionId, commissionPct = 0 } = req.body;
  if (!winningSelectionId)
    return sendError(res, 'winningSelectionId is required', 400);

  const pct = Math.max(0, Math.min(100, parseFloat(commissionPct) || 0));
  const result = await settleEventBets(marketId, winningSelectionId, { commissionPct: pct });
  return sendSuccess(res, result, `Market ${marketId} settled. ${result.settled} users processed.`);
}

/* ─────────────────────────────────────────────────────────────
   voidMarket
────────────────────────────────────────────────────────────── */
async function voidMarket(req, res) {
  const { marketId } = req.params;
  const result = await voidMarketBets(marketId);
  return sendSuccess(res, result, `Market ${marketId} voided. ${result.voided} users affected.`);
}

/* ─────────────────────────────────────────────────────────────
   getMarketRunnerPnL
────────────────────────────────────────────────────────────── */
async function getMarketRunnerPnL(req, res) {
  const { marketId } = req.params;
  const userId = req.user.id;
  const summary = await getMarketPnLSummary(marketId, userId);
  return sendSuccess(res, { pnl: summary, marketId });
}

/* ─────────────────────────────────────────────────────────────
   getOrdersByEvent
────────────────────────────────────────────────────────────── */
async function getOrdersByEvent(req, res) {
  const { marketId, maxResults } = req.query;
  const userId = req.user.id;
  const where  = { user_id: userId };
  if (marketId && marketId !== 'undefined') where.market_id = marketId;
  const limit  = parseInt(maxResults, 10);
  const orders = await Order.findAll({
    where,
    order: [['created_at', 'DESC']],
    ...(limit > 0 ? { limit } : {}),
  });
  const formatted = orders.map(o => ({
    id:                   String(o.request_id),
    marketId:             o.market_id,
    selectionId:          String(o.selection_id),
    runnerName:           o.runner_name || '',
    eventName:            o.event_name || '',
    side:                 o.side,
    price:                parseFloat(o.price),
    size:                 parseFloat(o.size),
    matched:              parseFloat(o.matched),
    liable:               parseFloat(o.liable),
    profit:               o.side === BET_SIDE.BACK
                            ? parseFloat(((parseFloat(o.price) - 1) * parseFloat(o.matched || o.size)).toFixed(2))
                            : parseFloat(parseFloat(o.matched || o.size).toFixed(2)),
    status:               o.status,
    placedDate:           o.created_at,
    settled_at:           o.settled_at || null,
    winning_selection_id: o.winning_selection_id || null,
    settlementPnL:        o.status === ORDER_STATUS.SETTLED && o.winning_selection_id
                            ? computeSettlementPnL(o.toJSON()) : null,
  }));
  return sendSuccess(res, { orders: formatted });
}

/* ─────────────────────────────────────────────────────────────
   HELPERS
────────────────────────────────────────────────────────────── */
function enrichOrderWithPnL(order) {
  const price  = parseFloat(order.price);
  const size   = parseFloat(order.matched > 0 ? order.matched : order.size);
  const profit = order.side === BET_SIDE.BACK
    ? parseFloat(((price - 1) * size).toFixed(2))
    : parseFloat(size.toFixed(2));
  const liable = order.side === BET_SIDE.BACK
    ? parseFloat(size.toFixed(2))
    : parseFloat(((price - 1) * size).toFixed(2));
  return {
    ...order,
    profit,
    liable,
    runnerName: order.runner_name || '',
  };
}

/* ─────────────────────────────────────────────────────────────
   autoSettleMarket
   Betfair se winner detect karo aur settle karo
   POST /orders/auto-settle/:marketId
────────────────────────────────────────────────────────────── */
async function autoSettleMarket(req, res) {
  const { marketId } = req.params;

  try {
    const { manualSettle } = require('../services/autoSettle.service');
    await manualSettle(marketId);
    return sendSuccess(res, null, `Auto-settle triggered for market ${marketId}`);
  } catch (err) {
    logger.error(`autoSettleMarket error: ${err.message}`);
    return sendError(res, `Auto-settle failed: ${err.message}`, 500);
  }
}

module.exports = {
  placeBets,
  getPendingOrders,
  getMatchedOrders,
  getAllOrders,
  getSettledOrders,
  cancelOrder,
  cancelAllPendingOrders,
  triggerAutoMatch,
  settleMarket,
  voidMarket,
  getMarketRunnerPnL,
  getOrdersByEvent,
  autoSettleMarket,
};
