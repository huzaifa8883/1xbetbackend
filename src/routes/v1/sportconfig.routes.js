'use strict';

const { Router } = require('express');
const ctrl = require('../../controllers/sportconfig.controller');
const authenticate = require('../../middleware/authenticate');
const { ROLES } = require('../../config/constants');

const router = Router();

// All sport config routes — SuperAdmin only
router.use(authenticate(ROLES.SUPERADMIN));

router.get('/',                       ctrl.getAllConfigs);
router.get('/:key',                   ctrl.getConfig);
router.put('/:key',                   ctrl.updateConfig);
router.get('/:key/competitions',      ctrl.getCompetitions);

module.exports = router;
