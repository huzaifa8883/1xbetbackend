'use strict';

const express      = require('express');
const router       = express.Router();
const authenticate = require('../../middleware/authenticate');
const {
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
} = require('../../controllers/order.controller');

// ── User routes ────────────────────────────────────────────
router.post('/',                              authenticate(), placeBets);
router.get('/pending',                        authenticate(), getPendingOrders);
router.get('/matched',                        authenticate(), getMatchedOrders);
router.get('/all',                            authenticate(), getAllOrders);
// ✅ NEW: Settled bets — statement/ledger page ke liye
router.get('/settled',                        authenticate(), getSettledOrders);
router.get('/event',                          authenticate(), getOrdersByEvent);
router.post('/cancel-all',                    authenticate(), cancelAllPendingOrders);
router.post('/:requestId/cancel',             authenticate(), cancelOrder);

// ── Market P&L ─────────────────────────────────────────────
router.get('/pnl/:marketId',                  authenticate(), getMarketRunnerPnL);

// ── Admin / internal routes ────────────────────────────────
router.post('/auto-match/:marketId',          triggerAutoMatch);
router.post('/settle/:marketId',              authenticate(), settleMarket);
router.post('/void/:marketId',                authenticate(), voidMarket);
// ── Auto-settle: betfair se winner detect kar ke settle karo ──
router.post('/auto-settle/:marketId',         authenticate(), autoSettleMarket);

module.exports = router;
