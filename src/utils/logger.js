'use strict';
const { createLogger, format, transports } = require('winston');
const path = require('path');
const LOG_DIR = process.env.LOG_DIR || 'logs';

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.printf(({ timestamp, level, message, stack }) =>
      stack ? `${timestamp} [${level}]: ${message}\n${stack}` : `${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [
    new transports.Console(),
    new transports.File({ filename: path.join(LOG_DIR, 'error.log'), level: 'error' }),
    new transports.File({ filename: path.join(LOG_DIR, 'combined.log') }),
  ],
});

module.exports = logger;
