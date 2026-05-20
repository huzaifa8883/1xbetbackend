'use strict';
const { Router } = require('express');
const ctrl = require('../../controllers/settings.controller');
const router = Router();

router.get('/leagues',  ctrl.getLeagues);
router.post('/leagues', ctrl.saveLeagues);

module.exports = router;