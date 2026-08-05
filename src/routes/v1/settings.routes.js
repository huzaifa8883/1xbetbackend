'use strict';
const { Router } = require('express');
const ctrl = require('../../controllers/settings.controller');
const router = Router();

// ⚠️ Specific routes PEHLE — generic baad mein
router.get('/leagues/enabled/:sport', ctrl.getEnabledLeagues);
router.get('/leagues',                ctrl.getLeagues);
router.post('/leagues',               ctrl.saveLeagues);

// Market settings routes
router.get('/markets/:sport',         ctrl.getMarketSettingsBySport);
router.get('/markets',                ctrl.getMarketSettings);
router.post('/markets',               ctrl.saveMarketSettings);

// Match-specific market settings
router.get('/match-markets/:eventId',  ctrl.getMatchMarketSettings);
router.post('/match-markets',          ctrl.saveMatchMarketSettings);

module.exports = router;
