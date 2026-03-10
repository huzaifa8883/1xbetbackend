'use strict';

const { updateActiveMarkets } = require('../services/order.service');
const logger = require('../utils/logger');

let _marketJobTimer = null;

/**
 * Start the recurring market update + auto-match job.
 * @param {number} intervalMs  How often to run (default: 30 000 ms)
 */
function startMarketUpdateJob(intervalMs = 30_000) {
  if (_marketJobTimer) {
    logger.warn('Market update job is already running');
    return;
  }

  _marketJobTimer = setInterval(async () => {
    logger.debug('Running market update job...');
    try {
      await updateActiveMarkets();
      logger.debug('Market update job completed');
    } catch (err) {
      logger.error(`Market update job error: ${err.message}`);
    }
  }, intervalMs);

  logger.info(`Market update job started (interval: ${intervalMs / 1000}s)`);
}

function stopMarketUpdateJob() {
  if (_marketJobTimer) {
    clearInterval(_marketJobTimer);
    _marketJobTimer = null;
    logger.info('Market update job stopped');
  }
}

module.exports = { startMarketUpdateJob, stopMarketUpdateJob };
