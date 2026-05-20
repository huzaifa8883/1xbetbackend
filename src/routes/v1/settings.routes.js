'use strict';
const { Router } = require('express');
const ctrl = require('../../controllers/settings.controller');
const router = Router();

// ⚠️ /enabled/:sport PEHLE hona chahiye — warna /leagues GET se conflict hoga
router.get('/leagues/enabled/:sport', ctrl.getEnabledLeagues);  // ← PEHLE
router.get('/leagues',               ctrl.getLeagues);
router.post('/leagues',              ctrl.saveLeagues);

module.exports = router;
