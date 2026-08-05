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
 * @desc    Horse racing markets
 */
router.get('/live/horse', ctrl.getLiveHorse);

/**
 * @route   GET /api/v1/markets/live/greyhound
 * @desc    Greyhound racing markets
 */
router.get('/live/greyhound', ctrl.getLiveGreyhound);

/**
 * @route   GET /api/v1/markets/live/sports/:id
 * @desc    Single market by ID or all sports (with optional ?eventTypeIds=)
 */
router.get('/live/sports/:id', ctrl.getLiveSport);

/* ── Market detail endpoints ─────────────────────────────── */

/**
 * @route   GET /api/v1/markets/Data?id=<marketId>
 * @desc    Formatted market book (odds ladder for frontend)
 */
router.get('/Data', ctrl.getMarketData);

/**
 * @route   GET /api/v1/markets/catalog2?id=<marketId>
 * @desc    Full market catalogue details (used by market.html)
 */
router.get('/catalog2', ctrl.getMarketCatalog2);

/**
 * @route   GET /api/v1/markets/Navigation?id=<id>&type=<0|1|2>
 * @desc    Sports navigation tree (sports → competitions → events → markets)
 */
router.get('/Navigation', ctrl.getNavigation);

/* ── NEW: All markets for a single event (match) ─────────── */

/**
 * @route   GET /api/v1/markets/event-markets?eventId=<eventId>
 * @desc    Ek match ke SAARE Betfair markets ek saath:
 *          Match Odds + Bookmaker + Toss + Fancy + Fancy2 + Figure + Others
 *          market.html frontend isko use karta hai baaki tabs show karne ke liye.
 *
 * @example GET /api/v1/markets/event-markets?eventId=33271234
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     matchOdds:  [ { marketId, marketName, marketType, runners:[...] } ],
 *     bookmaker:  [ ... ],
 *     toss:       [ ... ],
 *     fancy:      [ ... ],
 *     fancy2:     [ ... ],
 *     figure:     [ ... ],
 *     oddFigure:  [ ... ],
 *     other:      [ ... ],
 *     all:        [ ... ]   // flat list of all markets
 *   }
 * }
 */
router.get('/event-markets', ctrl.getEventMarkets);

/* ── Admin: Betfair data for admin panel ─────────────────── */

/**
 * @route   GET /api/v1/markets/betfair/competitions?eventTypeId=<id>
 * @desc    Betfair se live competitions (leagues) fetch karo
 */
router.get('/betfair/competitions', ctrl.getBetfairCompetitions);

/**
 * @route   GET /api/v1/markets/betfair/active-leagues?eventTypeId=<id>&hoursAhead=48
 * @desc    Sirf wahi leagues jinke matches abhi ya agle N ghanton (default
 *          48 = 2 din) mein hain — har league ke saath uske matches
 *          (eventId, name, startTime) bhi. Admin panel drill-down UI ke liye.
 */
router.get('/betfair/active-leagues', ctrl.getBetfairActiveLeagues);

/**
 * @route   GET /api/v1/markets/betfair/market-types?eventTypeId=<id>
 * @desc    Betfair se available market types fetch karo
 */
router.get('/betfair/market-types', ctrl.getBetfairMarketTypes);

/**
 * @route   GET /api/v1/markets/betfair/tracks?eventTypeId=<7|4339>
 * @desc    Horse Racing (7) / Greyhound (4339) ke liye Country → Track
 *          hierarchy — competitions ki jagah, kyunki racing sports
 *          Betfair pe competition-based nahi hote.
 */
router.get('/betfair/tracks', ctrl.getBetfairTracks);

module.exports = router;
