'use strict';

const User = require('./User');
const Order = require('./Order');
const Transaction = require('./Transaction');
const SportConfig = require('./SportConfig');

/* ── Associations ─────────────────────────────────────────── */

User.hasMany(User, { foreignKey: 'parent_id', as: 'children', constraints: false });
User.belongsTo(User, { foreignKey: 'parent_id', as: 'parent', constraints: false });

User.hasMany(Order, { foreignKey: 'user_id', as: 'orders' });
Order.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasMany(Transaction, { foreignKey: 'user_id', as: 'transactions' });
Transaction.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

module.exports = { User, Order, Transaction, SportConfig };
