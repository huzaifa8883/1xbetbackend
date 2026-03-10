'use strict';

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

const { LOG_LEVEL, LOG_DIR, NODE_ENV } = process.env;

const logDir = path.resolve(LOG_DIR || 'logs');

const { combine, timestamp, errors, json, colorize, printf } = winston.format;

const consoleFormat = printf(({ level, message, timestamp: ts, stack }) => {
  return `${ts} [${level}]: ${stack || message}`;
});

const transports = [
  /* ── Console ────────────────────────────────────────────── */
  new winston.transports.Console({
    level: NODE_ENV === 'production' ? 'warn' : LOG_LEVEL || 'debug',
    format: combine(
      colorize(),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      consoleFormat,
    ),
  }),
];

/* ── File rotation (production / staging) ───────────────── */
if (NODE_ENV !== 'test') {
  transports.push(
    new DailyRotateFile({
      dirname: logDir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      level: 'info',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
    new DailyRotateFile({
      dirname: logDir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: combine(timestamp(), errors({ stack: true }), json()),
    }),
  );
}

const logger = winston.createLogger({
  level: LOG_LEVEL || 'info',
  transports,
  exitOnError: false,
});

module.exports = logger;
