'use strict';

const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

class SportConfig extends Model {}

SportConfig.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    sport_key: {
      // cricket | football | tennis | horse | greyhound
      type: DataTypes.STRING(30),
      allowNull: false,
      unique: true,
    },
    sport_name: {
      type: DataTypes.STRING(60),
      allowNull: false,
    },
    event_type_id: {
      type: DataTypes.STRING(10),
      allowNull: false,
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    max_results: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 20,
    },
    // Comma-separated country codes e.g. "GB,AU,IE" — null = all
    allowed_countries: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    // Comma-separated competition/league IDs — null = all
    allowed_competition_ids: {
      type: DataTypes.TEXT,
      allowNull: true,
      defaultValue: null,
    },
    // Comma-separated market type codes e.g. "MATCH_ODDS,WINNER"
    market_types: {
      type: DataTypes.STRING(255),
      allowNull: false,
      defaultValue: 'MATCH_ODDS',
    },
    // Show only inplay matches?
    inplay_only: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Hours ahead to fetch (for horse/greyhound)
    hours_ahead: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 24,
    },
  },
  {
    sequelize,
    modelName: 'SportConfig',
    tableName: 'sport_configs',
    timestamps: true,
    underscored: true,
  },
);

module.exports = SportConfig;
