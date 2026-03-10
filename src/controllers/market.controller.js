'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  listEvents,
  listMarketCatalogue,
  listMarketBook,
  listCompetitions,
  listEventTypes,
} = require('../services/betfair.service');
const { sendSuccess, sendError } = require('../utils/response');
const { SPORT_MAP } = require('../config/constants');
const { SportConfig } = require('../models');
const logger = require('../utils/logger');

/* ── Helpers ────────────────────────────────────────────── */

function buildOddsPayload(runners, books) {
  return runners.map((runner) => {
    const rb = books?.runners?.find((r) => r.selectionId === runner.selectionId);
    return {
      selectionId: runner.selectionId,
      runnerName: runner.runnerName,
      sortPriority: runner.sortPriority,
      back: rb?.ex?.availableToBack?.slice(0, 3) || [],
      lay: rb?.ex?.availableToLay?.slice(0, 3) || [],
      status: rb?.status || 'ACTIVE',
      lastPriceTraded: rb?.lastPriceTraded || null,
    };
  });
}

// Load sport config from DB, fallback to defaults
async function getSportCfg(sportKey) {
  const cfg = await SportConfig.findOne({ where: { sport_key: sportKey } });
  return cfg ? cfg.toJSON() : null;
}

// Core fetch function — driven by SportConfig
async function fetchSportMarkets(sportKey, eventTypeId, overrides = {}) {
  const cfg = await getSportCfg(sportKey);

  // If admin has disabled this sport, return empty
  if (cfg && cfg.is_active === false) return [];

  const maxResults    = String(cfg?.max_results   ?? overrides.maxResults  ?? 20);
  const marketTypes   = (cfg?.market_types ?? overrides.marketTypes ?? 'MATCH_ODDS').split(',').map(s => s.trim());
  const inPlayOnly    = cfg?.inplay_only  ?? overrides.inPlayOnly  ?? false;
  const hoursAhead    = cfg?.hours_ahead  ?? overrides.hoursAhead  ?? 24;

  const now = new Date();
  const from = new Date(now.getTime() - 2 * 3600_000).toISOString();
  const to   = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

  // Build event filter
  const eventFilter = {
    eventTypeIds: [String(eventTypeId)],
    marketStartTime: { from, to },
  };

  // Country filter — if admin set specific countries
  if (cfg?.allowed_countries) {
    eventFilter.marketCountries = cfg.allowed_countries.split(',').map(s => s.trim());
  }

  // Competition filter — if admin picked specific leagues
  if (cfg?.allowed_competition_ids) {
    eventFilter.competitionIds = cfg.allowed_competition_ids.split(',').map(s => s.trim());
  }

  if (inPlayOnly) eventFilter.inPlayOnly = true;

  let events = await listEvents(eventFilter);
  if (!events.length) return [];

  const catalogueFilter = {
    eventIds: events.map(e => e.event.id),
    marketTypeCodes: marketTypes,
  };

  const catalogues = await listMarketCatalogue(catalogueFilter, maxResults, ['EVENT', 'RUNNER_METADATA']);
  if (!catalogues.length) return [];

  // Chunk books (Betfair max 200 per request)
  const CHUNK = 200;
  const allMarketIds = catalogues.map(m => m.marketId);
  let allBooks = [];
  for (let i = 0; i < allMarketIds.length; i += CHUNK) {
    const chunk = allMarketIds.slice(i, i + CHUNK);
    const books = await listMarketBook(chunk).catch(() => []);
    allBooks = allBooks.concat(books);
  }

  return catalogues.map(market => {
    const book  = allBooks.find(b => b.marketId === market.marketId);
    const event = events.find(e => e.event.id === market.event?.id);
    return {
      marketId:      market.marketId,
      match:         event?.event.name || market.marketName || 'Unknown',
      startTime:     event?.event.openDate || '',
      marketStatus:  book?.status || 'UNKNOWN',
      inPlay:        book?.inPlay || false,
      totalMatched:  book?.totalMatched || 0,
      runners:       buildOddsPayload(market.runners || [], book),
    };
  }).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

/* ── Sport endpoints ─────────────────────────────────────── */

async function getLiveCricket(req, res) {
  const data = await fetchSportMarkets('cricket', 4);
  return sendSuccess(res, data);
}

async function getLiveCricketInplay(req, res) {
  const data = await fetchSportMarkets('cricket', 4, { inPlayOnly: true });
  return sendSuccess(res, data);
}

async function getLiveFootball(req, res) {
  const data = await fetchSportMarkets('football', 1);
  return sendSuccess(res, data);
}

async function getLiveTennis(req, res) {
  // Tennis: filter out set/game markets
  const cfg = await getSportCfg('tennis');
  if (cfg && cfg.is_active === false) return sendSuccess(res, []);

  const maxResults = String(cfg?.max_results ?? 20);
  const now = new Date();
  const hoursAhead = cfg?.hours_ahead ?? 24;
  const to = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

  const eventFilter = {
    eventTypeIds: ['2'],
    marketStartTime: { from: now.toISOString(), to },
  };
  if (cfg?.allowed_countries)      eventFilter.marketCountries = cfg.allowed_countries.split(',').map(s => s.trim());
  if (cfg?.allowed_competition_ids) eventFilter.competitionIds = cfg.allowed_competition_ids.split(',').map(s => s.trim());

  let events = await listEvents(eventFilter);
  events = events.filter(({ event }) => {
    const n = event.name.toLowerCase();
    return !n.includes('set') && !n.includes('game') && !n.includes('odds');
  });

  const eventIds = events.map(e => e.event.id);
  if (!eventIds.length) return sendSuccess(res, []);

  const marketTypes = (cfg?.market_types ?? 'MATCH_ODDS').split(',').map(s => s.trim());
  const catalogues = await listMarketCatalogue({ eventIds, marketTypeCodes: marketTypes }, maxResults, ['EVENT', 'RUNNER_METADATA']);
  const books = await listMarketBook(catalogues.map(m => m.marketId));

  const data = catalogues.map(market => {
    const book  = books.find(b => b.marketId === market.marketId);
    const event = events.find(e => e.event.id === market.event?.id);
    return {
      marketId:     market.marketId,
      match:        event?.event.name || 'Unknown',
      startTime:    event?.event.openDate || '',
      inPlay:       book?.inPlay || false,
      totalMatched: book?.totalMatched || 0,
      runners:      buildOddsPayload(market.runners || [], book),
    };
  });

  return sendSuccess(res, data);
}

async function getLiveHorse(req, res) {
  try {
    const data = await fetchSportMarkets('horse', 7, {
      marketTypes: 'WIN',
      maxResults: 200,
      hoursAhead: 24,
    });
    return sendSuccess(res, data);
  } catch (err) {
    logger.error(`getLiveHorse error: ${err.message}`);
    return sendError(res, 'Failed to fetch horse racing data', 500);
  }
}

async function getLiveGreyhound(req, res) {
  try {
    const data = await fetchSportMarkets('greyhound', 4339, {
      marketTypes: 'WIN',
      maxResults: 200,
      hoursAhead: 12,
    });

    // Deduplicate
    const seen = new Set();
    const deduped = data.filter(d => {
      if (seen.has(d.marketId)) return false;
      seen.add(d.marketId);
      return true;
    });

    return sendSuccess(res, deduped);
  } catch (err) {
    logger.error(`getLiveGreyhound error: ${err.message}`);
    return sendError(res, 'Failed to fetch greyhound data', 500);
  }
}

async function getLiveSport(req, res) {
  const singleMarketId = req.params.id;
  const { eventTypeIds } = req.query;
  const filter = { marketStartTime: { from: new Date().toISOString() } };
  if (eventTypeIds) filter.eventTypeIds = eventTypeIds.split(',');

  const events = await listEvents(filter);
  if (!events.length) return sendSuccess(res, []);

  const eventIds = events.map(e => e.event.id);
  let catalogues = await listMarketCatalogue(
    { eventIds, marketTypeCodes: ['MATCH_ODDS'] }, '100', ['EVENT', 'RUNNER_METADATA'],
  );

  if (singleMarketId) catalogues = catalogues.filter(m => m.marketId === singleMarketId);
  if (!catalogues.length) return sendSuccess(res, []);

  const books = await listMarketBook(catalogues.map(m => m.marketId));

  const data = catalogues.map(market => {
    const book  = books.find(b => b.marketId === market.marketId);
    const event = events.find(e => e.event.id === market.event?.id);
    return {
      marketId:     market.marketId,
      match:        event?.event.name || 'Unknown',
      startTime:    event?.event.openDate || '',
      inPlay:       book?.inPlay || false,
      totalMatched: book?.totalMatched || 0,
      runners:      buildOddsPayload(market.runners || [], book),
      marketBook:   book || null,
    };
  });

  return sendSuccess(res, data);
}

/* ── Market detail endpoints ────────────────────────────── */

async function getMarketData(req, res) {
  const { id: marketId } = req.query;
  if (!marketId) return sendError(res, 'marketId query parameter is required', 400);

  const [catalogues, books] = await Promise.all([
    listMarketCatalogue({ marketIds: [marketId] }, '1', ['RUNNER_DESCRIPTION']),
    listMarketBook([marketId]),
  ]);

  const catalog = catalogues?.[0];
  const book    = books?.[0];
  if (!book) return sendError(res, 'Market not found', 404);

  const runnerMap = {};
  (catalog?.runners || []).forEach(r => { runnerMap[r.selectionId] = r.runnerName; });

  const marketBooks = [{
    id: book.marketId,
    betDelay: book.betDelay,
    totalMatched: book.totalMatched,
    marketStatus: book.status,
    bettingAllowed: true,
    runners: book.runners.map(r => ({
      id:     r.selectionId,
      name:   runnerMap[r.selectionId] || '',
      price1: r.ex.availableToBack?.[0]?.price || 0,
      price2: r.ex.availableToBack?.[1]?.price || 0,
      price3: r.ex.availableToBack?.[2]?.price || 0,
      size1:  r.ex.availableToBack?.[0]?.size  || 0,
      size2:  r.ex.availableToBack?.[1]?.size  || 0,
      size3:  r.ex.availableToBack?.[2]?.size  || 0,
      lay1:   r.ex.availableToLay?.[0]?.price  || 0,
      lay2:   r.ex.availableToLay?.[1]?.price  || 0,
      lay3:   r.ex.availableToLay?.[2]?.price  || 0,
      ls1:    r.ex.availableToLay?.[0]?.size   || 0,
      ls2:    r.ex.availableToLay?.[1]?.size   || 0,
      ls3:    r.ex.availableToLay?.[2]?.size   || 0,
      status: r.status,
    })),
    timestamp: book.lastMatchTime || '0001-01-01T00:00:00',
    winnerIDs: [],
  }];

  return sendSuccess(res, { requestId: uuidv4(), marketBooks, news: '' });
}

async function getMarketCatalog2(req, res) {
  const { id: marketId } = req.query;
  if (!marketId) return sendError(res, 'marketId query parameter is required', 400);

  const [catalogues, books] = await Promise.all([
    listMarketCatalogue({ marketIds: [marketId] }, '1', [
      'EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION',
      'COMPETITION', 'MARKET_DESCRIPTION', 'EVENT_TYPE',
    ]),
    listMarketBook([marketId]),
  ]);

  const catalog = catalogues?.[0];
  const book    = books?.[0];
  if (!catalog || !book) return sendError(res, 'Market not found', 404);

  const eventTypeId = String(catalog.eventType?.id || '');
  const sportName   = SPORT_MAP[eventTypeId] || catalog.eventType?.name || 'Unknown';
  const iconMap     = {
    Cricket: 'cricket.svg', Tennis: 'tennis.svg',
    'Horse Racing': 'horse.svg', Soccer: 'soccer.svg',
    'Greyhound Racing': 'greyhound-racing.svg',
  };

  return sendSuccess(res, {
    marketId:            catalog.marketId,
    marketName:          catalog.marketName,
    marketStartTime:     catalog.marketStartTime,
    eventTypeId,
    eventType:           sportName,
    eventId:             catalog.event?.id,
    eventName:           catalog.event?.name,
    competitionId:       catalog.competition?.id,
    status:              book.status,
    isTurnInPlayEnabled: book.isTurnInPlay,
    betDelay:            book.betDelay,
    rules:               catalog.description?.rules || '',
    sport: { name: sportName, image: iconMap[sportName] || 'default.svg', active: true },
    runners: (catalog.runners || []).map(r => ({
      selectionId:  r.selectionId,
      runnerName:   r.runnerName,
      handicap:     r.handicap,
      sortPriority: r.sortPriority,
      status:       'ACTIVE',
    })),
    updatedAt: new Date().toISOString(),
  });
}

async function getNavigation(req, res) {
  const id   = req.query.id   || '0';
  const type = parseInt(req.query.type || '0', 10);
  let raw;

  if (type === 0 && id === '0') {
    raw = (await listEventTypes()).map(i => ({ id: i.eventType.id.toString(), name: i.eventType.name, type: 1 }));
  } else if (type === 0 && id !== '0') {
    raw = (await listCompetitions({ eventTypeIds: [id] })).map(i => ({ id: i.competition.id.toString(), name: i.competition.name, type: 2 }));
  } else if (type === 1) {
    raw = (await listEvents({ competitionIds: [id] })).map(i => ({ id: i.event.id.toString(), name: i.event.name, type: 3, startTime: i.event.openDate }));
  } else if (type === 2) {
    raw = (await listMarketCatalogue({ eventIds: [id] }, '100', ['EVENT', 'MARKET_START_TIME'])).map(i => ({
      id: i.marketId, name: i.marketName, type: 4, startTime: i.marketStartTime, eventId: i.event?.id,
    }));
  } else {
    return sendError(res, 'Invalid type or id', 400);
  }

  return sendSuccess(res, { requestId: uuidv4(), data: raw });
}

module.exports = {
  getLiveCricket, getLiveCricketInplay, getLiveFootball,
  getLiveTennis, getLiveHorse, getLiveGreyhound,
  getLiveSport, getMarketData, getMarketCatalog2, getNavigation,
};
