'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const { ORDER_STATUS, BET_SIDE } = require('../config/constants');

class Order extends Model {}

Order.init(
  {
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
    },
    request_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true,
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    market_id: {
      type: DataTypes.STRING(60),
      allowNull: false,
    },
    selection_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    event_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    category: {
      type: DataTypes.STRING(60),
      allowNull: true,
    },
    side: {
      type: DataTypes.ENUM(BET_SIDE.BACK, BET_SIDE.LAY),
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('BACK', 'LAY'),
      allowNull: false,
    },
    price: {
      type: DataTypes.DECIMAL(10, 4),
      allowNull: false,
    },
    size: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
    },
    matched: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
      defaultValue: 0,
    },
    liable: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(ORDER_STATUS)),
      allowNull: false,
      defaultValue: ORDER_STATUS.PENDING,
    },
    settled_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'Order',
    tableName: 'orders',
    indexes: [
      { fields: ['user_id'] },
      { fields: ['market_id'] },
      { fields: ['status'] },
      { fields: ['market_id', 'selection_id', 'status'] },
    ],
  },
);

module.exports = Order;
