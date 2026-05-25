'use strict';

const express      = require('express');
const router       = express.Router();
const authenticate = require('../../middleware/authenticate');
const {
  placeBets,
  getPendingOrders,
  getMatchedOrders,
  getAllOrders,
  cancelOrder,
  cancelAllPendingOrders,
  triggerAutoMatch,
  settleMarket,
  voidMarket,
  getMarketRunnerPnL,
  getOrdersByEvent,
} = require('../../controllers/order.controller');

// ── User routes ────────────────────────────────────────────
router.post('/',                              authenticate(), placeBets);
router.get('/pending',                        authenticate(), getPendingOrders);
router.get('/matched',                        authenticate(), getMatchedOrders);
router.get('/all',                            authenticate(), getAllOrders);
router.get('/event',                          authenticate(), getOrdersByEvent);
router.post('/cancel-all',                    authenticate(), cancelAllPendingOrders);
router.post('/:requestId/cancel',             authenticate(), cancelOrder);

// ── Market P&L — per-runner breakdown for frontend ────────
router.get('/pnl/:marketId',                  authenticate(), getMarketRunnerPnL);

// ── Admin / internal routes ────────────────────────────────
router.post('/auto-match/:marketId',          triggerAutoMatch);
router.post('/settle/:marketId',              authenticate(), settleMarket);
router.post('/void/:marketId',                authenticate(), voidMarket);

module.exports = router;
