/**
 * scripts/seed-sport-config.js
 * Run: node scripts/seed-sport-config.js
 * Seeds default sport configs if not already present
 */
'use strict';

require('dotenv').config();
const { connectDatabase, sequelize } = require('../src/config/database');
const { SportConfig } = require('../src/models');
const logger = require('../src/utils/logger');

const DEFAULTS = [
  { sport_key: 'cricket',   sport_name: 'Cricket',          event_type_id: '4',    max_results: 20,  market_types: 'MATCH_ODDS', hours_ahead: 24,  is_active: true },
  { sport_key: 'football',  sport_name: 'Football',         event_type_id: '1',    max_results: 20,  market_types: 'MATCH_ODDS', hours_ahead: 24,  is_active: true },
  { sport_key: 'tennis',    sport_name: 'Tennis',           event_type_id: '2',    max_results: 20,  market_types: 'MATCH_ODDS', hours_ahead: 24,  is_active: true },
  { sport_key: 'horse',     sport_name: 'Horse Racing',     event_type_id: '7',    max_results: 100, market_types: 'WIN',        hours_ahead: 24,  is_active: true },
  { sport_key: 'greyhound', sport_name: 'Greyhound Racing', event_type_id: '4339', max_results: 100, market_types: 'WIN',        hours_ahead: 12,  is_active: true },
];

(async () => {
  try {
    await connectDatabase();
    await sequelize.sync({ alter: true });

    for (const cfg of DEFAULTS) {
      const [record, created] = await SportConfig.findOrCreate({
        where: { sport_key: cfg.sport_key },
        defaults: cfg,
      });
      logger.info(`${created ? 'Created' : 'Already exists'}: ${cfg.sport_key}`);
    }

    logger.info('✅ Sport configs seeded');
    process.exit(0);
  } catch (err) {
    logger.error('Seed failed: ' + err.message);
    process.exit(1);
  }
})();
