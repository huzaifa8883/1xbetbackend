'use strict';

const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { User, Transaction } = require('../models');
const { sendSuccess, sendError } = require('../utils/response');
const { CREATION_PERMISSIONS, ROLE_HIERARCHY, TRANSACTION_TYPE } = require('../config/constants');
const logger = require('../utils/logger');

/* ── GET /api/v1/users ───────────────────────────────────── */
async function listUsers(req, res) {
  const { role, status, page = 1, limit = 50 } = req.query;
  const where = {};
  if (role) where.role = role;
  if (status) where.status = status;

  const { count, rows } = await User.findAndCountAll({
    where,
    attributes: { exclude: ['password'] },
    limit: parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
    order: [['created_at', 'DESC']],
  });

  return sendSuccess(res, {
    users: rows,
    pagination: { total: count, page: parseInt(page, 10), limit: parseInt(limit, 10) },
  });
}


/* ── GET /api/v1/users/:role-alias ──────────────────────── */
/* Handles /masters  /supermasters  /admin  /user           */
function listByRole(role) {
  return async function (req, res) {
    try {
      const users = await User.findAll({
        where: { role },
        attributes: { exclude: ['password'] },
        order: [['created_at', 'DESC']],
      });

      // Return field name matching what Admin.html expects:
      //   /masters, /supermasters  → { masters: [...] }
      //   /admin                   → { admins:  [...] }
      //   /user                    → { users:   [...] }
      let key = 'users';
      if (role === 'Master' || role === 'SuperMaster') key = 'masters';
      if (role === 'Admin') key = 'admins';

      return sendSuccess(res, { [key]: users, users });
    } catch (err) {
      return sendError(res, err.message, 500);
    }
  };
}

/* ── POST /api/v1/users ──────────────────────────────────── */
async function createUser(req, res) {
  try {
    const { username, password, phone, role, initial_balance = 0 } = req.body;
    const creator = req.user;

    if (!username || !password || !role) {
      return sendError(res, 'username, password and role are required', 400);
    }

    const allowed = CREATION_PERMISSIONS[creator.role] || [];
    if (!allowed.includes(role)) {
      return sendError(res, `Your role cannot create a '${role}' user`, 403);
    }

    // MySQL case-insensitive compare (Op.like on MySQL is case-insensitive by default)
    const existing = await User.findOne({ where: { username: { [Op.like]: username } } });
    if (existing) return sendError(res, 'Username already exists', 409);

    const hashedPwd = await bcrypt.hash(password, 12);
    const newUser = await User.create({
      username: username.trim(),
      password: hashedPwd,
      role,
      parent_id: creator.id,
      phone: phone || null,
      wallet_balance: parseFloat(initial_balance) || 0,
      status: 'Active',
    });

    const { password: _, ...safe } = newUser.toJSON();
    return sendSuccess(res, { user: safe }, `${role} created successfully`, 201);
  } catch (err) {
    logger.error('createUser error: ' + err.message);
    if (err.name === 'SequelizeUniqueConstraintError') {
      return sendError(res, 'Username already exists', 409);
    }
    if (err.name === 'SequelizeDatabaseError') {
      return sendError(res, 'Database error: ' + err.message, 500);
    }
    return sendError(res, err.message || 'Server error', 500);
  }
}

/* ── GET /api/v1/users/me ────────────────────────────────── */
async function getMe(req, res) {
  const user = await User.findByPk(req.user.id, { attributes: { exclude: ['password'] } });
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, { user });
}

/* ── GET /api/v1/users/downline ──────────────────────────── */
async function getDownline(req, res) {
  const { parentId } = req.query;
  const searchParentId = parentId ? parseInt(parentId, 10) : req.user.id;

  const users = await User.findAll({
    where: { parent_id: searchParentId },
    attributes: { exclude: ['password'] },
    order: [['created_at', 'DESC']],
  });

  return sendSuccess(res, { users });
}

/* ── GET /api/v1/users/:id ───────────────────────────────── */
async function getUser(req, res) {
  const user = await User.findByPk(req.params.id, { attributes: { exclude: ['password'] } });
  if (!user) return sendError(res, 'User not found', 404);
  return sendSuccess(res, { user });
}

/* ── PUT /api/v1/users/:id ───────────────────────────────── */
async function updateUser(req, res) {
  const { password, username, phone, status } = req.body;
  const user = await User.findByPk(req.params.id);
  if (!user) return sendError(res, 'User not found', 404);

  const updates = {};
  if (phone !== undefined) updates.phone = phone;
  if (status !== undefined) updates.status = status;
  if (username !== undefined) {
    const dup = await User.findOne({ where: { username: { [Op.like]: username }, id: { [Op.ne]: user.id } } });
    if (dup) return sendError(res, 'Username already taken', 409);
    updates.username = username;
  }
  if (password) updates.password = await bcrypt.hash(password, 12);

  await user.update(updates);
  const { password: _, ...safe } = user.toJSON();
  return sendSuccess(res, { user: safe }, 'User updated');
}

/* ── DELETE /api/v1/users/:id ───────────────────────────── */
async function deleteUser(req, res) {
  const user = await User.findByPk(req.params.id);
  if (!user) return sendError(res, 'User not found', 404);
  await user.destroy();
  return sendSuccess(res, null, 'User deleted');
}

/* ── POST /api/v1/users/transaction ─────────────────────── */
async function processTransaction(req, res) {
  const { type, amount, userId, description } = req.body;
  const txAmount = parseFloat(amount);

  const [currentUser, targetUser] = await Promise.all([
    User.findByPk(req.user.id),
    User.findByPk(userId),
  ]);

  if (!currentUser || !targetUser) return sendError(res, 'User not found', 404);

  const currentLevel = ROLE_HIERARCHY[currentUser.role] ?? 0;
  const targetLevel = ROLE_HIERARCHY[targetUser.role] ?? 0;
  if (currentLevel <= targetLevel) return sendError(res, 'Insufficient permissions', 403);

  if (type === TRANSACTION_TYPE.DEPOSIT && parseFloat(currentUser.wallet_balance) < txAmount) {
    return sendError(res, 'Insufficient balance', 400);
  }
  if (type === TRANSACTION_TYPE.WITHDRAWAL && parseFloat(targetUser.wallet_balance) < txAmount) {
    return sendError(res, 'Target user has insufficient balance', 400);
  }

  const t = await sequelize.transaction();
  try {
    const senderDelta = type === TRANSACTION_TYPE.DEPOSIT ? -txAmount : txAmount;
    const receiverDelta = type === TRANSACTION_TYPE.DEPOSIT ? txAmount : -txAmount;

    await currentUser.update({ wallet_balance: parseFloat(currentUser.wallet_balance) + senderDelta }, { transaction: t });
    await targetUser.update({ wallet_balance: parseFloat(targetUser.wallet_balance) + receiverDelta }, { transaction: t });

    const txBase = { from_user_id: currentUser.id, to_user_id: targetUser.id, amount: txAmount, description, status: 'completed' };
    await Transaction.bulkCreate([
      { ...txBase, user_id: currentUser.id, type },
      { ...txBase, user_id: targetUser.id, type },
    ], { transaction: t });

    await t.commit();

    return sendSuccess(res, {
      currentUserBalance: parseFloat(currentUser.wallet_balance) + senderDelta,
      targetUserBalance: parseFloat(targetUser.wallet_balance) + receiverDelta,
    }, `${type === TRANSACTION_TYPE.DEPOSIT ? 'Deposit' : 'Withdrawal'} successful`);
  } catch (err) {
    await t.rollback();
    logger.error(`Transaction error: ${err.message}`);
    return sendError(res, 'Transaction failed', 500);
  }
}

/* ── POST /api/v1/users/credit-transaction ───────────────── */
async function processCreditTransaction(req, res) {
  const { type, amount, userId, description } = req.body;
  const txAmount = parseFloat(amount);

  const [currentUser, targetUser] = await Promise.all([
    User.findByPk(req.user.id),
    User.findByPk(userId),
  ]);

  if (!currentUser || !targetUser) return sendError(res, 'User not found', 404);

  const currentLevel = ROLE_HIERARCHY[currentUser.role] ?? 0;
  const targetLevel = ROLE_HIERARCHY[targetUser.role] ?? 0;
  if (currentLevel <= targetLevel) return sendError(res, 'Insufficient permissions', 403);

  if (type === TRANSACTION_TYPE.CREDIT_DEPOSIT) {
    if (parseFloat(currentUser.wallet_balance) < txAmount) {
      return sendError(res, 'Insufficient wallet balance', 400);
    }
    await currentUser.update({ wallet_balance: parseFloat(currentUser.wallet_balance) - txAmount });
    await targetUser.update({ credit_balance: parseFloat(targetUser.credit_balance) + txAmount });
  } else if (type === TRANSACTION_TYPE.CREDIT_WITHDRAWAL) {
    if (parseFloat(targetUser.credit_balance) < txAmount) {
      return sendError(res, 'Insufficient credit balance', 400);
    }
    await targetUser.update({ credit_balance: parseFloat(targetUser.credit_balance) - txAmount });
  } else {
    return sendError(res, 'Invalid transaction type', 400);
  }

  await Transaction.create({
    user_id: targetUser.id,
    from_user_id: currentUser.id,
    to_user_id: targetUser.id,
    type,
    amount: txAmount,
    description,
    status: 'completed',
  });

  const [updatedTarget, updatedCurrent] = await Promise.all([
    User.findByPk(targetUser.id, { attributes: { exclude: ['password'] } }),
    User.findByPk(currentUser.id, { attributes: { exclude: ['password'] } }),
  ]);
  return sendSuccess(res, {
    user: updatedTarget,
    newCreditBalance: parseFloat(updatedTarget.credit_balance),
    currentUserBalance: parseFloat(updatedCurrent.wallet_balance),
  }, 'Credit transaction successful');
}

/* ── GET /api/v1/users/:id/transactions ─────────────────── */
async function getUserTransactions(req, res) {
  const { page = 1, limit = 50, type } = req.query;
  const where = { user_id: req.params.id };
  if (type) where.type = type;

  const { count, rows } = await Transaction.findAndCountAll({
    where,
    limit: parseInt(limit, 10),
    offset: (parseInt(page, 10) - 1) * parseInt(limit, 10),
    order: [['created_at', 'DESC']],
  });

  return sendSuccess(res, {
    transactions: rows,
    pagination: { total: count, page: parseInt(page, 10), limit: parseInt(limit, 10) },
  });
}

module.exports = {
  listUsers,
  listByRole,
  createUser,
  getMe,
  getDownline,
  getUser,
  updateUser,
  deleteUser,
  processTransaction,
  processCreditTransaction,
  getUserTransactions,
};
