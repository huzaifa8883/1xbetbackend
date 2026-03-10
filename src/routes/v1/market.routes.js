'use strict';

const { Router } = require('express');
const ctrl = require('../../controllers/market.controller');

const router = Router();

/* ── Betfair live data (public) ──────────────────────────── */

/**
 * @route   GET /api/v1/markets/live/cricket
 * @desc    Live cricket markets
 */
router.get('/live/cricket', ctrl.getLiveCricket);

/**
 * @route   GET /api/v1/markets/live/cricket/inplay
 * @desc    In-play cricket markets only
 */
router.get('/live/cricket/inplay', ctrl.getLiveCricketInplay);

/**
 * @route   GET /api/v1/markets/live/football
 * @desc    Live football markets
 */
router.get('/live/football', ctrl.getLiveFootball);

/**
 * @route   GET /api/v1/markets/live/tennis
 * @desc    Live tennis markets
 */
router.get('/live/tennis', ctrl.getLiveTennis);

/**
 * @route   GET /api/v1/markets/live/horse
 * @desc    US horse racing markets (past 6h → next 12h)
 */
router.get('/live/horse', ctrl.getLiveHorse);

/**
 * @route   GET /api/v1/markets/live/greyhound
 * @desc    Greyhound racing markets
 */
router.get('/live/greyhound', ctrl.getLiveGreyhound);

/**
 * @route   GET /api/v1/markets/live/sports/:id
 * @desc    Single market by ID or all sports markets (with optional ?eventTypeIds=)
 */
router.get('/live/sports/:id', ctrl.getLiveSport);

/**
 * @route   GET /api/v1/markets/Data?id=<marketId>
 * @desc    Formatted market book data (odds ladder format for frontend)
 */
router.get('/Data', ctrl.getMarketData);

/**
 * @route   GET /api/v1/markets/catalog2?id=<marketId>
 * @desc    Full market catalogue details
 */
router.get('/catalog2', ctrl.getMarketCatalog2);

/**
 * @route   GET /api/v1/markets/Navigation?id=<id>&type=<0|1|2>
 * @desc    Sports navigation tree (sports → competitions → events → markets)
 */
router.get('/Navigation', ctrl.getNavigation);

module.exports = router;
