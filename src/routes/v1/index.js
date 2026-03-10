'use strict';

const { Router } = require('express');

const authRoutes        = require('./auth.routes');
const userRoutes        = require('./user.routes');
const orderRoutes       = require('./order.routes');
const marketRoutes      = require('./market.routes');
const sportConfigRoutes = require('./sportconfig.routes');

const router = Router();

router.use('/auth',         authRoutes);
router.use('/users',        userRoutes);
router.use('/orders',       orderRoutes);
router.use('/markets',      marketRoutes);
router.use('/sport-config', sportConfigRoutes);

module.exports = router;
