'use strict';

require('dotenv').config({ path: '../.env' });
const http = require('http');
const { Server: SocketServer } = require('socket.io');

const app = require('./app');
const { connectDatabase } = require('./config/database');
const { sequelize } = require('./config/database');
const { autoMatchPendingBets } = require('./services/order.service');
const { startMarketUpdateJob } = require('./jobs/market.job');
const { startAutoSettlement } = require('./services/autoSettle.service');
const logger = require('./utils/logger');

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const io = new SocketServer(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

global.io = io;

io.on('connection', (socket) => {
  logger.debug(`WS connected: ${socket.id}`);

  socket.on('JoinMatch', (matchId) => {
    socket.join(`match_${matchId}`);
    logger.debug(`Socket ${socket.id} joined match_${matchId}`);
  });

  socket.on('JoinUserRoom', (userId) => {
    socket.join(`user_${userId}`);
    logger.debug(`Socket ${socket.id} joined user_${userId}`);
  });

  socket.on('updateMarket', async ({ marketId, selectionId }) => {
    if (!marketId) return;
    try {
      if (selectionId) {
        await autoMatchPendingBets(marketId, selectionId);
      }
      io.emit('marketOddsUpdated', { marketId, selectionId });
    } catch (err) {
      logger.error(`Socket updateMarket error: ${err.message}`);
    }
  });

  socket.on('disconnect', () => {
    logger.debug(`WS disconnected: ${socket.id}`);
  });
});

async function bootstrap() {
  try {
    await connectDatabase();

    logger.info('Syncing database schema (alter: true)...');
    await sequelize.sync({ alter: false });
    logger.info('Database schema synchronised successfully!');

    startMarketUpdateJob(30_000);
    startAutoSettlement();  // ✅ AUTO SETTLE START

    server.listen(PORT, () => {
      logger.info(`🚀 BetPro server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    });
  } catch (err) {
    logger.error(`Bootstrap failed: ${err.message}`);
    process.exit(1);
  }
}

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    await sequelize.close();
    logger.info('MySQL connection closed. Process exiting.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled Rejection: ${reason}`);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

bootstrap();
