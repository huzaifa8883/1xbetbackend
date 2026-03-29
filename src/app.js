'use strict';

require('dotenv').config();
require('express-async-errors');

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./utils/logger');
const v1Router = require('./routes/v1');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');

const app = express();

/* ─────────────────────────────────────────────────────────── */
/* Trust proxy (needed behind Nginx / Aiven / Railway etc.)   */
/* Without this, req.ip and x-forwarded-proto are unreliable  */
/* ─────────────────────────────────────────────────────────── */
app.set('trust proxy', 1);

/* ─────────────────────────────────────────────────────────── */
/* Force HTTPS — redirect any HTTP request to HTTPS           */
/* Works when behind a reverse proxy that sets x-forwarded-*  */
/* ─────────────────────────────────────────────────────────── */
app.use((req, res, next) => {
  if (req.headers['x-forwarded-proto'] && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});

/* ─────────────────────────────────────────────────────────── */
/* Security headers                                            */
/* ─────────────────────────────────────────────────────────── */
app.use(helmet());

/* ─────────────────────────────────────────────────────────── */
/* CORS                                                        */
/* ─────────────────────────────────────────────────────────── */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow server-to-server / Postman / curl (no origin header)
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      logger.warn(`CORS blocked for origin: ${origin}`);
      cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }),
);

/* ─────────────────────────────────────────────────────────── */
/* Body parsing + compression                                  */
/* ─────────────────────────────────────────────────────────── */
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(compression());

/* ─────────────────────────────────────────────────────────── */
/* HTTP request logging                                        */
/* ─────────────────────────────────────────────────────────── */
app.use(
  morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip: (req) => req.url === '/api/health',
  }),
);

/* ─────────────────────────────────────────────────────────── */
/* Rate limiting                                               */
/* ─────────────────────────────────────────────────────────── */
app.use(
  '/api',
  rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX || '1000', 10),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many requests, please try again later.' },
  }),
);

/* ─────────────────────────────────────────────────────────── */
/* Health check                                                */
/* ─────────────────────────────────────────────────────────── */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: process.env.npm_package_version || '2.0.0' });
});

/* ─────────────────────────────────────────────────────────── */
/* Versioned API routes                                        */
/* ─────────────────────────────────────────────────────────── */
app.use('/api/v1', v1Router);

/* ─────────────────────────────────────────────────────────── */
/* 404 + global error handler                                  */
/* ─────────────────────────────────────────────────────────── */
app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
