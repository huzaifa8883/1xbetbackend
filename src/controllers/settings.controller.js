'use strict';
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../utils/logger');

// Simple in-memory store (production mein DB use karo)
// Ya ek JSON file mein persist karo
const fs   = require('fs');
const path = require('path');
const STORE_PATH = path.join(__dirname, '../../data/league-settings.json');

function readStore() {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error('writeStore error: ' + e.message);
  }
}

async function getLeagues(req, res) {
  const store = readStore();
  return sendSuccess(res, store);
}

async function saveLeagues(req, res) {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return sendError(res, 'Invalid payload', 400);
  }
  writeStore(payload);

  // ✅ SportConfig DB bhi update karo taake fetchSportMarkets kaam kare
  const { SportConfig } = require('../models');

  // Admin sport key → market controller sport key mapping
  const SPORT_KEY_MAP = {
    cricket:      'cricket',
    football:     'football',
    tennis:       'tennis',
    horse_racing: 'horse',
    greyhounds:   'greyhound',
  };

  try {
    const DEFAULTS_MAP = {
      cricket:   { sport_name: 'Cricket',          event_type_id: '4',    max_results: 20, market_types: 'MATCH_ODDS', hours_ahead: 24 },
      football:  { sport_name: 'Football',         event_type_id: '1',    max_results: 20, market_types: 'MATCH_ODDS', hours_ahead: 24 },
      tennis:    { sport_name: 'Tennis',           event_type_id: '2',    max_results: 20, market_types: 'MATCH_ODDS', hours_ahead: 24 },
      horse:     { sport_name: 'Horse Racing',     event_type_id: '7',    max_results: 100, market_types: 'WIN',        hours_ahead: 24 },
      greyhound: { sport_name: 'Greyhound Racing', event_type_id: '4339', max_results: 100, market_types: 'WIN',        hours_ahead: 12 },
    };

    for (const [adminKey, ids] of Object.entries(payload)) {
      const sportKey = SPORT_KEY_MAP[adminKey] || adminKey;
      const competitionIds = (ids.enabledLeagueIds || []).join(',');

      // Sirf allowed_competition_ids update karo — baaki fields (event_type_id, etc.) intact rahe
      const [rowsUpdated] = await SportConfig.update(
        { allowed_competition_ids: competitionIds || null },
        { where: { sport_key: sportKey } }
      );

      if (rowsUpdated === 0) {
        // Row exist nahi karti — defaults se create karo
        const def = DEFAULTS_MAP[sportKey];
        if (def) {
          await SportConfig.create({
            sport_key: sportKey,
            ...def,
            allowed_competition_ids: competitionIds || null,
            is_active: true,
          });
        }
      }
    }
    logger.info('League settings saved + SportConfig updated');
  } catch (e) {
    logger.error('SportConfig update error: ' + e.message);
    // JSON file save ho gayi, DB update fail hua — partial success
  }

  return sendSuccess(res, { message: 'Saved successfully' });
}

// GET /api/v1/settings/leagues/enabled/:sport
// Dashboard call karta hai: sirf us sport ke enabledLeagueIds return karo
async function getEnabledLeagues(req, res) {
  const sport = req.params.sport;
  if (!sport) return sendError(res, 'sport param required', 400);

  const store = readStore();
  const sportData = store[sport];

  if (!sportData || !Array.isArray(sportData.enabledLeagueIds)) {
    // Koi setting nahi → sab show karo (filter mat karo)
    return sendSuccess(res, { sport, enabledLeagueIds: null, filterActive: false });
  }

  return sendSuccess(res, {
    sport,
    enabledLeagueIds: sportData.enabledLeagueIds,
    filterActive: sportData.enabledLeagueIds.length > 0,
  });
}

module.exports = { getLeagues, saveLeagues, getEnabledLeagues };

/* ─────────────────────────────────────────────────────────────
   MARKET SETTINGS  —  enabled market IDs per sport
   File: data/market-settings.json
   Format: { cricket: ['match_odds','toss'], football: ['match_odds'], ... }
───────────────────────────────────────────────────────────── */

const MARKET_STORE_PATH = path.join(__dirname, '../../data/market-settings.json');

function readMarketStore() {
  try {
    if (fs.existsSync(MARKET_STORE_PATH)) {
      return JSON.parse(fs.readFileSync(MARKET_STORE_PATH, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function writeMarketStore(data) {
  try {
    fs.mkdirSync(path.dirname(MARKET_STORE_PATH), { recursive: true });
    fs.writeFileSync(MARKET_STORE_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error('writeMarketStore error: ' + e.message);
  }
}

// GET /api/v1/settings/markets
// Returns { cricket: ['match_odds','toss'], football: [...], ... }
async function getMarketSettings(req, res) {
  const store = readMarketStore();
  return sendSuccess(res, store);
}

// POST /api/v1/settings/markets
// Body: { cricket: ['match_odds','toss'], football: ['match_odds'], ... }
async function saveMarketSettings(req, res) {
  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return sendError(res, 'Invalid payload', 400);
  }
  writeMarketStore(payload);
  logger.info('Market settings saved: ' + JSON.stringify(payload));
  return sendSuccess(res, { message: 'Market settings saved' });
}

// GET /api/v1/settings/markets/:sport
// Returns { sport, enabledMarketIds: ['match_odds','toss'], filterActive: true }
async function getMarketSettingsBySport(req, res) {
  const sport = req.params.sport;
  if (!sport) return sendError(res, 'sport param required', 400);
  const store = readMarketStore();
  const ids = store[sport];
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return sendSuccess(res, { sport, enabledMarketIds: null, filterActive: false });
  }
  return sendSuccess(res, { sport, enabledMarketIds: ids, filterActive: true });
}

module.exports = { getLeagues, saveLeagues, getEnabledLeagues, getMarketSettings, saveMarketSettings, getMarketSettingsBySport };
