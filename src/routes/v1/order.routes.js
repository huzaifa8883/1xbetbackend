'use strict';

const express  = require('express');
const router   = express.Router();
const authenticate = require('../../middleware/authenticate');
const {
  placeBets, getPendingOrders, getMatchedOrders,
  getAllOrders, cancelOrder, cancelAllPendingOrders,
  triggerAutoMatch, getOrdersByEvent,
} = require('../../controllers/order.controller');

router.post('/',                    authenticate(),          placeBets);
router.get('/pending',              authenticate(),          getPendingOrders);
router.get('/matched',              authenticate(),          getMatchedOrders);
router.get('/all',                  authenticate(),          getAllOrders);
router.get('/event',                authenticate(),          getOrdersByEvent);
router.post('/:requestId/cancel',   authenticate(),          cancelOrder);
router.post('/cancel-all',          authenticate(),          cancelAllPendingOrders);
router.post('/auto-match/:marketId', /* internal */ triggerAutoMatch);

module.exports = router;
