'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');
const { ROLES } = require('../config/constants');

class User extends Model {}

User.init(
  {
    id: {
      type: DataTypes.BIGINT.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    username: {
      type: DataTypes.STRING(60),
      allowNull: false,
      unique: true,
    },
    password: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    role: {
      type: DataTypes.ENUM(...Object.values(ROLES)),
      allowNull: false,
      defaultValue: ROLES.USER,
    },
    parent_id: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
      defaultValue: null,
    },
    phone: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('Active', 'Inactive', 'Suspended'),
      allowNull: false,
      defaultValue: 'Active',
    },
    wallet_balance: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
      defaultValue: 0.0,
    },
    credit_balance: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
      defaultValue: 0.0,
    },
    liable: {
      type: DataTypes.DECIMAL(18, 2),
      allowNull: false,
      defaultValue: 0.0,
    },
    runner_pnl: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: null,
    },
    last_login: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    indexes: [
      { fields: ['username'] },
      { fields: ['parent_id'] },
      { fields: ['role'] },
      { fields: ['status'] },
    ],
  },
);

module.exports = User;
