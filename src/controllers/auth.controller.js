'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../models');
const { sendSuccess, sendError } = require('../utils/response');
const { ROLES } = require('../config/constants');
const logger = require('../utils/logger');

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

/* ── POST /api/v1/auth/login ─────────────────────────────── */
async function login(req, res) {
  const { username, password } = req.body;

  /* ── SuperAdmin bypass ───────────────────────────────────── */
  const saUsername = process.env.SUPERADMIN_USERNAME || 'super123';
  const saPassword = process.env.SUPERADMIN_PASSWORD || '12345';

  if (username === saUsername && password === saPassword) {
    let sa = await User.findOne({ where: { role: ROLES.SUPERADMIN } });

    if (!sa) {
      const hashed = await bcrypt.hash(saPassword, 12);
      sa = await User.create({
        username: saUsername,
        password: hashed,
        role: ROLES.SUPERADMIN,
        wallet_balance: 1_000_000_000_000,
        status: 'Active',
      });
      logger.info('SuperAdmin created from seed credentials');
    }

    await sa.update({ last_login: new Date() });
    const token = signToken({ id: sa.id, username: sa.username, role: sa.role });
    const { password: _, ...safeUser } = sa.toJSON();
    return sendSuccess(res, { token, user: safeUser }, 'Login successful');
  }

  /* ── Normal login ────────────────────────────────────────── */
  const user = await User.findOne({ where: { username } });
  if (!user) return sendError(res, 'Invalid credentials', 401);
  if (user.status !== 'Active') return sendError(res, 'Account is not active', 403);

  const match = await bcrypt.compare(password, user.password);
  if (!match) return sendError(res, 'Invalid credentials', 401);

  await user.update({ last_login: new Date() });

  const token = signToken({ id: user.id, username: user.username, role: user.role });
  const { password: _, ...safeUser } = user.toJSON();
  return sendSuccess(res, { token, user: safeUser }, 'Login successful');
}

/* ── GET /api/v1/auth/me ─────────────────────────────────── */
async function me(req, res) {
  const user = await User.findByPk(req.user.id, { attributes: { exclude: ['password'] } });
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, { user });
}

module.exports = { login, me };
