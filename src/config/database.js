'use strict';

const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');

const {
  DB_HOST,
  DB_PORT,
  DB_NAME,
  DB_USER,
  DB_PASSWORD,
  DB_CONNECTION_LIMIT,
  DB_TIMEZONE,
  NODE_ENV,
} = process.env;

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST || 'localhost',
  port: parseInt(DB_PORT || '3306', 10),
  dialect: 'mysql',
  timezone: DB_TIMEZONE || '+00:00',
  logging: NODE_ENV === 'development' ? (msg) => logger.debug(msg) : false,

  dialectOptions: {
    ssl: {
      rejectUnauthorized: false
    }
  },

  pool: {
    max: parseInt(DB_CONNECTION_LIMIT || '20', 10),
    min: 2,
    acquire: 30000,
    idle: 10000,
  },

  define: {
    timestamps: true,
    underscored: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
});

/**
 * Verify and initialise the database connection.
 * Called once at application startup.
 */
async function connectDatabase() {
  await sequelize.authenticate();
  logger.info('✅ MySQL connected successfully');
}

module.exports = { sequelize, connectDatabase };
