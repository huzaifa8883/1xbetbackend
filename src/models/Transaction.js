'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const { TRANSACTION_TYPE } = require('../config/constants');

class Transaction extends Model {}

Transaction.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    // IMPORTANT: Must be UNSIGNED to match users.id (BIGINT UNSIGNED)
    // Mismatch causes silent LEFT JOIN failures in MySQL
    user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
    },
    from_user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    to_user_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    type: {
      type: DataTypes.ENUM(...Object.values(TRANSACTION_TYPE)),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('pending', 'completed', 'failed'),
      allowNull: false,
      defaultValue: 'completed',
    },
    reference_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Order request_id or other external reference',
    },
  },
  {
    sequelize,
    modelName: 'Transaction',
    tableName: 'transactions',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['type'] },
      { fields: ['status'] },
    ],
  },
);

module.exports = Transaction;
