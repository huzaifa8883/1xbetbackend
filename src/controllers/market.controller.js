
'use strict';

const { v4: uuidv4 } = require('uuid');
const {
  listEvents,
  listMarketCatalogue,
  listMarketBook,
  listCompetitions,
  listEventTypes,
  getBpexchMarketPage,
  getBpexchEventMarkets,
  normalizeMarketId,
} = require('../services/betfair.service');
const { sendSuccess, sendError } = require('../utils/response');
const { SPORT_MAP } = require('../config/constants');
const { SportConfig } = require('../models');
const logger = require('../utils/logger');

/* ── Helpers ────────────────────────────────────────────── */

function buildOddsPayload(runners, books, sportKey = 'horse') {
  return runners.map((runner) => {
    const rb = books?.runners?.find((r) => r.selectionId === runner.selectionId);

    // RUNNER_METADATA fields — horse race aur greyhound ke liye
    // Betfair kuch responses mein metadata, kuch mein runnerMetadata key use karta hai
    const meta = runner.metadata || runner.runnerMetadata || {};

    const clothNumber = meta.CLOTH_NUMBER || meta.cloth_number || meta.ClothNumber || null;
    const sortPriority = runner.sortPriority || null;
    const posNum = parseInt(clothNumber) || parseInt(sortPriority) || 1;

    // Standard racing cloth colors (horse race position-based fallback)
    const RACE_COLORS = [
      '#E63946','#FFFFFF','#1D3557','#F4D03F','#2ECC71','#111111','#F39C12','#8E44AD',
      '#16A085','#E74C3C','#3498DB','#F1C40F','#E67E22','#1ABC9C','#95A5A6','#2C3E50',
      '#C0392B','#7F8C8D','#27AE60','#D35400',
    ];

    // Standard greyhound trap colors — fixed worldwide (Australia/AU 8-trap format):
    // 1 Red, 2 Blue, 3 White, 4 Black, 5 Orange, 6 Black & White stripes, 7 Green, 8 Pink
    // (greyhounds don't get individual silk images — colors are trap-fixed, not horse-specific)
    const GREYHOUND_COLORS = [
      '#E63946', // 1 Red
      '#1D3557', // 2 Blue
      '#FFFFFF', // 3 White
      '#111111', // 4 Black
      '#F39C12', // 5 Orange
      '#111111', // 6 Black & White stripes (pattern flag below overrides display)
      '#2ECC71', // 7 Green
      '#FF8FB1', // 8 Pink
    ];
    const GREYHOUND_STRIPED_TRAPS = [6]; // trap number(s) that render as black/white stripes, not solid

    const isGreyhound = sportKey === 'greyhound';
    const clothColor = isGreyhound
      ? GREYHOUND_COLORS[(posNum - 1) % GREYHOUND_COLORS.length]
      : RACE_COLORS[(posNum - 1) % RACE_COLORS.length];
    const isStriped = isGreyhound && GREYHOUND_STRIPED_TRAPS.includes(posNum);

    // Silk image URL — Betfair RUNNER_METADATA mein asal field COLOURS_FILENAME_URL hai
    // (SILK_URL naam ki field exist nahi karti — wo purana/galat assumption tha)
    // Format: https://content.betfair.com/feeds_images/Horses/SilkColours/...
    // Greyhound races mein ye field generally nahi aati (trap color hi badge hai), is
    // liye horse race ke liye hi silkUrl bharo — greyhound ke liye hamesha trap color use hoga.
    const silkUrl = isGreyhound
      ? null
      : (meta.COLOURS_FILENAME_URL || meta.colours_filename_url || meta.ColoursFilenameUrl || null);

    const jockeyName  = meta.JOCKEY_NAME  || meta.jockey_name  || meta.JockeyName  || null;
    const trainerName = meta.TRAINER_NAME || meta.trainer_name || meta.TrainerName || null;
    const stallDraw   = meta.STALL_DRAW   || meta.stall_draw   || meta.StallDraw   || null;
    const age         = meta.AGE          || meta.age          || null;
    const form        = meta.FORM         || meta.form         || null;
    const officialRating = meta.OFFICIAL_RATING || meta.official_rating || null;

    return {
      selectionId:  runner.selectionId,
      runnerName:   runner.runnerName,
      sortPriority,
      back:  rb?.ex?.availableToBack?.slice(0, 3) || [],
      lay:   rb?.ex?.availableToLay?.slice(0, 3)  || [],
      status: rb?.status || 'ACTIVE',
      lastPriceTraded: rb?.lastPriceTraded || null,
      // Cloth
      clothNumber,
      clothColor,   // always set — fallback color agar silk image na ho
      clothStriped: isStriped,  // true => UI ko black/white diagonal stripe pattern banana hai
      // Silk image — BPExch ki tarah Betfair URL se image show hogi (horse race only)
      silkUrl,
      // Jockey / trainer
      jockeyName,
      trainerName,
      stallDraw,
      age,
      form,
      officialRating,
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
  // ✅ BUG FIX: pehle sab sports ke liye hoursAhead default 24 tha. Cricket
  // matches (Tests/tournaments) aksar 24 ghante se zyada aage schedule hote
  // hain — is default se wo upcoming window ke bahar chale jaate the aur
  // listEvents() 0 return karta tha (poori tarah gayab ho jaate the, chahe
  // data source mein match maujood ho). Ab sport ke hisaab se generous
  // default hai — bpexch ka apna highlights feed already curated hai
  // (sirf relevant matches deta hai), is liye wide window se koi clutter
  // nahi aayega, bas cutoff nahi hoga.
  const HOURS_AHEAD_DEFAULTS = { horse: 24, greyhound: 24, football: 72, cricket: 240, tennis: 120 };
  const hoursAhead = cfg?.hours_ahead ?? overrides.hoursAhead ?? HOURS_AHEAD_DEFAULTS[sportKey] ?? 24;

  const now = new Date();

  // ✅ BUG FIX: pehle SAARE sports ke liye "sirf pichle 30 minute mein
  // shuru hui matches" wala hardcoded filter tha. Horse/Greyhound races
  // ke liye theek hai (2 minute mein khatam ho jaate hain), lekin
  // Football (90+ min), Cricket (ghanton/dinon), Tennis (5-set matches
  // ghanton chal sakte hain) — in sab ke liye match 30 minute ke baad
  // bhi abhi LIVE/in-play hota hai, lekin marketStartTime filter ki
  // wajah se Betfair listEvents() ki response se hi bahar reh jaata tha
  // — is liye match dashboard se "gayab" ho jaata tha jabke wo abhi
  // band (closed) bhi nahi hua hota tha. Ab sport ke hisab se alag
  // lookback window use ho raha hai.
  const LOOKBACK_MINUTES = {
    horse:     30,   // races ~2 min mein khatam — tight window sahi hai
    greyhound: 30,
    football: 180,   // 90 min game + extra-time + stoppage ka buffer
    cricket:  720,   // T20/ODI cover karne ke liye generous buffer
    tennis:   360,   // lambe 5-set matches cover karne ke liye
  };
  const lookbackMin = LOOKBACK_MINUTES[sportKey] ?? 30;
  const from = new Date(now.getTime() - lookbackMin * 60_000).toISOString();
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
  logger.info(`[markets:${sportKey}] window ${from} -> ${to} | events=${events.length}`);
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
      inPlay:         (() => {
        if (book?.inPlay === true) return true;
        if (book?.status === 'IN_PLAY') return true;
        // startTime past mein hai aur market OPEN hai = live match
        const st = event?.event?.openDate;
        if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
        return false;
      })(),
      totalMatched:   book?.totalMatched || 0,
      runners:        buildOddsPayload(market.runners || [], book, sportKey),
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
  // ✅ BUG FIX: pehle 'from' seedha `now` tha, jo koi bhi already-started
  // (InPlay) match ko filter se bahar kar deta tha — kyunki uska start
  // time hamesha "now" se pehle hota hai. Ab fetchSportMarkets() jaisa hi
  // lookback window (360 min) use ho raha hai, taake in-play matches bhi
  // shamil rahein. hoursAhead default bhi 24 se 120 kar diya — tennis
  // tournaments 24 ghante se aage bhi schedule ho sakte hain.
  const hoursAhead = cfg?.hours_ahead ?? 120;
  const from = new Date(now.getTime() - 360 * 60_000).toISOString();
  const to   = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

  const eventFilter = {
    eventTypeIds: ['2'],
    marketStartTime: { from, to },
  };
  if (cfg?.allowed_countries)      eventFilter.marketCountries = cfg.allowed_countries.split(',').map(s => s.trim());
  if (cfg?.allowed_competition_ids) eventFilter.competitionIds = cfg.allowed_competition_ids.split(',').map(s => s.trim());

  let events = await listEvents(eventFilter);
  logger.info(`[markets:tennis] window ${from} -> ${to} | events=${events.length}`);
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
        inPlay:         (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          const st = event?.event?.openDate || market?.marketStartTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
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
    const cfg = await getSportCfg('horse');
    if (cfg && cfg.is_active === false) return sendSuccess(res, []);

    const maxResults = String(cfg?.max_results ?? 200);
    const hoursAhead = cfg?.hours_ahead ?? 24;

    const now  = new Date();
    // ✅ from: 5 min peeche (inplay races cover karne ke liye)
    const from = new Date(now.getTime() - 5 * 60_000).toISOString();
    const to   = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

    const eventFilter = {
      eventTypeIds: ['7'],
      marketStartTime: { from, to },
    };
    if (cfg?.allowed_countries) eventFilter.marketCountries = cfg.allowed_countries.split(',').map(s => s.trim());
    // ⚠️ allowed_competition_ids field mein TRACK NAAM hote hain (jaise
    // "Ballarat"), Betfair competition ID nahi — races ki koi "competition"
    // hoti hi nahi. Isliye ye seedha Betfair filter mein NAHI jaata; niche
    // events fetch hone ke baad naam se match karke filter hota hai.

    let events = await listEvents(eventFilter);
    if (!events.length) return sendSuccess(res, []);

    // ✅ FIX: track-naam se filter karo (getBetfairTracks jaisi hi derivation)
    if (cfg?.allowed_competition_ids) {
      const allowedTracks = new Set(
        cfg.allowed_competition_ids.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      );
      if (allowedTracks.size > 0) {
        events = events.filter(e => {
          const rawName   = e.event?.name || '';
          const trackName = (rawName.split('(')[0] || rawName).trim().toLowerCase();
          return allowedTracks.has(trackName);
        });
      }
    }
    if (!events.length) return sendSuccess(res, []);

    const catalogues = await listMarketCatalogue(
      { eventIds: events.map(e => e.event.id), marketTypeCodes: ['WIN'] },
      maxResults,
      ['EVENT', 'RUNNER_METADATA', 'COMPETITION', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME']
    );
    if (!catalogues.length) return sendSuccess(res, []);

    // Books fetch in chunks
    const CHUNK = 200;
    const allMarketIds = catalogues.map(m => m.marketId);
    let allBooks = [];
    for (let i = 0; i < allMarketIds.length; i += CHUNK) {
      const books = await listMarketBook(allMarketIds.slice(i, i + CHUNK)).catch(() => []);
      allBooks = allBooks.concat(books);
    }

    // ✅ Map — marketStartTime use karo (race-specific, more accurate than event.openDate)
    const mapped = catalogues.map(market => {
      const book  = allBooks.find(b => b.marketId === market.marketId);
      const event = events.find(e => e.event.id === market.event?.id);
      const startTime = market.marketStartTime || event?.event.openDate || '';

      return {
        marketId:        market.marketId,
        match:           event?.event.name || market.marketName || 'Unknown',
        startTime,
        marketStatus:    book?.status || 'UNKNOWN',
          inPlay:         (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          const st = event?.event?.openDate || market?.marketStartTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
        totalMatched:    book?.totalMatched || 0,
        runners:         buildOddsPayload(market.runners || [], book, 'horse'),
        competitionId:   market.competition?.id   || null,
        competitionName: market.competition?.name || null,
      };
    });

    // ✅ Filter: sirf future + recently started (5 min grace period)
    const cutoff = new Date(now.getTime() - 5 * 60_000);
    const filtered = mapped.filter(d => d.startTime && new Date(d.startTime) >= cutoff);

    // ✅ Deduplicate: same track + same minute
    const seen = new Set();
    const deduped = filtered.filter(d => {
      const timeKey = d.startTime ? d.startTime.substring(0, 16) : '';
      const key = `${d.match}__${timeKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ✅ Sort ascending — nearest race pehle
    deduped.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    return sendSuccess(res, deduped);
  } catch (err) {
    logger.error(`getLiveHorse error: ${err.message}`);
    return sendError(res, 'Failed to fetch horse racing data', 500);
  }
}

async function getLiveGreyhound(req, res) {
  try {
    const cfg = await getSportCfg('greyhound');
    if (cfg && cfg.is_active === false) return sendSuccess(res, []);

    const maxResults = String(cfg?.max_results ?? 200);
    const hoursAhead = cfg?.hours_ahead ?? 12;

    const now  = new Date();
    // ✅ from: 5 min peeche (inplay races cover karne ke liye)
    const from = new Date(now.getTime() - 5 * 60_000).toISOString();
    const to   = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

    const eventFilter = {
      eventTypeIds: ['4339'],
      marketStartTime: { from, to },
    };
    if (cfg?.allowed_countries) eventFilter.marketCountries = cfg.allowed_countries.split(',').map(s => s.trim());
    // ⚠️ allowed_competition_ids field mein TRACK NAAM hote hain, Betfair
    // competition ID nahi — races ki koi "competition" hoti hi nahi.
    // Isliye ye seedha Betfair filter mein NAHI jaata; niche events fetch
    // hone ke baad naam se match karke filter hota hai.

    let events = await listEvents(eventFilter);
    if (!events.length) return sendSuccess(res, []);

    // ✅ FIX: track-naam se filter karo (getBetfairTracks jaisi hi derivation)
    if (cfg?.allowed_competition_ids) {
      const allowedTracks = new Set(
        cfg.allowed_competition_ids.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      );
      if (allowedTracks.size > 0) {
        events = events.filter(e => {
          const rawName   = e.event?.name || '';
          const trackName = (rawName.split('(')[0] || rawName).trim().toLowerCase();
          return allowedTracks.has(trackName);
        });
      }
    }
    if (!events.length) return sendSuccess(res, []);

    const catalogues = await listMarketCatalogue(
      { eventIds: events.map(e => e.event.id), marketTypeCodes: ['WIN'] },
      maxResults,
      ['EVENT', 'RUNNER_METADATA', 'COMPETITION', 'RUNNER_DESCRIPTION', 'MARKET_START_TIME']
    );
    if (!catalogues.length) return sendSuccess(res, []);

    // Books fetch in chunks
    const CHUNK = 200;
    const allMarketIds = catalogues.map(m => m.marketId);
    let allBooks = [];
    for (let i = 0; i < allMarketIds.length; i += CHUNK) {
      const books = await listMarketBook(allMarketIds.slice(i, i + CHUNK)).catch(() => []);
      allBooks = allBooks.concat(books);
    }

    // ✅ Map — marketStartTime use karo (race-specific time)
    const mapped = catalogues.map(market => {
      const book  = allBooks.find(b => b.marketId === market.marketId);
      const event = events.find(e => e.event.id === market.event?.id);
      const startTime = market.marketStartTime || event?.event.openDate || '';

      return {
        marketId:        market.marketId,
        match:           event?.event.name || market.marketName || 'Unknown',
        startTime,
        marketStatus:    book?.status || 'UNKNOWN',
          inPlay:         (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          const st = event?.event?.openDate || market?.marketStartTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
        totalMatched:    book?.totalMatched || 0,
        runners:         buildOddsPayload(market.runners || [], book, 'greyhound'),
        competitionId:   market.competition?.id   || null,
        competitionName: market.competition?.name || null,
      };
    });

    // ✅ Filter: sirf future + recently started (5 min grace period)
    const cutoff = new Date(now.getTime() - 5 * 60_000);
    const filtered = mapped.filter(d => d.startTime && new Date(d.startTime) >= cutoff);

    // ✅ Deduplicate by marketId
    const seen = new Set();
    const deduped = filtered.filter(d => {
      if (seen.has(d.marketId)) return false;
      seen.add(d.marketId);
      return true;
    });

    // ✅ Sort ascending — nearest race pehle
    deduped.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

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
    // Greyhound ka Betfair eventTypeId 4339 hai — isi se trap-color scheme decide hoti hai
    const detectedSportKey = (market.eventType?.id || eventTypeIds) === '4339' ? 'greyhound' : 'horse';
    return {
      marketId:     market.marketId,
      match:        event?.event.name || 'Unknown',
      startTime:    event?.event.openDate || '',
        inPlay:         (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          const st = event?.event?.openDate || market?.marketStartTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
      totalMatched: book?.totalMatched || 0,
      runners:      buildOddsPayload(market.runners || [], book, detectedSportKey),
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
  const { id: rawId } = req.query;
  if (!rawId) return sendError(res, 'marketId query parameter is required', 400);
  const marketId = normalizeMarketId(rawId); // m_1_261306873 → 1.261306873
  if (String(rawId) !== String(marketId)) {
    logger.info(`[catalog2] normalized ${rawId} → ${marketId}`);
  }

  // ✅ Prefer bpexch catalog2 + catalogs + (optional) prices7 scoreboard
  // Real Betfair-style IDs (1.xxx / 9.xxx) ke liye ye path Bookmaker/Fancy/
  // Figure + scorecard/commentary laata hai — bilkul bpexch market page jaisa.
  try {
    const pricesToken = req.headers['x-prices-token'] || req.query.pricesToken || null;
    const bpx = await getBpexchMarketPage(marketId, pricesToken);
    if (bpx && bpx.marketId) {
      const eventTypeId = String(bpx.eventTypeId || bpx.sport?.id || '');
      const sportName = bpx.eventType || bpx.sport?.name || SPORT_MAP[eventTypeId] || 'Unknown';
      const iconMap = {
        Cricket: 'cricket.svg', Tennis: 'tennis.svg',
        'Horse Racing': 'horse.svg', Soccer: 'soccer.svg',
        'Greyhound Racing': 'greyhound-racing.svg',
      };
      logger.info(`[catalog2] bpexch hit marketId=${marketId} subs=${(bpx.subMarkets||[]).length} scoreboard=${!!bpx.scoreboard}`);

      // If catalog2 runners have no prices, fill from highlights listMarketBook
      let runnersOut = (bpx.runners || []).map(r => ({
          selectionId:  r.selectionId,
          runnerName:   r.runnerName,
          handicap:     r.handicap || 0,
          sortPriority: r.sortPriority || 0,
          status:       r.status || 'ACTIVE',
          back:         r.back || [],
          lay:          r.lay || [],
          clothNumber:  r.clothNumber || null,
          clothColor:   r.silkColor || null,
          silkUrl:      null,
          jockeyName:   r.jockeyName || null,
          trainerName:  r.trainerName || null,
          metadataDict: r.metadata || null,
        }));
      const needOdds = runnersOut.every(r => !(r.back && r.back.length) && !(r.lay && r.lay.length));
      if (needOdds) {
        try {
          const books = await listMarketBook([marketId]);
          const book = books?.[0];
          if (book?.runners?.length) {
            runnersOut = runnersOut.map(r => {
              const rb = book.runners.find(x => Number(x.selectionId) === Number(r.selectionId))
                || book.runners.find((x, i) => i === runnersOut.indexOf(r));
              if (!rb?.ex) return r;
              return {
                ...r,
                back: (rb.ex.availableToBack || []).slice(0, 3),
                lay:  (rb.ex.availableToLay  || []).slice(0, 3),
                status: rb.status || r.status,
              };
            });
            // name-based fallback if selectionIds differ (synthetic vs real)
            if (runnersOut.every(r => !(r.back && r.back.length))) {
              runnersOut = runnersOut.map((r, i) => {
                const rb = book.runners[i];
                if (!rb?.ex) return r;
                return {
                  ...r,
                  back: (rb.ex.availableToBack || []).slice(0, 3),
                  lay:  (rb.ex.availableToLay  || []).slice(0, 3),
                };
              });
            }
            logger.info(`[catalog2] filled odds from listMarketBook for ${marketId}`);
          }
        } catch (e) {
          logger.warn(`[catalog2] listMarketBook odds fill failed: ${e.message}`);
        }
      }

      return sendSuccess(res, {
        marketId:            bpx.marketId,
        marketName:          bpx.marketName || 'Match Odds',
        marketStartTime:     bpx.marketStartTime || bpx.marketStartTimeUtc || null,
        marketStartTimeUtc:  bpx.marketStartTimeUtc || bpx.marketStartTime || null,
        eventTypeId,
        eventType:           sportName,
        eventId:             bpx.eventId,
        eventName:           bpx.eventName,
        competitionId:       bpx.competitionId || null,
        status:              bpx.status || 'OPEN',
        isTurnInPlayEnabled: bpx.isTurnInPlayEnabled ?? true,
        betDelay:            bpx.betDelay ?? 0,
        maxBetSize:          bpx.maxBetSize ?? 0,
        rules:               bpx.rules || '',
        sport: { name: sportName, image: iconMap[sportName] || 'default.svg', active: true },
        winners:             bpx.winners ?? 1,
        runners: runnersOut,
        subMarkets: bpx.subMarkets || [],
        // scoreboard — Vue score prop se directly bind hota hai market.html mein
        // fields: team1, t1_runs, t1_wickets, t1_overs, t1_crr,
        //         team2, t2_runs, t2_wickets, t2_overs, t2_crr,
        //         rrr, target, commentry, recent_string, lastOverLabel, toWin
        scoreboard: bpx.scoreboard ? {
          ...bpx.scoreboard,
          // bpexch returns "commentry" (typo) — keep both for compatibility
          commentry:     bpx.scoreboard.commentry    || bpx.scoreboard.commentary || '',
          commentary:    bpx.scoreboard.commentary   || bpx.scoreboard.commentry  || '',
          recent_string: bpx.scoreboard.recent_string || bpx.scoreboard.recentString || '',
          lastOverLabel: bpx.scoreboard.lastOverLabel || bpx.scoreboard.last_over_label || 'Last Over',
          team1:    bpx.scoreboard.team1  || '',
          team2:    bpx.scoreboard.team2  || '',
          t1_runs:  bpx.scoreboard.t1_runs    ?? bpx.scoreboard.team1Runs    ?? 0,
          t1_wickets: bpx.scoreboard.t1_wickets ?? bpx.scoreboard.team1Wickets ?? 0,
          t1_overs:   bpx.scoreboard.t1_overs   ?? bpx.scoreboard.team1Overs   ?? 0,
          t1_crr:     bpx.scoreboard.t1_crr     ?? bpx.scoreboard.team1Crr     ?? 0,
          t2_runs:    bpx.scoreboard.t2_runs    ?? bpx.scoreboard.team2Runs    ?? 0,
          t2_wickets: bpx.scoreboard.t2_wickets ?? bpx.scoreboard.team2Wickets ?? 0,
          t2_overs:   bpx.scoreboard.t2_overs   ?? bpx.scoreboard.team2Overs   ?? 0,
          t2_crr:     bpx.scoreboard.t2_crr     ?? bpx.scoreboard.team2Crr     ?? 0,
          rrr:    bpx.scoreboard.rrr    ?? 0,
          target: bpx.scoreboard.target ?? 0,
          toWin:  bpx.scoreboard.toWin  ?? bpx.scoreboard.to_win ?? 0,
        } : null,
        scores:     bpx.scores || null,
        news:       bpx.news || '',
        updatedAt:  new Date().toISOString(),
      });
    }
  } catch (err) {
    logger.warn(`[catalog2] bpexch path failed for ${marketId}: ${err.message} — falling back`);
  }

  // ── Fallback: highlights-based listMarketCatalogue (synthetic IDs) ──
  const [catalogues, books] = await Promise.all([
    listMarketCatalogue({ marketIds: [marketId] }, '1', [
      'EVENT', 'MARKET_START_TIME', 'RUNNER_DESCRIPTION', 'RUNNER_METADATA',
      'COMPETITION', 'MARKET_DESCRIPTION', 'EVENT_TYPE',
    ]),
    listMarketBook([marketId]),
  ]);

  const catalog = catalogues?.[0];
  const book    = books?.[0] || null;

  // catalog nahi mila → genuine 404 (match khatam / ID purani / highlights cache miss)
  if (!catalog) {
    logger.warn(`[catalog2] not in highlights and bpexch failed for ${marketId}`);
    return sendError(res, 'Market not found', 404);
  }

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
        // ✅ MARKET_START_TIME aur EVENT_TYPE add kiye — OtherRaceMarkets (race tabs)
        //    ko eventTypeId chahiye filter karne ke liye, aur fromNow/timer ko
        //    har sub-market (race) ka apna marketStartTime chahiye.
        ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'MARKET_START_TIME', 'EVENT_TYPE'],
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
            inPlay:      (sb?.inPlay === true) || (sb?.status === 'IN_PLAY'),
            eventTypeId: m.eventType?.id ? Number(m.eventType.id) : null,
            marketStartTime:    m.marketStartTime || null,
            marketStartTimeUtc: m.marketStartTime || null,
            winners: (sb?.runners || []).filter((rb) => rb.status === 'WINNER').length,
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
    marketStartTimeUtc:  catalog.marketStartTime,
    eventTypeId,
    eventType:           sportName,
    eventId,
    eventName:           catalog.event?.name,
    competitionId:       catalog.competition?.id,
    // ✅ book null = Betfair ne market remove kar di = CLOSED ho gayi
    status:              book?.status || 'CLOSED',
    isTurnInPlayEnabled: book?.isTurnInPlay ?? false,
    betDelay:            book?.betDelay ?? 0,
    maxBetSize:          book?.maxBetSize ?? book?.totalMatched ?? 0,
    rules:               catalog.description?.rules || '',
    sport: { name: sportName, image: iconMap[sportName] || 'default.svg', active: true },
    // ✅ Winners: book runners se nikalo — book null ho to 0
    winners: (book?.runners || []).filter((rb) => rb.status === 'WINNER').length,
    runners: (catalog.runners || []).map(r => {
      const m2 = r.metadata || r.runnerMetadata || {};
      const cNum = m2.CLOTH_NUMBER || m2.cloth_number || m2.ClothNumber || null;
      const sP   = r.sortPriority || null;
      const posN = parseInt(cNum) || parseInt(sP) || 1;
      const RACE_COLORS = [
        '#E63946','#FFFFFF','#1D3557','#F4D03F','#2ECC71','#111111','#F39C12','#8E44AD',
        '#16A085','#E74C3C','#3498DB','#F1C40F','#E67E22','#1ABC9C','#95A5A6','#2C3E50',
        '#C0392B','#7F8C8D','#27AE60','#D35400',
      ];
      const rb = book?.runners?.find((x) => x.selectionId === r.selectionId);
      return {
        selectionId:  r.selectionId,
        runnerName:   r.runnerName,
        handicap:     r.handicap,
        sortPriority: sP,
        // ✅ book null ho to status ACTIVE rakho — winner Betfair PnL/prices se detect hoga
        status:       rb?.status || 'ACTIVE',
        clothNumber:  cNum,
        clothColor:   RACE_COLORS[(posN - 1) % RACE_COLORS.length],
        silkUrl:      m2.COLOURS_FILENAME_URL || m2.colours_filename_url || m2.ColoursFilenameUrl || null,
        jockeyName:   m2.JOCKEY_NAME  || m2.jockey_name  || m2.JockeyName  || null,
        trainerName:  m2.TRAINER_NAME || m2.trainer_name || m2.TrainerName || null,
        stallDraw:    m2.STALL_DRAW   || m2.stall_draw   || m2.StallDraw   || null,
        age:          m2.AGE          || m2.age          || null,
        form:         m2.FORM         || m2.form         || null,
        officialRating: m2.OFFICIAL_RATING || m2.official_rating || null,
        metadataDict: Object.keys(m2).length > 0 ? m2 : null,
      };
    }),
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

/**
 * GET /api/v1/markets/betfair/active-leagues?eventTypeId=<id>&hoursAhead=48
 * Sirf wahi leagues (competitions) return karta hai jinke andar kam se kam
 * ek match "abhi" ya agle N ghanton (default 48 = 2 din) mein ho raha hai —
 * saari 100+ leagues ka flat dump nahi (jinme se zyadatar off-season hoti hain).
 * Har league ke saath uske matches (eventId, name, startTime) bhi diye jate
 * hain taake admin panel drill-down UI bana sake (league → matches → markets).
 */
async function getBetfairActiveLeagues(req, res) {
  const { eventTypeId, hoursAhead } = req.query;
  if (!eventTypeId) return sendError(res, 'eventTypeId query parameter is required', 400);

  try {
    const hrs  = parseInt(hoursAhead, 10) || 48;
    const now  = new Date();
    const from = new Date(now.getTime() - 30 * 60_000).toISOString(); // 30 min grace (abhi live matches)
    const to   = new Date(now.getTime() + hrs * 3600_000).toISOString();

    const events = await listEvents({
      eventTypeIds: [String(eventTypeId)],
      marketStartTime: { from, to },
    });

    if (!events.length) return sendSuccess(res, { leagues: [] });

    // Competition info sirf listMarketCatalogue se milti hai (listEvents
    // mein nahi hoti), is liye MATCH_ODDS market catalogue nikalte hain
    const eventIds = events.map(e => e.event.id);
    const catalogues = await listMarketCatalogue(
      { eventIds, marketTypeCodes: ['MATCH_ODDS'] },
      '400',
      ['EVENT', 'COMPETITION']
    );

    const leagueMap = {}; // competitionId -> { id, name, matches: [...] }
    catalogues.forEach(m => {
      const comp = m.competition;
      const ev   = m.event;
      if (!comp || !ev) return;
      if (!leagueMap[comp.id]) leagueMap[comp.id] = { id: String(comp.id), name: comp.name, matches: [] };
      if (!leagueMap[comp.id].matches.some(x => x.eventId === ev.id)) {
        leagueMap[comp.id].matches.push({
          eventId:   ev.id,
          marketId:  m.marketId,
          name:      ev.name,
          startTime: ev.openDate,
        });
      }
    });

    const leagues = Object.values(leagueMap).map(l => {
      l.matches.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      return l;
    }).sort((a, b) => a.name.localeCompare(b.name));

    return sendSuccess(res, { leagues });
  } catch (err) {
    logger.error(`getBetfairActiveLeagues error: ${err.message}`);
    return sendError(res, 'Failed to fetch active leagues from Betfair', 500);
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

/* ── NEW: Country → Track hierarchy (Horse Racing / Greyhound) ──────
   Racing sports (eventTypeId 7 = Horse, 4339 = Greyhound) Betfair pe
   "competitions" ki tarah nahi hote — har event ek race hoti hai, jiska
   naam aam taur pe "TrackName (COUNTRY) Race-time" format mein hota hai
   (e.g. "Ballarat (AUS) 23rd Jul"). Isi se hum country + track nikaal
   ke admin ko country > track wala UI dete hain, jaisa asal racing
   sites (Bet365, Betfair khud) dikhate hain — sirf "leagues" nahi.
──────────────────────────────────────────────────────────────── */

// Common Betfair country codes → readable names (jo na mile wahi code dikhega)
const COUNTRY_NAMES = {
  GB: 'United Kingdom', IE: 'Ireland', US: 'United States', AU: 'Australia',
  FR: 'France', ZA: 'South Africa', AE: 'UAE', HK: 'Hong Kong', SG: 'Singapore',
  NZ: 'New Zealand', IN: 'India', JP: 'Japan', CA: 'Canada', DE: 'Germany',
  IT: 'Italy', ES: 'Spain', SE: 'Sweden', NO: 'Norway', ZW: 'Zimbabwe',
  MU: 'Mauritius', AR: 'Argentina', BR: 'Brazil', CL: 'Chile', PE: 'Peru',
  PH: 'Philippines', MY: 'Malaysia', KR: 'South Korea', QA: 'Qatar',
};

async function getBetfairTracks(req, res) {
  const { eventTypeId } = req.query;
  if (!eventTypeId) return sendError(res, 'eventTypeId query parameter is required', 400);

  try {
    const now  = new Date();
    const from = new Date(now.getTime() - 30 * 60_000).toISOString();
    const to   = new Date(now.getTime() + 48 * 3600_000).toISOString(); // 48h ahead — sabhi upcoming races cover karo

    const events = await listEvents({
      eventTypeIds: [String(eventTypeId)],
      marketStartTime: { from, to },
    });

    if (!events.length) return sendSuccess(res, { countries: [] });

    // country → { trackName → { eventCount, races:[{eventId,name,startTime}] } }
    const countryMap = {};
    events.forEach(e => {
      const ev = e.event;
      if (!ev) return;
      const countryCode = ev.countryCode || 'OTHER';
      const rawName = ev.name || '';
      // "Ballarat (AUS) 23rd Jul" → track = "Ballarat"
      const trackName = (rawName.split('(')[0] || rawName).trim() || 'Unknown';

      if (!countryMap[countryCode]) countryMap[countryCode] = {};
      if (!countryMap[countryCode][trackName]) {
        countryMap[countryCode][trackName] = { eventCount: 0, races: [] };
      }
      countryMap[countryCode][trackName].eventCount++;
      // ✅ NEW: har race ka eventId bhi save karo — is se admin panel
      // individual race click karke uske markets select kar sakta hai
      // (pehle sirf track-level count tha, race-level detail nahi thi)
      countryMap[countryCode][trackName].races.push({
        eventId:   ev.id,
        name:      rawName,
        startTime: ev.openDate,
      });
    });

    const countries = Object.keys(countryMap)
      .map(code => ({
        code,
        name: COUNTRY_NAMES[code] || code,
        tracks: Object.keys(countryMap[code])
          .map(name => {
            const t = countryMap[code][name];
            return {
              name,
              eventCount: t.eventCount,
              races: t.races.sort((a, b) => new Date(a.startTime) - new Date(b.startTime)),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return sendSuccess(res, { countries });
  } catch (err) {
    logger.error(`getBetfairTracks error: ${err.message}`);
    return sendError(res, 'Failed to fetch tracks from Betfair', 500);
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
    // ── Prefer bpexch (Bookmaker / Fancy / O-U like live site) ──
    const pricesToken = req.headers['x-prices-token'] || req.query.pricesToken || null;
    try {
      const bpx = await getBpexchEventMarkets(String(eventId), pricesToken);
      if (bpx && (bpx.subMarkets?.length || bpx.marketId)) {
        const buckets = {
          matchOdds: [], bookmaker: [], toss: [], fancy: [], fancy2: [],
          figure: [], oddFigure: [], other: [], all: [],
        };
        const pushCat = (m) => {
          const cat = m.category || 'other';
          const row = {
            marketId: m.marketId,
            marketName: m.marketName,
            marketType: m.marketType || '',
            status: m.status || 'OPEN',
            maxBetSize: m.maxBetSize || 0,
            runners: (m.runners || []).map(r => ({
              selectionId: r.selectionId,
              runnerName: r.runnerName || r.name,
              status: r.status || 'ACTIVE',
              back: r.back || [],
              lay: r.lay || [],
            })),
          };
          buckets.all.push(row);
          if (buckets[cat]) buckets[cat].push(row);
          else if (cat === 'matchOdds') buckets.matchOdds.push(row);
          else buckets.other.push(row);
        };
        // main as matchOdds
        if (bpx.marketId) {
          pushCat({ ...bpx, category: 'matchOdds' });
        }
        for (const sm of (bpx.subMarkets || [])) pushCat(sm);
        logger.info(`[event-markets] bpexch eventId=${eventId} all=${buckets.all.length}`);
        return sendSuccess(res, buckets);
      }
    } catch (e) {
      logger.warn(`[event-markets] bpexch path failed: ${e.message}`);
    }

    // ── Fallback: highlights listMarketCatalogue ──
    const catalogues = await listMarketCatalogue(
      { eventIds: [String(eventId)] },
      '200',  // Betfair max 200
      ['EVENT', 'RUNNER_DESCRIPTION', 'MARKET_DESCRIPTION', 'RUNNER_METADATA', 'MARKET_START_TIME'],
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

      // Greyhound ka Betfair eventTypeId 4339 hai — isi se trap-color scheme decide hoti hai
      const evtTypeId = market.eventType?.id || null;
      const detectedSportKey = evtTypeId === '4339' ? 'greyhound' : 'horse';

      return {
        marketId:    market.marketId,
        marketName,
        marketType,
        status:      book?.status      || 'OPEN',
        status2:     null,
        inPlay:         (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          // ✅ bug fix: 'event' yahan defined nahi tha (sirf 'market' loop var hai) —
          //    isse ReferenceError aata, ab sirf market.marketStartTime use kar rahe hain.
          const st = market?.marketStartTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
        maxBetSize:  book?.maxBetSize  ?? book?.totalMatched ?? 0,
        bettingType: market.description?.bettingType || 'ODDS',
        eventTypeId: evtTypeId,
        // ✅ Match/race ka asal scheduled start time — Betfair MARKET_START_TIME projection se.
        //    Iske bina race timer (Remaining/Elapsed) aur header date kabhi sahi nahi banenge.
        marketStartTime:    market.marketStartTime || null,
        // ✅ mv2.min.js Catalog.marketStartTimeUtc field padhta hai fromNow/timer ke liye
        marketStartTimeUtc: market.marketStartTime || null,
        winners: (book?.runners || []).filter((rb) => rb.status === 'WINNER').length,
        runners:     buildOddsPayload(market.runners || [], book, detectedSportKey),
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
  getBetfairActiveLeagues,   // ← NEW
  getBetfairMarketTypes,
  getBetfairTracks,          // ← NEW
  getEventMarkets,           // ← NEW
};
