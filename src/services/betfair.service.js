'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const APP_KEY  = process.env.BETFAIR_APP_KEY;
const USERNAME = process.env.BETFAIR_USERNAME;
const PASSWORD = process.env.BETFAIR_PASSWORD;
const LOGIN_URL  = process.env.BETFAIR_LOGIN_URL  || 'https://identitysso.betfair.com/api/login';
const API_URL    = process.env.BETFAIR_API_URL     || 'https://api.betfair.com/exchange/betting/json-rpc/v1';
const TTL_MS     = parseInt(process.env.BETFAIR_SESSION_TTL_MINUTES || '29', 10) * 60 * 1000;

const { SPORT_MAP } = require('../config/constants');

/* ── Session cache ──────────────────────────────────────── */
let cachedToken = null;
let tokenExpiry = null;

async function getSessionToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) return cachedToken;

  const res = await axios.post(
    LOGIN_URL,
    new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    { headers: { 'X-Application': APP_KEY, 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  if (res.data.status !== 'SUCCESS') throw new Error(`Betfair login failed: ${res.data.error}`);

  cachedToken  = res.data.token;
  tokenExpiry  = Date.now() + TTL_MS;
  logger.info('Betfair: new session token generated');
  return cachedToken;
}

/* ── Generic JSON-RPC call ──────────────────────────────── */
async function jsonRpc(method, params) {
  const token = await getSessionToken();
  const body  = [{ jsonrpc: '2.0', method, params, id: 1 }];
  const resp  = await axios.post(API_URL, body, {
    headers: { 'X-Application': APP_KEY, 'X-Authentication': token, 'Content-Type': 'application/json' }
  });
  const result = resp.data[0]?.result;
  if (!result) throw new Error(`No result from Betfair: ${method}`);
  return result;
}

/* ── Public helpers ──────────────────────────────────────── */

async function listEventTypes(filter = {}) {
  return jsonRpc('SportsAPING/v1.0/listEventTypes', { filter });
}

async function listCompetitions(filter = {}) {
  return jsonRpc('SportsAPING/v1.0/listCompetitions', { filter });
}

async function listEvents(filter = {}) {
  return jsonRpc('SportsAPING/v1.0/listEvents', { filter });
}

async function listMarketCatalogue(filter = {}, maxResults = '20', marketProjection = ['EVENT', 'RUNNER_METADATA']) {
  return jsonRpc('SportsAPING/v1.0/listMarketCatalogue', { filter, maxResults: String(maxResults), marketProjection });
}

async function listMarketBook(marketIds = [], priceProjection = { priceData: ['EX_BEST_OFFERS'], virtualise: true }) {
  return jsonRpc('SportsAPING/v1.0/listMarketBook', { marketIds, priceProjection });
}

/* ── getEventDetails (orders.js compatible) ─────────────── */
async function getEventDetails(marketId) {
  try {
    const results = await listMarketCatalogue(
      { marketIds: [marketId] }, '1', ['EVENT', 'EVENT_TYPE']
    );
    const market = results?.[0];
    if (!market?.event) return { eventName: 'Unknown Event', category: 'Other' };
    const eventTypeId = String(market.eventType?.id || '');
    const category    = SPORT_MAP[eventTypeId] || market.eventType?.name || 'Other';
    return { eventName: market.event.name, category };
  } catch (err) {
    logger.warn(`getEventDetails failed for ${marketId}: ${err.message}`);
    return { eventName: 'Unknown Event', category: 'Other' };
  }
}

/* ── getRunnerBook (orders.js compatible) ───────────────── */
async function getRunnerBook(marketId, selectionId) {
  try {
    const books = await listMarketBook([marketId]);
    if (!books?.length) return null;
    const runner = books[0].runners?.find(r => r.selectionId === Number(selectionId));
    return runner || null;
  } catch (err) {
    logger.warn(`getRunnerBook failed for ${marketId}/${selectionId}: ${err.message}`);
    return null;
  }
}

module.exports = {
  getSessionToken,
  getEventDetails,
  getRunnerBook,
  listEventTypes,
  listCompetitions,
  listEvents,
  listMarketCatalogue,
  listMarketBook,
};
