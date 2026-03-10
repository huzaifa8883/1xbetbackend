'use strict';

const logger = require('../utils/logger');
const { sendError } = require('../utils/response');

/**
 * Centralised error handler – must be registered LAST in app.use() chain.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  logger.error(`[${req.method} ${req.originalUrl}] ${err.stack || err.message}`);

  // Sequelize / MySQL validation errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    const messages = err.errors?.map((e) => e.message) ?? [err.message];
    return sendError(res, 'Validation error', 400, messages);
  }

  if (err.name === 'SequelizeDatabaseError') {
    // Log full error for debugging
    logger.error('SequelizeDatabaseError: ' + err.message + ' | SQL: ' + (err.sql || 'N/A'));
    return sendError(res, 'Database error: ' + err.message, 500);
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  return sendError(res, message, status);
}

/**
 * 404 handler – register just before errorHandler.
 */
function notFoundHandler(req, res) {
  return sendError(res, `Route ${req.method} ${req.originalUrl} not found`, 404);
}

module.exports = { errorHandler, notFoundHandler };
