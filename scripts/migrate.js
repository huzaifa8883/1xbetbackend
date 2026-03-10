/**
 * scripts/migrate.js
 * Run: node scripts/migrate.js
 */
'use strict';

require('dotenv').config();

const { connectDatabase, sequelize } = require('../src/config/database');
require('../src/models');   // Register all models + associations
const logger = require('../src/utils/logger');

(async () => {
  try {
    await connectDatabase();
    // alter:true updates columns without dropping tables
    await sequelize.sync({ force: false, alter: true });
    logger.info('✅ All tables created/updated successfully');
    process.exit(0);
  } catch (err) {
    logger.error('Migration failed: ' + err.message);
    console.error('Full error:', err);
    process.exit(1);
  }
})();
