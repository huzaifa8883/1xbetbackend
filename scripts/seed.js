/**
 * scripts/seed.js
 * Run with: node scripts/seed.js
 *
 * Creates the SuperAdmin user if it doesn't already exist.
 */
'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { connectDatabase, sequelize } = require('../src/config/database');
const { User } = require('../src/models');
const { ROLES } = require('../src/config/constants');
const logger = require('../src/utils/logger');

const SA_USERNAME = process.env.SUPERADMIN_USERNAME || 'super123';
const SA_PASSWORD = process.env.SUPERADMIN_PASSWORD || '12345';

(async () => {
  try {
    await connectDatabase();
    await sequelize.sync({ alter: true });

    const existing = await User.findOne({ where: { role: ROLES.SUPERADMIN } });
    if (existing) {
      logger.info(`SuperAdmin already exists (id=${existing.id})`);
      process.exit(0);
    }

    const hashed = await bcrypt.hash(SA_PASSWORD, 12);
    const sa = await User.create({
      username: SA_USERNAME,
      password: hashed,
      role: ROLES.SUPERADMIN,
      wallet_balance: 1_000_000_000_000,
      status: 'Active',
    });

    logger.info(`✅ SuperAdmin created (id=${sa.id}, username=${sa.username})`);
    process.exit(0);
  } catch (err) {
    logger.error(`Seed failed: ${err.message}`);
    process.exit(1);
  }
})();
