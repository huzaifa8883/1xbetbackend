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
  const payload = req.body;  // { cricket: { enabledLeagueIds: [...], leagues: [...] }, ... }
  if (!payload || typeof payload !== 'object') {
    return sendError(res, 'Invalid payload', 400);
  }
  writeStore(payload);
  logger.info('League settings saved');
  return sendSuccess(res, { message: 'Saved successfully' });
}

module.exports = { getLeagues, saveLeagues };