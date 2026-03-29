'use strict';

const { Router } = require('express');
const ctrl = require('../../controllers/order.controller');
const authenticate = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { placeBetRules } = require('../../validators');

const router = Router();

router.use(authenticate());

/**
 * @route   GET  /api/v1/orders
 * @desc    Get all orders for the authenticated user (with pagination + status filter)
 */
router.get('/', ctrl.getAllOrders);

/**
 * @route   POST /api/v1/orders
 * @desc    Place one or more bets
 */
router.post('/', placeBetRules, validate, ctrl.placeBets);

/**
 * @route   GET /api/v1/orders/pending
 * @desc    Get PENDING orders (optionally filtered by marketId)
 */
router.get('/pending', ctrl.getPendingOrders);

/**
 * @route   GET /api/v1/orders/matched
 * @desc    Get MATCHED orders (optionally filtered by marketId)
 */
router.get('/matched', ctrl.getMatchedOrders);

/**
 * @route   GET /api/v1/orders/event
 * @desc    Get orders by eventId/marketId — used by bundle0a.js (legacy bfexch compatibility)
 *          Accepts token via ?token= query param OR Authorization header
 */
router.get('/event', ctrl.getOrdersByEvent);

/**
 * @route   POST /api/v1/orders/cancel-all
 * @desc    Cancel all PENDING bets for the authenticated user
 */
router.post('/cancel-all', ctrl.cancelAllPendingOrders);

/**
 * @route   POST /api/v1/orders/auto-match/:marketId
 * @desc    Manually trigger auto-matching for a market (admin / internal use)
 */
router.post('/auto-match/:marketId', ctrl.triggerAutoMatch);

/**
 * @route   POST /api/v1/orders/:requestId/cancel
 * @desc    Cancel a single PENDING order
 */
router.post('/:requestId/cancel', ctrl.cancelOrder);

module.exports = router;
