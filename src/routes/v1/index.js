'use strict';

const express = require('express');
const router  = express.Router();

const authRoutes    = require('./auth.routes');
const orderRoutes   = require('./order.routes');
const marketRoutes  = require('./market.routes');
const userRoutes    = require('./user.routes');

router.use('/auth',    authRoutes);
router.use('/orders',  orderRoutes);
router.use('/markets', marketRoutes);
router.use('/users',   userRoutes);

module.exports = router;
