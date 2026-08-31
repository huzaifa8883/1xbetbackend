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
  resolveMarketIdFromEventId,
  resolveRealRaceMarketId,
  fetchPrices7MarketData,
  normalizeMarketId,
  sportItems,
} = require('../services/betfair.service');
const { sendSuccess, sendError } = require('../utils/response');
const { SPORT_MAP } = require('../config/constants');
const { SportConfig } = require('../models');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

/* ── Admin Visibility Store ────────────────────────────────
   Simple JSON-file store — koi DB migration ki zaroorat nahi.
   Shape: { "<sportKey>": { hiddenEvents: ["35945509", ...],
                             hiddenMarkets: ["eventId:marketId", ...] } }
   Default = sab visible (jab tak explicitly hide na kiya ho) — naye
   aane wale matches automatically visible rahenge, sirf jo admin
   manually hide kare wo hidden honge. */
const VISIBILITY_FILE = path.join(__dirname, '..', 'data', 'sport-visibility.json');

function loadVisibility() {
  try {
    const raw = fs.readFileSync(VISIBILITY_FILE, 'utf8');
    return JSON.parse(raw) || {};
  } catch (_) {
    return {};
  }
}

function saveVisibility(data) {
  try {
    fs.mkdirSync(path.dirname(VISIBILITY_FILE), { recursive: true });
    fs.writeFileSync(VISIBILITY_FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    logger.error(`[visibility] save failed: ${err.message}`);
    return false;
  }
}

function getHiddenSets(sportKey) {
  const all = loadVisibility();
  const entry = all[sportKey] || {};
  return {
    events:  new Set((entry.hiddenEvents  || []).map(String)),
    markets: new Set((entry.hiddenMarkets || []).map(String)),
  };
}

// Admin panel ke sport keys → backend eventTypeId map (aur reverse)
const SPORT_EVENT_TYPE_MAP = {
  soccer: '1', football: '1', tennis: '2', cricket: '4', horse: '7', greyhound: '4339',
};
function sportKeyForEventTypeId(eventTypeId) {
  const found = Object.entries(SPORT_EVENT_TYPE_MAP).find(([, id]) => id === String(eventTypeId));
  return found ? found[0] : null;
}

// Ek sport ke data array (getLive* ka output) pe hidden-event/market filter
// laga do — admin panel se hide ki hui cheez dashboard se turant gayab.
function applyVisibilityFilter(data, sportKey) {
  if (!Array.isArray(data) || !data.length) return data;
  const { events: hiddenEvents, markets: hiddenMarkets } = getHiddenSets(sportKey);
  if (!hiddenEvents.size && !hiddenMarkets.size) return data;
  return data.filter(item => {
    if (item.eventId && hiddenEvents.has(String(item.eventId))) return false;
    if (item.eventId && item.marketId && hiddenMarkets.has(`${item.eventId}:${item.marketId}`)) return false;
    return true;
  });
}

/* ── Helpers ────────────────────────────────────────────── */

/* ── Shared cloth-color helper ──────────────────────────────
   ✅ BUG FIX: horse race runners pehle sirf ek hi hardcoded red
   (#E63946) dikhate the aur silk image kabhi nahi aati thi, jabke
   greyhound trap-colors sahi aate the. Wajah: getMarketCatalog2 (bpexch
   catalog2 path) mein silkUrl hardcoded null tha aur clothColor sirf
   raw scraped field pe depend karta tha (horse ke liye wo field khaali
   hoti hai — real silk sirf photo hoti hai, hex color nahi). Ab
   position-based fallback color yahan se dono paths (Betfair-metadata
   wala buildOddsPayload() aur bpexch-scrape wala getMarketCatalog2())
   use karte hain, taake horse race mein bhi bpexch jaisi alag-alag
   cloth colors dikhein jab tak real silk image na mil jaye. */
const RACE_COLORS = [
  '#E63946','#FFFFFF','#1D3557','#F4D03F','#2ECC71','#111111','#F39C12','#8E44AD',
  '#16A085','#E74C3C','#3498DB','#F1C40F','#E67E22','#1ABC9C','#95A5A6','#2C3E50',
  '#C0392B','#7F8C8D','#27AE60','#D35400',
];

// Standard greyhound trap colors — fixed worldwide (Australia/AU 8-trap format):
// 1 Red, 2 Blue, 3 White, 4 Black, 5 Orange, 6 Black & White stripes, 7 Green, 8 Pink
const GREYHOUND_COLORS = [
  '#E63946', '#1D3557', '#FFFFFF', '#111111', '#F39C12', '#111111', '#2ECC71', '#FF8FB1',
];
const GREYHOUND_STRIPED_TRAPS = [6]; // trap number(s) that render as black/white stripes

function resolveClothColor(posNum, isGreyhound) {
  const n = parseInt(posNum, 10) || 1;
  const clothColor = isGreyhound
    ? GREYHOUND_COLORS[(n - 1) % GREYHOUND_COLORS.length]
    : RACE_COLORS[(n - 1) % RACE_COLORS.length];
  const isStriped = isGreyhound && GREYHOUND_STRIPED_TRAPS.includes(n);
  return { clothColor, isStriped };
}

function buildOddsPayload(runners, books, sportKey = 'horse') {
  return runners.map((runner) => {
    const rb = books?.runners?.find((r) => r.selectionId === runner.selectionId);

    // RUNNER_METADATA fields — horse race aur greyhound ke liye
    // Betfair kuch responses mein metadata, kuch mein runnerMetadata key use karta hai
    const meta = runner.metadata || runner.runnerMetadata || {};

    const clothNumber = meta.CLOTH_NUMBER || meta.cloth_number || meta.ClothNumber || null;
    const sortPriority = runner.sortPriority || null;
    const posNum = parseInt(clothNumber) || parseInt(sortPriority) || 1;

    const isGreyhound = sportKey === 'greyhound';
    const { clothColor, isStriped } = resolveClothColor(posNum, isGreyhound);

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

  const mapped = catalogues.map(market => {
    const book  = allBooks.find(b => b.marketId === market.marketId);
    const event = events.find(e => e.event.id === market.event?.id);
    return {
      marketId:       market.marketId,
      eventId:        market.event?.id || event?.event?.id || null,
      match:          event?.event.name || market.marketName || 'Unknown',
      startTime:      event?.event.openDate || '',
      marketStatus:   book?.status || 'UNKNOWN',
      inPlay:         (() => {
        if (book?.inPlay === true) return true;
        if (book?.status === 'IN_PLAY') return true;
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

  // Dedupe by marketId (and by match+start minute as secondary)
  const seenId = new Set();
  const seenKey = new Set();
  return mapped.filter(m => {
    const id = String(m.marketId || '');
    if (id && seenId.has(id)) return false;
    if (id) seenId.add(id);
    const key = `${(m.match || '').toLowerCase()}__${(m.startTime || '').slice(0, 16)}`;
    if (seenKey.has(key)) return false;
    seenKey.add(key);
    return true;
  });
}

/* ── Sport endpoints ─────────────────────────────────────── */

async function getLiveCricket(req, res) {
  const data = await fetchSportMarkets('cricket', 4);
  return sendSuccess(res, applyVisibilityFilter(data, 'cricket'));
}

async function getLiveCricketInplay(req, res) {
  const data = await fetchSportMarkets('cricket', 4, { inPlayOnly: true });
  return sendSuccess(res, applyVisibilityFilter(data, 'cricket'));
}

async function getLiveFootball(req, res) {
  const data = await fetchSportMarkets('football', 1);
  return sendSuccess(res, applyVisibilityFilter(data, 'football'));
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
      eventId:         market.event?.id || event?.event?.id || null,
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

  const seen = new Set();
  const deduped = data.filter(m => {
    const id = String(m.marketId || '');
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  return sendSuccess(res, applyVisibilityFilter(deduped, 'tennis'));
}

async function getLiveHorse(req, res) {
  try {
    const cfg = await getSportCfg('horse');
    logger.info(`[getLiveHorse] cfg is_active=${cfg?.is_active} allowed_competition_ids=${cfg?.allowed_competition_ids || ''} allowed_countries=${cfg?.allowed_countries || ''} max_results=${cfg?.max_results} hours_ahead=${cfg?.hours_ahead}`);
    if (cfg && cfg.is_active === false) return sendSuccess(res, []);

    const maxResults = String(cfg?.max_results ?? 200);
    const hoursAhead = cfg?.hours_ahead ?? 24;

    const now  = new Date();
    // ✅ from: 5 min peeche (inplay races cover karne ke liye)
    const from = new Date(now.getTime() - 5 * 60_000).toISOString();
    const to   = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

    // ✅ FIX: pehle listEvents() aur listMarketCatalogue() DO ALAG,
    // independent bpexch scrapes karte the aur phir eventId se match karke
    // combine karte the. bpexch ka page live badalta rehta hai, is liye
    // jab dono fetch 4-second highlights-cache window se bahar gir jate
    // the (jo cron/parallel-request overlap ki wajah se aksar hota tha),
    // dono scrapes ke IDs match nahi karte the — data silently gir jata
    // (kabhi 15 races milte, kabhi sirf 6, kabhi 0). Ab sirf EK scrape
    // hoti hai aur wahi seedha events + catalogues dono ke liye use hoti
    // hai, isliye IDs hamesha guaranteed match karengi — jitna data
    // scrape mein milta hai, utna hi seedha bhej diya jata hai.
    const items = await sportItems('7');
    if (!items.length) return sendSuccess(res, []);

    // ✅ Track-naam whitelist filter hata diya — bpexch mein jitne bhi
    // live races aayein, sab seedha bhej do. (Pehle allowed_competition_ids
    // ek stale/corrupted track+time list thi jo taqreeban har live race
    // ko silently drop kar rahi thi — ye poora filtering step hi ab
    // hata diya gaya hai taake koi bhi DB config future mein races
    // chupa na sake.)
    const filteredItems = items;
    if (!filteredItems.length) return sendSuccess(res, []);

    const sliced = filteredItems.slice(0, parseInt(maxResults, 10) || 200);
    logger.info(`[getLiveHorse] items=${items.length} filtered=${filteredItems.length} sliced=${sliced.length}`);

    // Books fetch in chunks
    const CHUNK = 200;
    const allMarketIds = sliced.map(m => m.id);
    let allBooks = [];
    for (let i = 0; i < allMarketIds.length; i += CHUNK) {
      const books = await listMarketBook(allMarketIds.slice(i, i + CHUNK)).catch(() => []);
      allBooks = allBooks.concat(books);
    }

    // ✅ Map — market.start use karo (ab ek hi scrape se aata hai, event
    // se dobara match karne ki zaroorat nahi — id aur event.id already
    // isi item mein consistent hain)
    const mapped = sliced.map(m => {
      const book = allBooks.find(b => b.marketId === m.id);
      const startTime = m.start || m.event?.openDate || '';

      return {
        marketId:        m.id,
        eventId:         m.event?.id || null,
        match:           m.event?.name || m.name || 'Unknown',
        startTime,
        marketStatus:    book?.status || 'UNKNOWN',
        inPlay:          (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          const st = m.event?.openDate || startTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
        totalMatched:    book?.totalMatched || 0,
        runners:         buildOddsPayload(m.runners || [], book, 'horse'),
        competitionId:   m.competition?.id   || null,
        competitionName: m.competition?.name || null,
      };
    });

    // ✅ Filter: sirf window ke andar (future + recently started, 5 min grace)
    const cutoff = new Date(now.getTime() - 5 * 60_000);
    const windowEnd = new Date(to);
    const filtered = mapped.filter(d => {
      if (!d.startTime) return false;
      const t = new Date(d.startTime);
      return t >= cutoff && t <= windowEnd;
    });

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

    logger.info(`[getLiveHorse] mapped=${mapped.length} filtered=${filtered.length} deduped=${deduped.length}`);
    return sendSuccess(res, applyVisibilityFilter(deduped, 'horse'));
  } catch (err) {
    logger.error(`getLiveHorse error: ${err.message}`);
    return sendError(res, 'Failed to fetch horse racing data', 500);
  }
}

async function getLiveGreyhound(req, res) {
  try {
    const cfg = await getSportCfg('greyhound');
    logger.info(`[getLiveGreyhound] cfg is_active=${cfg?.is_active} allowed_competition_ids=${cfg?.allowed_competition_ids || ''} allowed_countries=${cfg?.allowed_countries || ''} max_results=${cfg?.max_results} hours_ahead=${cfg?.hours_ahead}`);
    if (cfg && cfg.is_active === false) return sendSuccess(res, []);

    const maxResults = String(cfg?.max_results ?? 200);
    const hoursAhead = cfg?.hours_ahead ?? 12;

    const now  = new Date();
    // ✅ from: 5 min peeche (inplay races cover karne ke liye)
    const from = new Date(now.getTime() - 5 * 60_000).toISOString();
    const to   = new Date(now.getTime() + hoursAhead * 3600_000).toISOString();

    // ✅ FIX: horse wala hi fix — pehle listEvents() aur
    // listMarketCatalogue() do alag independent scrapes karte the, jinke
    // beech bpexch ka page badal jaata to IDs match nahi karte the aur
    // races silently gir jaati (kabhi 15, kabhi sirf 6). Ab sirf EK scrape.
    const items = await sportItems('4339');
    if (!items.length) return sendSuccess(res, []);

    // ✅ Track-naam whitelist filter hata diya — bpexch mein jitne bhi
    // live races aayein, sab seedha bhej do (horse wala hi fix).
    const filteredItems = items;
    if (!filteredItems.length) return sendSuccess(res, []);

    const sliced = filteredItems.slice(0, parseInt(maxResults, 10) || 200);
    logger.info(`[getLiveGreyhound] items=${items.length} filtered=${filteredItems.length} sliced=${sliced.length}`);

    // Books fetch in chunks
    const CHUNK = 200;
    const allMarketIds = sliced.map(m => m.id);
    let allBooks = [];
    for (let i = 0; i < allMarketIds.length; i += CHUNK) {
      const books = await listMarketBook(allMarketIds.slice(i, i + CHUNK)).catch(() => []);
      allBooks = allBooks.concat(books);
    }

    // ✅ Map — market.start use karo (ek hi scrape se aata hai, dobara
    // event match karne ki zaroorat nahi)
    const mapped = sliced.map(m => {
      const book = allBooks.find(b => b.marketId === m.id);
      const startTime = m.start || m.event?.openDate || '';

      return {
        marketId:        m.id,
        eventId:         m.event?.id || null,
        match:           m.event?.name || m.name || 'Unknown',
        startTime,
        marketStatus:    book?.status || 'UNKNOWN',
        inPlay:          (() => {
          if (book?.inPlay === true) return true;
          if (book?.status === 'IN_PLAY') return true;
          const st = m.event?.openDate || startTime;
          if (st && new Date(st) <= new Date() && book?.status === 'OPEN') return true;
          return false;
        })(),
        totalMatched:    book?.totalMatched || 0,
        runners:         buildOddsPayload(m.runners || [], book, 'greyhound'),
        competitionId:   m.competition?.id   || null,
        competitionName: m.competition?.name || null,
      };
    });

    // ✅ Filter: sirf window ke andar (future + recently started, 5 min grace)
    const cutoff = new Date(now.getTime() - 5 * 60_000);
    const windowEnd = new Date(to);
    const filtered = mapped.filter(d => {
      if (!d.startTime) return false;
      const t = new Date(d.startTime);
      return t >= cutoff && t <= windowEnd;
    });

    // ✅ Deduplicate by marketId
    const seen = new Set();
    const deduped = filtered.filter(d => {
      if (seen.has(d.marketId)) return false;
      seen.add(d.marketId);
      return true;
    });

    // ✅ Sort ascending — nearest race pehle
    deduped.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

    logger.info(`[getLiveGreyhound] mapped=${mapped.length} filtered=${filtered.length} deduped=${deduped.length}`);
    return sendSuccess(res, applyVisibilityFilter(deduped, 'greyhound'));
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
  let { id: rawId } = req.query;
  if (!rawId) return sendError(res, 'marketId query parameter is required', 400);

  let marketId = normalizeMarketId(rawId);
  // eventId-only (path style) → resolve
  if (!String(rawId).includes('.') && !/^[mM]_/.test(String(rawId))) {
    const resolved = await resolveMarketIdFromEventId(String(rawId)).catch(() => null);
    if (resolved) marketId = resolved;
  }

  // ✅ FIX: composite race id (jaise "36002580.0805") mein bhi ek dot
  // hota hai, is liye upar wala check ise "already a real marketId"
  // maan leta tha aur seedha prices7 ko bhej deta tha — jo hamesha
  // marketBooks: [{ runners: [] }] khaali de deta tha (real Betfair
  // format "1.xxx" nahi hai). Ab isko bhi verified real marketId mein
  // resolve karte hain (wahi shared helper jo catalog2 endpoint bhi
  // use karta hai) — runners/odds ab yahan bhi aayenge.
  const isRaceComposite = /^\d{6,}\.\d+$/.test(String(marketId));
  if (isRaceComposite) {
    try {
      const { realId } = await resolveRealRaceMarketId(marketId);
      if (realId) {
        logger.info(`[marketData] race composite ${marketId} → verified real marketId ${realId}`);
        marketId = realId;
      } else {
        logger.warn(`[marketData] race composite ${marketId} — no verified racing marketId found`);
      }
    } catch (e) {
      logger.warn(`[marketData] race composite resolve failed: ${e.message}`);
    }
  }

  const pricesToken = req.headers['x-prices-token'] || req.query.pricesToken || null;

  // ── PRIMARY: prices7 Data — full 3-level ladder + all related market books ──
  // mv2.min.js polls this endpoint; shape must match prices7 marketBooks
  try {
    const live = await fetchPrices7MarketData(marketId, pricesToken);
    if (live && Array.isArray(live.marketBooks) && live.marketBooks.length) {
      logger.info(`[marketData] prices7 books=${live.marketBooks.length} for ${marketId}`);
      return sendSuccess(res, {
        requestId: uuidv4(),
        marketBooks: live.marketBooks,
        news: live.news || '',
        scores: live.scores || null,
        scoreboard: live.scoreboard || null,
      });
    }
  } catch (e) {
    logger.warn(`[marketData] prices7 failed: ${e.message}`);
  }

  // ── FALLBACK: highlights listMarketBook (1-level only) ──
  const [catalogues, mainBooks] = await Promise.all([
    listMarketCatalogue({ marketIds: [marketId] }, '1', ['EVENT', 'RUNNER_DESCRIPTION']),
    listMarketBook([marketId]),
  ]);

  const catalog = catalogues?.[0];
  const mainBook = mainBooks?.[0];
  if (!mainBook) return sendError(res, 'Market not found', 404);

  const runnerMap = {};
  (catalog?.runners || []).forEach(r => { runnerMap[r.selectionId] = r.runnerName; });

  function bookToMarketBook(book, rMap) {
    return {
      id:             book.marketId,
      betDelay:       book.betDelay || 0,
      totalMatched:   book.totalMatched || 0,
      marketStatus:   book.status || 'OPEN',
      bettingAllowed: true,
      isRoot:         String(book.marketId) === String(marketId),
      runners: (book.runners || []).map(r => {
        const backs = r.ex?.availableToBack || [];
        const lays  = r.ex?.availableToLay || [];
        // Highlights often only have 1 level — put it on price3/lay1 (center columns near spread)
        const b0 = backs[0] || {};
        const b1 = backs[1] || {};
        const b2 = backs[2] || {};
        const l0 = lays[0] || {};
        const l1 = lays[1] || {};
        const l2 = lays[2] || {};
        // If only 1 price, map to best-back (price3) and best-lay (lay1) for UI
        let price1 = b0.price, price2 = b1.price, price3 = b2.price;
        let size1 = b0.size, size2 = b1.size, size3 = b2.size;
        let lay1 = l0.price, lay2 = l1.price, lay3 = l2.price;
        let ls1 = l0.size, ls2 = l1.size, ls3 = l2.size;
        if (backs.length === 1 && !b1.price && !b2.price) {
          price3 = b0.price; size3 = b0.size;
          price1 = undefined; size1 = undefined;
          price2 = undefined; size2 = undefined;
        }
        if (lays.length === 1 && !l1.price && !l2.price) {
          lay1 = l0.price; ls1 = l0.size;
          lay2 = undefined; ls2 = undefined;
          lay3 = undefined; ls3 = undefined;
        }
        return {
          id: r.selectionId,
          name: rMap[r.selectionId] || r.runnerName || '',
          price1: price1 || 0, price2: price2 || 0, price3: price3 || 0,
          size1: size1 || 0, size2: size2 || 0, size3: size3 || 0,
          lay1: lay1 || 0, lay2: lay2 || 0, lay3: lay3 || 0,
          ls1: ls1 || 0, ls2: ls2 || 0, ls3: ls3 || 0,
          status: r.status || 'ACTIVE',
          handicap: 0,
        };
      }),
      timestamp: book.lastMatchTime || new Date().toISOString(),
      winnerIDs: [],
    };
  }

  const marketBooks = [bookToMarketBook(mainBook, runnerMap)];
  logger.info(`[marketData] highlights fallback books=1 for ${marketId}`);
  return sendSuccess(res, { requestId: uuidv4(), marketBooks, news: '' });
}

async function getMarketCatalog2(req, res) {
  const { id: rawId } = req.query;
  if (!rawId) return sendError(res, 'marketId query parameter is required', 400);

  let marketId = normalizeMarketId(rawId); // m_1_261306873 → 1.261306873
  if (String(rawId) !== String(marketId)) {
    logger.info(`[catalog2] normalized ${rawId} → ${marketId}`);
  }

  // Path-style Event.html: /Common/Event/35945509 → id is eventId (no "1.")
  // Resolve to Match Odds marketId first
  const looksLikeEventId = !/^[mM]_/.test(String(rawId)) && !String(rawId).includes('.');
  if (looksLikeEventId) {
    try {
      const pricesToken0 = req.headers['x-prices-token'] || req.query.pricesToken || null;
      const byEvent = await getBpexchEventMarkets(String(rawId), pricesToken0);
      if (byEvent && byEvent.marketId) {
        marketId = String(byEvent.marketId);
        logger.info(`[catalog2] eventId ${rawId} → marketId ${marketId}`);
        // If we already have full page payload, return it (with odds fill below path)
        // Fall through using resolved marketId + reuse byEvent as bpx if present
        req._bpexchEventPage = byEvent;
      } else {
        const resolved = await resolveMarketIdFromEventId(String(rawId));
        if (resolved) {
          marketId = resolved;
          logger.info(`[catalog2] eventId ${rawId} resolved via highlights → ${marketId}`);
        }
      }
    } catch (e) {
      logger.warn(`[catalog2] eventId resolve failed: ${e.message}`);
    }
  }

  // ✅ Prefer bpexch catalog2 + catalogs + (optional) prices7 scoreboard
  // Real Betfair-style IDs (1.xxx / 9.xxx) ke liye ye path Bookmaker/Fancy/
  // Figure + scorecard/commentary laata hai — bilkul bpexch market page jaisa.
  try {
    const pricesToken = req.headers['x-prices-token'] || req.query.pricesToken || null;
    const bpx = req._bpexchEventPage && String(req._bpexchEventPage.marketId) === String(marketId)
      ? req._bpexchEventPage
      : await getBpexchMarketPage(marketId, pricesToken);
    if (bpx && bpx.marketId) {
      let eventTypeId = String(bpx.eventTypeId || bpx.sport?.id || '');
      const sportName = bpx.eventType || bpx.sport?.name || SPORT_MAP[eventTypeId] || 'Unknown';
      const iconMap = {
        Cricket: 'cricket.svg', Tennis: 'tennis.svg',
        'Horse Racing': 'horse.svg', Soccer: 'soccer.svg',
        'Greyhound Racing': 'greyhound-racing.svg',
      };
      logger.info(`[catalog2] bpexch hit marketId=${marketId} subs=${(bpx.subMarkets||[]).length} scoreboard=${!!bpx.scoreboard}`);

      const isRaceId = /^\d{6,}\.\d+$/.test(String(marketId));
      const isGreyForColors = ['4339'].includes(String(bpx.eventTypeId)) ||
        /grey\s*hound/i.test(String(bpx.eventType || ''));
      // If catalog2 runners have no prices, fill from highlights listMarketBook
      let runnersOut = (bpx.runners || []).map((r, idx) => {
          const posNum = parseInt(r.clothNumber, 10) || parseInt(r.sortPriority, 10) || idx + 1;
          const { clothColor: fallbackColor, isStriped } = resolveClothColor(posNum, isGreyForColors);
          // ✅ BUG FIX: silkUrl pehle hardcoded null tha, is liye horse race mein
          // kabhi bhi asli silk image nahi aati thi (bpexch is field ko 'silk' ya
          // 'silkUrl' ke naam se bhejta hai — humne padhna hi nahi tha). Greyhound
          // ke liye silk image nahi hoti (trap color hi hota hai), horse ke liye
          // real image ho to wahi use karo, warna position-based color fallback.
          const silkUrl = isGreyForColors
            ? null
            : (r.silk || r.silkUrl || r.metadata?.COLOURS_FILENAME_URL || r.coloursFilenameUrl || null);
          return {
          selectionId:  r.selectionId,
          runnerName:   r.runnerName,
          handicap:     r.handicap || 0,
          sortPriority: r.sortPriority || 0,
          status:       r.status || 'ACTIVE',
          back:         r.back || [],
          lay:          r.lay || [],
          price1: r.price1 ?? r.back?.[0]?.price, size1: r.size1 ?? r.back?.[0]?.size,
          price2: r.price2 ?? r.back?.[1]?.price, size2: r.size2 ?? r.back?.[1]?.size,
          price3: r.price3 ?? r.back?.[2]?.price, size3: r.size3 ?? r.back?.[2]?.size,
          lay1: r.lay1 ?? r.lay?.[0]?.price, ls1: r.ls1 ?? r.lay?.[0]?.size,
          lay2: r.lay2 ?? r.lay?.[1]?.price, ls2: r.ls2 ?? r.lay?.[1]?.size,
          lay3: r.lay3 ?? r.lay?.[2]?.price, ls3: r.ls3 ?? r.lay?.[2]?.size,
          clothNumber:  r.clothNumber || posNum || null,
          clothColor:   r.silkColor || r.clothColor || fallbackColor,
          clothStriped: isStriped,
          silkUrl,
          jockeyName:   r.jockeyName || null,
          trainerName:  r.trainerName || null,
          metadataDict: r.metadata || null,
        };
        }).filter(r => {
          const n = String(r.runnerName || '');
          // drop Vue/score template junk that was scraped by mistake
          if (!n || /\{\{|scores\.|v-if|v-for|^\{\s*gs/i.test(n)) return false;
          return true;
        });
      // Racing composite id: force horse/greyhound eventTypeId so UI uses race template
      if (isRaceId) {
        if (['7', '4339'].includes(String(bpx.eventTypeId))) {
          eventTypeId = String(bpx.eventTypeId);
        } else if (!['7', '4339'].includes(eventTypeId)) {
          eventTypeId = '7';
        }
      }
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

    // Competition info bpexch highlights mein nahi hoti (competition: null).
    // Fallback: competition ho to usse group karo, warna event ko
    // "Other Matches" ya direct match row ke taur pe dikhao.
    const leagueMap = {};

    // First pass: catalog se banao (competition available ho to sahi grouping)
    catalogues.forEach(m => {
      const comp = m.competition;
      const ev   = m.event;
      if (!ev) return;

      // Competition key — agar null to 'no_comp' pseudo key
      const compId   = comp?.id   || 'no_comp';
      const compName = comp?.name || 'All Matches';

      if (!leagueMap[compId]) leagueMap[compId] = { id: String(compId), name: compName, matches: [] };
      if (!leagueMap[compId].matches.some(x => x.eventId === ev.id)) {
        leagueMap[compId].matches.push({
          eventId:   ev.id,
          marketId:  m.marketId,
          name:      ev.name,
          startTime: ev.openDate || m.marketStartTime,
        });
      }
    });

    // Second pass: listEvents se jo bhi events mile the unhe ensure karo
    // (catalog mein na ho to directly add karo — taake koi match miss na ho)
    events.forEach(e => {
      const ev = e.event;
      if (!ev?.id) return;
      const alreadyIn = Object.values(leagueMap).some(l => l.matches.some(m => m.eventId === ev.id));
      if (!alreadyIn) {
        if (!leagueMap['no_comp']) leagueMap['no_comp'] = { id: 'no_comp', name: 'All Matches', matches: [] };
        leagueMap['no_comp'].matches.push({
          eventId:   ev.id,
          marketId:  null,
          name:      ev.name,
          startTime: ev.openDate,
        });
      }
    });

    const leagues = Object.values(leagueMap)
      .filter(l => l.matches.length > 0)
      .map(l => {
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

    // WIN markets fetch karo — real marketId ke liye (taake admin panel
    // se select/deselect sahi eventId pe match kare applyVisibilityFilter ke saath)
    const eventIds = events.map(e => e.event?.id).filter(Boolean);
    let marketIdMap = {}; // eventId → marketId
    try {
      const cats = await listMarketCatalogue(
        { eventIds, marketTypeCodes: ['WIN'] },
        String(Math.min(eventIds.length + 10, 400)),
        ['EVENT']
      );
      cats.forEach(m => {
        if (m.event?.id && m.marketId) marketIdMap[m.event.id] = m.marketId;
      });
    } catch (e) {
      logger.warn(`[getBetfairTracks] WIN catalogue fetch failed: ${e.message}`);
    }

    // country → { trackName → { eventCount, races:[{eventId,marketId,name,startTime}] } }
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
      countryMap[countryCode][trackName].races.push({
        eventId:   ev.id,
        marketId:  marketIdMap[ev.id] || null,  // real WIN marketId
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

/* ── NEW: Admin Sports-Tree Visibility endpoints ─────────────
   Sports Settings tree UI (admin.html) inhi 4 endpoints se chalta hai.
──────────────────────────────────────────────────────────────── */

// Racing (horse/greyhound) ke country>track>race shape ko tree UI ke
// "league > matches" shape mein normalize karta hai (track = league).
function flattenTracksToLeagues(countries) {
  const leagues = [];
  countries.forEach(c => {
    (c.tracks || []).forEach(t => {
      leagues.push({
        id: `${c.code}:${t.name}`,
        name: `${t.name} (${c.code})`,
        // marketId: r.marketId (agar available ho) warna r.eventId
        // visibility filter eventId pe hoti hai — marketId sirf UI ke liye
        matches: (t.races || []).map(r => ({
          eventId:   r.eventId,
          marketId:  r.marketId || r.eventId,  // real marketId prefer karo
          name:      r.name,
          startTime: r.startTime,
        })),
      });
    });
  });
  return leagues;
}

/**
 * GET /api/v1/admin/visibility/tree?eventTypeId=&hoursAhead=48
 * League/Track → Matches, har match ke saath current visible state.
 */
async function getVisibilityTree(req, res) {
  const { eventTypeId, hoursAhead } = req.query;
  if (!eventTypeId) return sendError(res, 'eventTypeId query parameter is required', 400);

  try {
    const sportKey = sportKeyForEventTypeId(eventTypeId) || 'unknown';
    const { events: hiddenEvents } = getHiddenSets(sportKey);
    const isRacing = ['7', '4339'].includes(String(eventTypeId));

    let leagues;
    if (isRacing) {
      const fakeReq = { query: { eventTypeId } };
      let out;
      const fakeRes = { json: (d) => { out = d; }, status: () => fakeRes };
      await getBetfairTracks(fakeReq, fakeRes);
      leagues = flattenTracksToLeagues(out?.data?.countries || []);
    } else {
      const fakeReq = { query: { eventTypeId, hoursAhead: hoursAhead || 48 } };
      let out;
      const fakeRes = { json: (d) => { out = d; }, status: () => fakeRes };
      await getBetfairActiveLeagues(fakeReq, fakeRes);
      leagues = out?.data?.leagues || [];
    }

    leagues.forEach(l => l.matches.forEach(m => { m.visible = !hiddenEvents.has(String(m.eventId)); }));
    return sendSuccess(res, { leagues });
  } catch (err) {
    logger.error(`getVisibilityTree error: ${err.message}`);
    return sendError(res, 'Failed to load sports visibility tree', 500);
  }
}

/**
 * GET /api/v1/admin/visibility/markets?eventId=&eventTypeId=
 * Ek match ke saare available markets, current visible state ke saath.
 */
async function getVisibilityMarkets(req, res) {
  const { eventId, eventTypeId } = req.query;
  if (!eventId) return sendError(res, 'eventId query parameter is required', 400);

  try {
    const sportKey = sportKeyForEventTypeId(eventTypeId) || 'unknown';
    const isRacing = ['horse', 'greyhound'].includes(sportKey);
    const { markets: hiddenMarkets } = getHiddenSets(sportKey);

    let markets = [];

    if (!isRacing) {
      // ✅ FIX: cricket/tennis/football ke liye listMarketCatalogue sirf
      // ek hi synthetic "Match Odds" market deta tha — Bookmaker/Toss/
      // Fancy/etc uska hissa nahi hote (wo sirf getBpexchEventMarkets se
      // milte hain, jo /event-markets route bhi use karta hai). Ab yahan
      // bhi wahi function use kar rahe hain taake tree mein saare markets
      // dikhein, sirf Match Odds nahi.
      try {
        const bpx = await getBpexchEventMarkets(String(eventId));
        if (bpx?.marketId) {
          markets.push({
            marketId: bpx.marketId,
            marketName: bpx.marketName || 'Match Odds',
            marketType: 'MATCH_ODDS',
          });
        }
        for (const sm of (bpx?.subMarkets || [])) {
          markets.push({
            marketId: sm.marketId,
            marketName: sm.marketName || sm.category || 'Market',
            marketType: sm.marketType || sm.category || '',
          });
        }
      } catch (e) {
        logger.warn(`[getVisibilityMarkets] bpexch fetch failed for eventId=${eventId}: ${e.message}`);
      }
    }

    // Racing (real Betfair) — ya bpexch se kuch na mila to fallback
    if (isRacing || !markets.length) {
      const catalogues = await listMarketCatalogue({ eventIds: [String(eventId)] }, '50', ['MARKET_DESCRIPTION', 'EVENT']);
      markets = catalogues.map(m => ({
        marketId:   m.marketId,
        marketName: m.marketName,
        marketType: m.description?.marketType || m.marketName || '',
      }));
    }

    const result = markets.map(m => ({
      ...m,
      visible: !hiddenMarkets.has(`${eventId}:${m.marketId}`),
    }));
    return sendSuccess(res, { markets: result });
  } catch (err) {
    logger.error(`getVisibilityMarkets error: ${err.message}`);
    return sendError(res, 'Failed to load markets for event', 500);
  }
}

/**
 * POST /api/v1/admin/visibility/match   { eventId, sportKey, visible }
 */
async function setMatchVisibility(req, res) {
  const { eventId, sportKey, visible } = req.body || {};
  if (!eventId || !sportKey) return sendError(res, 'eventId and sportKey are required', 400);

  try {
    const all = loadVisibility();
    if (!all[sportKey]) all[sportKey] = { hiddenEvents: [], hiddenMarkets: [] };
    const set = new Set((all[sportKey].hiddenEvents || []).map(String));
    if (visible) set.delete(String(eventId)); else set.add(String(eventId));
    all[sportKey].hiddenEvents = Array.from(set);
    saveVisibility(all);
    return sendSuccess(res, { eventId, visible: !!visible });
  } catch (err) {
    logger.error(`setMatchVisibility error: ${err.message}`);
    return sendError(res, 'Failed to update match visibility', 500);
  }
}

/**
 * POST /api/v1/admin/visibility/market   { eventId, marketId, sportKey, visible }
 */
async function setMarketVisibility(req, res) {
  const { eventId, marketId, sportKey, visible } = req.body || {};
  if (!eventId || !marketId || !sportKey) return sendError(res, 'eventId, marketId and sportKey are required', 400);

  try {
    const all = loadVisibility();
    if (!all[sportKey]) all[sportKey] = { hiddenEvents: [], hiddenMarkets: [] };
    const key = `${eventId}:${marketId}`;
    const set = new Set((all[sportKey].hiddenMarkets || []).map(String));
    if (visible) set.delete(key); else set.add(key);
    all[sportKey].hiddenMarkets = Array.from(set);
    saveVisibility(all);
    return sendSuccess(res, { eventId, marketId, visible: !!visible });
  } catch (err) {
    logger.error(`setMarketVisibility error: ${err.message}`);
    return sendError(res, 'Failed to update market visibility', 500);
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
  getVisibilityTree,         // ← NEW (admin sports-tree)
  getVisibilityMarkets,      // ← NEW (admin sports-tree)
  setMatchVisibility,        // ← NEW (admin sports-tree)
  setMarketVisibility,       // ← NEW (admin sports-tree)
  getEventMarkets,           // ← NEW
};
