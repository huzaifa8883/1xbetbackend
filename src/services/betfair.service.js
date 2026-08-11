'use strict';

const axios = require('axios');
const logger = require('../utils/logger');

const APP_KEY  = process.env.BETFAIR_APP_KEY;
const USERNAME = process.env.BETFAIR_USERNAME;
const PASSWORD = process.env.BETFAIR_PASSWORD;
const LOGIN_URL  = process.env.BETFAIR_LOGIN_URL  || 'https://identitysso.betfair.com/api/login';
const API_URL    = process.env.BETFAIR_API_URL     || 'https://api.betfair.com/exchange/betting/json-rpc/v1';
const TTL_MS     = parseInt(process.env.BETFAIR_SESSION_TTL_MINUTES || '25', 10) * 60 * 1000; // Reduced to 25 mins for safety

const { SPORT_MAP } = require('../config/constants');

/* ── Session cache & Lock ────────────────────────────────── */
let cachedToken = null;
let tokenExpiry = null;
let loginPromise = null; // Lock for concurrent requests

async function getSessionToken() {
  // 1. Return cached token if valid
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  // 2. Return active login request if already in progress (Deduplication)
  if (loginPromise) {
    return loginPromise;
  }

  // 3. Initiate single login request
  loginPromise = (async () => {
    try {
      logger.info('Betfair: Requesting new session token...');
      const res = await axios.post(
        LOGIN_URL,
        new URLSearchParams({ username: USERNAME, password: PASSWORD }),
        { 
          headers: { 
            'X-Application': APP_KEY, 
            'Content-Type': 'application/x-www-form-urlencoded' 
          },
          timeout: 10000 
        }
      );

      if (res.data.status !== 'SUCCESS') {
        const errorMsg = res.data.error || 'UNKNOWN_ERROR';
        // If banned, invalidate cache and throw
        cachedToken = null;
        tokenExpiry = null;
        throw new Error(`Betfair login failed: ${errorMsg}`);
      }

      cachedToken = res.data.token;
      tokenExpiry = Date.now() + TTL_MS;
      logger.info('Betfair: New session token successfully generated');
      return cachedToken;
    } catch (err) {
      cachedToken = null;
      tokenExpiry = null;
      throw err;
    } finally {
      loginPromise = null; // Release lock
    }
  })();

  return loginPromise;
}

/* ── Generic JSON-RPC call with Auto Session Retry ──────── */
async function jsonRpc(method, params, isRetry = false) {
  try {
    const token = await getSessionToken();
    const body  = [{ jsonrpc: '2.0', method, params, id: 1 }];
    const resp  = await axios.post(API_URL, body, {
      headers: { 
        'X-Application': APP_KEY, 
        'X-Authentication': token, 
        'Content-Type': 'application/json' 
      },
      timeout: 15000
    });

    const result = resp.data[0]?.result;
    const error  = resp.data[0]?.error;

    // Handle Session Expired error inside RPC
    if (error && (error.code === -32099 || error.data?.APINGException?.errorCode === 'INVALID_SESSION_INFORMATION')) {
      logger.warn('Betfair: Session invalidated on RPC call, clearing cached token');
      cachedToken = null;
      tokenExpiry = null;
      if (!isRetry) {
        return jsonRpc(method, params, true); // Retry once with fresh token
      }
    }

    if (!result) {
      throw new Error(`No result from Betfair: ${method} - error: ${JSON.stringify(error)}`);
    }

    return result;
  } catch (err) {
    // Clear token if token issue detected in network response
    if (err.message.includes('INVALID_SESSION') || err.message.includes('login failed')) {
      cachedToken = null;
      tokenExpiry = null;
    }
    throw err;
  }
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

async function listMarketProfitAndLoss(marketIds = []) {
  return jsonRpc('SportsAPING/v1.0/listMarketProfitAndLoss', {
    marketIds,
    includeSettledBets: true,
    includeBspBets: true,
    netOfCommission: false,
  });
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
  listMarketProfitAndLoss,
};
