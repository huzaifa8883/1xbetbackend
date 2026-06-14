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

    // RUNNER_METADATA fields — horse race aur greyhound ke liye
    const meta = runner.metadata || {};
    const clothNumber = runner.metadata?.CLOTH_NUMBER || runner.metadata?.cloth_number || null;
    const jockeyName  = runner.metadata?.JOCKEY_NAME  || runner.metadata?.jockey_name  || null;
    const trainerName = runner.metadata?.TRAINER_NAME || runner.metadata?.trainer_name || null;
    const silkUrl     = runner.metadata?.SILK_URL      || runner.metadata?.silk_url     || null;
    const stallDraw   = runner.metadata?.STALL_DRAW    || runner.metadata?.stall_draw   || null;

    return {
      selectionId:  runner.selectionId,
      runnerName:   runner.runnerName,
      sortPriority: runner.sortPriority,
      back:  rb?.ex?.availableToBack?.slice(0, 3) || [],
      lay:   rb?.ex?.availableToLay?.slice(0, 3)  || [],
      status: rb?.status || 'ACTIVE',
      lastPriceTraded: rb?.lastPriceTraded || null,
      // Metadata fields for horse/greyhound runner display
      clothNumber,
      jockeyName,
      trainerName,
      silkUrl,
      stallDraw,
      metadataDict: Object.keys(meta).length > 0 ? meta : null,
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

  const catalogues = await listMarketCatalogue(catalogueFilter, maxResults, ['EVENT', 'RUNNER_METADATA', 'COMPETITION', 'RUNNER_DESCRIPTION']);
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
      marketId:       market.marketId,
      match:          event?.event.name || market.marketName || 'Unknown',
      startTime:      event?.event.openDate || '',
      marketStatus:   book?.status || 'UNKNOWN',
      inPlay:         book?.inPlay || false,
      totalMatched:   book?.totalMatched || 0,
      runners:        buildOddsPayload(market.runners || [], book),
      competitionId:  market.competition?.id   || null,
      competitionName: market.competition?.name || null,
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
  const catalogues = await listMarketCatalogue({ eventIds, marketTypeCodes: marketTypes }, maxResults, ['EVENT', 'RUNNER_METADATA', 'COMPETITION']);
  const books = await listMarketBook(catalogues.map(m => m.marketId));

  const data = catalogues.map(market => {
    const book  = books.find(b => b.marketId === market.marketId);
    const event = events.find(e => e.event.id === market.event?.id);
    return {
      marketId:        market.marketId,
      match:           event?.event.name || 'Unknown',
      startTime:       event?.event.openDate || '',
      inPlay:          book?.inPlay || false,
      totalMatched:    book?.totalMatched || 0,
      runners:         buildOddsPayload(market.runners || [], book),
      competitionId:   market.competition?.id   || null,
      competitionName: market.competition?.name || null,
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

    // Deduplicate: same track (match name) + same start minute = duplicate event
    const seen = new Set();
    const deduped = data.filter(d => {
      const timeKey = d.startTime ? d.startTime.substring(0, 16) : ''; // YYYY-MM-DDTHH:MM
      const key = `${d.match}__${timeKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return sendSuccess(res, deduped);
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

  // Step 1: Main market ka catalog lo — eventId nikalna hai
  const [catalogues, mainBooks] = await Promise.all([
    listMarketCatalogue({ marketIds: [marketId] }, '1', ['EVENT', 'RUNNER_DESCRIPTION']),
    listMarketBook([marketId]),
  ]);

  const catalog = catalogues?.[0];
  const mainBook = mainBooks?.[0];
  if (!mainBook) return sendError(res, 'Market not found', 404);

  // Runner name map for main market
  const runnerMap = {};
  (catalog?.runners || []).forEach(r => { runnerMap[r.selectionId] = r.runnerName; });

  // Helper: book ko mv2.min.js ka expected shape mein convert karo
  function bookToMarketBook(book, rMap) {
    return {
      id:             book.marketId,
      betDelay:       book.betDelay       || 0,
      totalMatched:   book.totalMatched   || 0,
      marketStatus:   book.status         || 'OPEN',
      bettingAllowed: true,
      runners: (book.runners || []).map(r => ({
        id:     r.selectionId,
        name:   rMap[r.selectionId] || '',
        price1: r.ex?.availableToBack?.[0]?.price || 0,
        price2: r.ex?.availableToBack?.[1]?.price || 0,
        price3: r.ex?.availableToBack?.[2]?.price || 0,
        size1:  r.ex?.availableToBack?.[0]?.size  || 0,
        size2:  r.ex?.availableToBack?.[1]?.size  || 0,
        size3:  r.ex?.availableToBack?.[2]?.size  || 0,
        lay1:   r.ex?.availableToLay?.[0]?.price  || 0,
        lay2:   r.ex?.availableToLay?.[1]?.price  || 0,
        lay3:   r.ex?.availableToLay?.[2]?.price  || 0,
        ls1:    r.ex?.availableToLay?.[0]?.size   || 0,
        ls2:    r.ex?.availableToLay?.[1]?.size   || 0,
        ls3:    r.ex?.availableToLay?.[2]?.size   || 0,
        status: r.status || 'ACTIVE',
      })),
      timestamp: book.lastMatchTime || '0001-01-01T00:00:00',
      winnerIDs: [],
    };
  }

  // Step 2: Main market book — always included
  const marketBooks = [bookToMarketBook(mainBook, runnerMap)];

  // Step 3: Saare sub-markets bhi fetch karo (usi event ke)
  // mv2.min.js ProcessSubMarkets() ko marketBooks mein SAARE markets chahiye
  // warna woh subMarkets array se delete kar deta hai unhe
  const eventId = catalog?.event?.id;
  if (eventId) {
    try {
      // Is event ke baaki sub-markets dhundo
      const subCatalogues = await listMarketCatalogue(
        { eventIds: [String(eventId)] },
        '200',
        ['RUNNER_DESCRIPTION'],
      );

      const subMarketIds = subCatalogues
        .map(m => m.marketId)
        .filter(id => id !== marketId);  // main market exclude karo

      if (subMarketIds.length > 0) {
        // Chunk mein books fetch karo (Betfair max 200)
        const CHUNK = 200;
        let allSubBooks = [];
        for (let i = 0; i < subMarketIds.length; i += CHUNK) {
          const chunk = subMarketIds.slice(i, i + CHUNK);
          const sb = await listMarketBook(chunk).catch(() => []);
          allSubBooks = allSubBooks.concat(sb);
        }

        // Har sub-market ke liye runner map banao aur marketBooks mein push karo
        const subCatalogMap = {};
        subCatalogues.forEach(m => { subCatalogMap[m.marketId] = m; });

        allSubBooks.forEach(subBook => {
          const subCat = subCatalogMap[subBook.marketId];
          const subRunnerMap = {};
          (subCat?.runners || []).forEach(r => { subRunnerMap[r.selectionId] = r.runnerName; });
          marketBooks.push(bookToMarketBook(subBook, subRunnerMap));
        });

        logger.info(`getMarketData: returning ${marketBooks.length} books (1 main + ${allSubBooks.length} sub)`);
      }
    } catch (err) {
      // Sub-market fetch fail ho to sirf main market return karo — crash mat karo
      logger.warn(`getMarketData sub-markets fetch failed: ${err.message}`);
    }
  }

  return sendSuccess(res, { requestId: uuidv4(), marketBooks, news: '' });
}

async function getMarketCatalog2(req, res) {
  const { id: marketId } = req.query;
  if (!marketId) return sendError(res, 'marketId query parameter is required', 400);

  const [catalogues, books] = await Promise.all([
    listMarketCatalogue({ marketIds: [marketId] }, '1', [
      'EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'RUNNER_METADATA',
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

  const eventId = catalog.event?.id;

  // ── Fetch ALL sub-markets for this event so mv2.min.js gets
  //    BookmakerMarkets, TossMarkets, FancyMarkets etc. populated ──
  let subMarkets = [];
  if (eventId) {
    try {
      const allCatalogues = await listMarketCatalogue(
        { eventIds: [String(eventId)] },
        '200',
        ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION'],
      );

      const subMarketIds = allCatalogues
        .filter(m => m.marketId !== marketId)
        .map(m => m.marketId);

      let subBooks = [];
      if (subMarketIds.length > 0) {
        subBooks = await listMarketBook(subMarketIds).catch(() => []);
      }

      subMarkets = allCatalogues
        .filter(m => m.marketId !== marketId)
        .map(m => {
          const sb = subBooks.find(b => b.marketId === m.marketId);
          return {
            marketId:    m.marketId,
            marketName:  m.marketName,
            marketType:  m.description?.marketType || '',
            status:      sb?.status || 'OPEN',
            inPlay:      sb?.inPlay || false,
            runners: (m.runners || []).map(r => {
              const rb = sb?.runners?.find(x => x.selectionId === r.selectionId);
              return {
                selectionId: r.selectionId,
                runnerName:  r.runnerName,
                sortPriority: r.sortPriority,
                status:      rb?.status || 'ACTIVE',
                back: rb?.ex?.availableToBack?.slice(0, 3) || [],
                lay:  rb?.ex?.availableToLay?.slice(0, 3)  || [],
              };
            }),
          };
        });
    } catch (err) {
      logger.warn(`catalog2 subMarkets fetch failed: ${err.message}`);
    }
  }

  return sendSuccess(res, {
    marketId:            catalog.marketId,
    marketName:          catalog.marketName,
    marketStartTime:     catalog.marketStartTime,
    eventTypeId,
    eventType:           sportName,
    eventId,
    eventName:           catalog.event?.name,
    competitionId:       catalog.competition?.id,
    status:              book.status,
    isTurnInPlayEnabled: book.isTurnInPlay,
    betDelay:            book.betDelay,
    maxBetSize:          book.maxBetSize ?? book.totalMatched ?? 0,
    rules:               catalog.description?.rules || '',
    sport: { name: sportName, image: iconMap[sportName] || 'default.svg', active: true },
    runners: (catalog.runners || []).map(r => ({
      selectionId:  r.selectionId,
      runnerName:   r.runnerName,
      handicap:     r.handicap,
      sortPriority: r.sortPriority,
      status:       'ACTIVE',
      // Metadata for horse/greyhound runner display
      clothNumber:  r.metadata?.CLOTH_NUMBER || r.metadata?.cloth_number || null,
      jockeyName:   r.metadata?.JOCKEY_NAME  || r.metadata?.jockey_name  || null,
      trainerName:  r.metadata?.TRAINER_NAME || r.metadata?.trainer_name || null,
      silkUrl:      r.metadata?.SILK_URL     || r.metadata?.silk_url     || null,
      stallDraw:    r.metadata?.STALL_DRAW   || r.metadata?.stall_draw   || null,
      metadataDict: r.metadata && Object.keys(r.metadata).length > 0 ? r.metadata : null,
    })),
    // ✅ subMarkets — mv2.min.js isko read karta hai BookmakerMarkets,
    //    TossMarkets, FancyMarkets etc. populate karne ke liye
    subMarkets,
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

/* ── Admin: Betfair competitions & market types ─────────── */

async function getBetfairCompetitions(req, res) {
  const { eventTypeId } = req.query;
  if (!eventTypeId) return sendError(res, 'eventTypeId query parameter is required', 400);

  try {
    const competitions = await listCompetitions({ eventTypeIds: [String(eventTypeId)] });
    return sendSuccess(res, { competitions });
  } catch (err) {
    logger.error(`getBetfairCompetitions error: ${err.message}`);
    return sendError(res, 'Failed to fetch competitions from Betfair', 500);
  }
}

async function getBetfairMarketTypes(req, res) {
  const { eventTypeId } = req.query;
  if (!eventTypeId) return sendError(res, 'eventTypeId query parameter is required', 400);

  try {
    const now = new Date();
    const to  = new Date(now.getTime() + 30 * 24 * 3600_000).toISOString();

    const events = await listEvents({
      eventTypeIds: [String(eventTypeId)],
      marketStartTime: { from: now.toISOString(), to },
    });

    if (!events.length) return sendSuccess(res, { marketTypes: [] });

    const catalogues = await listMarketCatalogue(
      { eventIds: events.slice(0, 20).map(e => e.event.id) },
      '200',
      ['MARKET_DESCRIPTION']
    );

    const seen = new Set();
    const marketTypes = [];
    for (const m of catalogues) {
      const t = m.description?.marketType || m.marketName;
      if (t && !seen.has(t)) {
        seen.add(t);
        marketTypes.push({ marketType: t });
      }
    }

    return sendSuccess(res, { marketTypes });
  } catch (err) {
    logger.error(`getBetfairMarketTypes error: ${err.message}`);
    return sendError(res, 'Failed to fetch market types from Betfair', 500);
  }
}

/* ── NEW: All markets for a specific event ───────────────── */

/**
 * @route  GET /api/v1/markets/event-markets?eventId=<id>
 * @desc   Ek event (match) ke SAARE available Betfair markets fetch karo.
 *         Match Odds + Bookmaker + Toss + Fancy + etc. — sab ek saath.
 *         market.html frontend isko use karta hai baaki tabs show karne ke liye.
 */
async function getEventMarkets(req, res) {
  const { eventId } = req.query;
  if (!eventId) return sendError(res, 'eventId query parameter is required', 400);

  try {
    // ── Step 1: Is event ke SAARE markets lo (koi marketType filter nahi) ──
    const catalogues = await listMarketCatalogue(
      { eventIds: [String(eventId)] },
      '200',  // Betfair max 200
      ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'RUNNER_METADATA'],
    );

    if (!catalogues.length) {
      return sendSuccess(res, {
        matchOdds: [], bookmaker: [], toss: [],
        fancy: [], fancy2: [], figure: [], oddFigure: [], other: [], all: [],
      });
    }

    // ── Step 2: Saare market IDs ki books ek saath fetch karo ──
    const allMarketIds = catalogues.map(m => m.marketId);
    const CHUNK = 200;
    let allBooks = [];
    for (let i = 0; i < allMarketIds.length; i += CHUNK) {
      const books = await listMarketBook(allMarketIds.slice(i, i + CHUNK)).catch(() => []);
      allBooks = allBooks.concat(books);
    }

    // ── Step 3: Normalize — frontend jo shape expect karta hai ──
    const normalized = catalogues.map(market => {
      const book       = allBooks.find(b => b.marketId === market.marketId);
      const marketType = market.description?.marketType || '';
      const marketName = market.marketName || '';

      return {
        marketId:    market.marketId,
        marketName,
        marketType,
        status:      book?.status      || 'OPEN',
        status2:     null,
        inPlay:      book?.inPlay      || false,
        maxBetSize:  book?.maxBetSize  ?? book?.totalMatched ?? 0,
        bettingType: market.description?.bettingType || 'ODDS',
        eventTypeId: market.eventType?.id || null,
        runners:     buildOddsPayload(market.runners || [], book),
      };
    });

    // ── Step 4: Market type ke hisaab se categorize karo ──
    //
    //  Betfair standard marketType strings:
    //    MATCH_ODDS, BOOKMAKER, TOSS, INNINGS_RUNS, SESSION_RUNS,
    //    BOTH_TEAMS_TO_SCORE, CORRECT_SCORE, HALF_TIME, ASIAN_HANDICAP,
    //    SET_WINNER, TOTAL_GOALS, WINNER, WIN, PLACE, EACH_WAY, etc.

    const result = {
      matchOdds: [],
      bookmaker: [],
      toss:      [],
      fancy:     [],
      fancy2:    [],
      figure:    [],
      oddFigure: [],
      other:     [],
      all:       normalized,
    };

    for (const market of normalized) {
      const type = (market.marketType || '').toUpperCase();
      const name = (market.marketName || '').toLowerCase();

      if (type === 'MATCH_ODDS' || type === 'WINNER') {
        result.matchOdds.push(market);

      } else if (
        type === 'BOOKMAKER' || type === 'BOOKMAKER2' ||
        name.includes('bookmaker')
      ) {
        result.bookmaker.push(market);

      } else if (
        type === 'TOSS' || name.includes('toss')
      ) {
        result.toss.push(market);

      } else if (
        type === 'FANCY2' ||
        name.includes('fancy 2') || name.includes('fancy-2') || name.includes('fancy2')
      ) {
        result.fancy2.push(market);

      } else if (
        type === 'FANCY'         ||
        type === 'INNINGS_RUNS'  ||
        type === 'SESSION_RUNS'  ||
        type === 'OVER_UNDER_RUNS' ||
        type === 'TOP_BATSMAN'   ||
        type === 'TOP_BOWLER'    ||
        name.includes('fancy')   ||
        name.includes('session') ||
        name.includes('innings') ||
        name.includes('over')
      ) {
        result.fancy.push(market);

      } else if (
        type === 'FIGURE' || name.includes('figure')
      ) {
        result.figure.push(market);

      } else if (
        type === 'ODD_FIGURE' || type === 'EVEN_ODD' ||
        name.includes('even') || name.includes('odd figure')
      ) {
        result.oddFigure.push(market);

      } else {
        // BOTH_TEAMS_TO_SCORE, CORRECT_SCORE, HALF_TIME,
        // ASIAN_HANDICAP, SET_WINNER, TOTAL_GOALS, etc.
        result.other.push(market);
      }
    }

    return sendSuccess(res, result);

  } catch (err) {
    logger.error(`getEventMarkets error: ${err.message}`);
    return sendError(res, 'Failed to fetch event markets', 500);
  }
}

/* ── Exports ─────────────────────────────────────────────── */

module.exports = {
  getLiveCricket,
  getLiveCricketInplay,
  getLiveFootball,
  getLiveTennis,
  getLiveHorse,
  getLiveGreyhound,
  getLiveSport,
  getMarketData,
  getMarketCatalog2,
  getNavigation,
  getBetfairCompetitions,
  getBetfairMarketTypes,
  getEventMarkets,           // ← NEW
};
