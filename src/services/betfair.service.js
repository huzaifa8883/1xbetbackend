'use strict';

const axios = require('axios');
const logger = require('../utils/logger');
const { SPORT_MAP } = require('../config/constants');

const {
  BETFAIR_APP_KEY: APP_KEY,
  BETFAIR_USERNAME: USERNAME,
  BETFAIR_PASSWORD: PASSWORD,
  BETFAIR_LOGIN_URL,
  BETFAIR_API_URL,
  BETFAIR_SESSION_TTL_MINUTES,
} = process.env;

const SESSION_TTL_MS = (parseInt(BETFAIR_SESSION_TTL_MINUTES || '29', 10)) * 60 * 1000;

let _sessionToken = null;
let _tokenExpiry = 0;

/* ── Session / Auth ─────────────────────────────────────── */

async function getSessionToken() {
  if (_sessionToken && Date.now() < _tokenExpiry) return _sessionToken;

  const response = await axios.post(
    BETFAIR_LOGIN_URL || 'https://identitysso.betfair.com/api/login',
    new URLSearchParams({ username: USERNAME, password: PASSWORD }),
    {
      headers: {
        'X-Application': APP_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );

  if (response.data?.status !== 'SUCCESS') {
    throw new Error(`Betfair login failed: ${response.data?.error}`);
  }

  _sessionToken = response.data.token;
  _tokenExpiry = Date.now() + SESSION_TTL_MS;
  logger.info('Betfair session token refreshed');
  return _sessionToken;
}

/* ── Core JSON-RPC helper ───────────────────────────────── */

async function betfairRpc(method, params) {
  const token = await getSessionToken();
  const payload = [{ jsonrpc: '2.0', method, params, id: 1 }];

  const response = await axios.post(
    BETFAIR_API_URL || 'https://api.betfair.com/exchange/betting/json-rpc/v1',
    payload,
    {
      headers: {
        'X-Application': APP_KEY,
        'X-Authentication': token,
        'Content-Type': 'application/json',
      },
    },
  );

  const result = response.data?.[0]?.result;
  if (!result) throw new Error(`Betfair RPC empty result for method: ${method}`);
  return result;
}

/* ── Public helpers ─────────────────────────────────────── */

/**
 * Fetch live market book for given market IDs.
 */
async function listMarketBook(marketIds, priceData = ['EX_BEST_OFFERS']) {
  return betfairRpc('SportsAPING/v1.0/listMarketBook', {
    marketIds,
    priceProjection: { priceData, virtualise: true },
  });
}

/**
 * Fetch market catalogue for given market IDs.
 */
async function listMarketCatalogue(filter, maxResults = '20', marketProjection = ['EVENT', 'EVENT_TYPE', 'RUNNER_METADATA']) {
  return betfairRpc('SportsAPING/v1.0/listMarketCatalogue', {
    filter,
    maxResults,
    marketProjection,
  });
}

/**
 * Fetch events matching a filter.
 */
async function listEvents(filter) {
  return betfairRpc('SportsAPING/v1.0/listEvents', { filter });
}

/**
 * Fetch competitions matching a filter.
 */
async function listCompetitions(filter) {
  return betfairRpc('SportsAPING/v1.0/listCompetitions', { filter });
}

/**
 * Fetch event types (top-level sports).
 */
async function listEventTypes() {
  return betfairRpc('SportsAPING/v1.0/listEventTypes', { filter: {} });
}

/**
 * Get event name and sport category for a single marketId.
 */
async function getEventDetails(marketId) {
  try {
    const [market] = await listMarketCatalogue(
      { marketIds: [marketId] },
      '1',
      ['EVENT', 'EVENT_TYPE'],
    );

    if (!market?.event) return { eventName: 'Unknown Event', category: 'Other' };

    const eventName = market.event.name;
    const eventTypeId = String(market.eventType?.id ?? '');
    const category = SPORT_MAP[eventTypeId] || market.eventType?.name || 'Other';

    return { eventName, category };
  } catch (err) {
    logger.warn(`getEventDetails(${marketId}): ${err.message}`);
    return { eventName: 'Unknown Event', category: 'Other' };
  }
}

/**
 * Get runner data for a single selection in a market.
 */
async function getRunnerBook(marketId, selectionId) {
  try {
    const books = await listMarketBook([marketId]);
    const runner = books?.[0]?.runners?.find((r) => r.selectionId === selectionId);
    return runner || null;
  } catch (err) {
    logger.warn(`getRunnerBook(${marketId}, ${selectionId}): ${err.message}`);
    return null;
  }
}

/**
 * Fetch full market details (catalogue + book) for a list of market IDs.
 */
async function getMarketsWithDetails(marketIds) {
  if (!marketIds.length) return [];

  const [books, catalogues] = await Promise.all([
    listMarketBook(marketIds).catch(() => []),
    listMarketCatalogue({ marketIds }, String(marketIds.length), ['EVENT', 'EVENT_TYPE']).catch(() => []),
  ]);

  return books.map((book) => {
    const cat = catalogues.find((c) => c.marketId === book.marketId);
    const eventTypeId = String(cat?.eventType?.id ?? '');
    return {
      marketId: book.marketId,
      status: book.status,
      inPlay: book.inPlay || false,
      runners: book.runners || [],
      eventName: cat?.event?.name || 'Unknown',
      category: SPORT_MAP[eventTypeId] || cat?.eventType?.name || 'Other',
    };
  });
}

module.exports = {
  getSessionToken,
  listMarketBook,
  listMarketCatalogue,
  listEvents,
  listCompetitions,
  listEventTypes,
  getEventDetails,
  getRunnerBook,
  getMarketsWithDetails,
};
