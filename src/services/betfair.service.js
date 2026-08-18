'use strict';

/* ═══════════════════════════════════════════════════════════════════
   ⚠️ MIGRATION NOTICE — BetwayInfo (2nd migration, Rollwin/Shubdx se)
   ═══════════════════════════════════════════════════════════════════
   Odds/listing data ab BetwayInfo (betwayinfo.com) se aata hai — ye
   ek Betfair-RELAY hai (khud ka data nahi banata, seedha Betfair se
   proxy karta hai). Confirm ho chuka hai: catalog2 response mein
   "origin": "BETFAIR" milta hai, matlab market IDs ASAL Betfair market
   IDs hain (jaise "1.255462233").

   Isi wajah se:
   ✅ Odds/listing (listEvents, listMarketCatalogue, listMarketBook,
      listCompetitions, listEventTypes) — BetwayInfo se (neeche).
   ✅ Settlement (listMarketProfitAndLoss) — REAL Betfair API se hi
      (login/session code neeche zinda rakha hai) — kyunki market IDs
      genuine Betfair IDs hain, Betfair khud unhe pehchanta hai. Ye
      bilkul wahi pattern hai jo Rollwin migration mein bhi tha.

   Client instruction (verbatim): "/api/ ki jagah /api1/ use karo" —
   is liye menu endpoint /api1/menu hai (docs mein /api/menu likha tha).

   ✅ CONFIRMED /api1/menu shape:
      { eventTypeId, eventTypeName, competitionId, competitionName,
        eventid, eventname, openDate, marketId, status, inPlay }
      → Menu SIRF primary market (Match Odds) deta hai per event.

   ✅ CONFIRMED (real in-play match, marketId=1.259466913 se):
      /data/Data ka marketBooks[].runners[] structure:
      { id, price1/2/3, size1/2/3, lay1/2/3, ls1/2/3 (← lay SIZE),
        status, handicap }. marketStatus field (generic "status" nahi).

   ✅ RELATED MARKETS (Match Odds ke alawa):
      Menu ek hi marketId deta hai. Sibling markets sequential IDs par
      hain (seed, seed+1, …). expandRelatedMarkets() /data/catalogs batch
      (+ /data/catalog2 fallback) se same-eventId markets nikaalta hai:
      Over/Under, Correct Score, Half Time, Double Chance, Tied Match,
      Goal Lines, Fancy, Bookmaker, etc. listMarketCatalogue ab ye saari
      markets return karta hai (sirf Match Odds nahi).
   ═══════════════════════════════════════════════════════════════════ */

const axios  = require('axios');
const logger = require('../utils/logger');
const { SPORT_MAP } = require('../config/constants');

const BASE_URL = process.env.BETWAY_BASE_URL || 'https://betwayinfo.com';
const TIMEOUT_MS = 15000;

/* ═══════════════════════════════════════════════════════════════════
   ✅ REAL Betfair session/login — SETTLEMENT ke liye zinda hai
   (listMarketProfitAndLoss). Market IDs genuine Betfair IDs hain
   (origin:"BETFAIR" confirm), is liye settlement humesha real Betfair
   API se hi query hoti hai — code bilkul waisa hi hai jo pehle tha.
   ═══════════════════════════════════════════════════════════════════ */
const APP_KEY  = process.env.BETFAIR_APP_KEY;
const USERNAME = process.env.BETFAIR_USERNAME;
const PASSWORD = process.env.BETFAIR_PASSWORD;
const LOGIN_URL  = process.env.BETFAIR_LOGIN_URL  || 'https://identitysso.betfair.com/api/login';
const API_URL    = process.env.BETFAIR_API_URL     || 'https://api.betfair.com/exchange/betting/json-rpc/v1';
const TTL_MS     = parseInt(process.env.BETFAIR_SESSION_TTL_MINUTES || '25', 10) * 60 * 1000;

const BASE_BAN_COOLDOWN_MS = parseInt(process.env.BETFAIR_BAN_COOLDOWN_MINUTES || '30', 10) * 60 * 1000;
const MAX_BAN_COOLDOWN_MS  = parseInt(process.env.BETFAIR_MAX_BAN_COOLDOWN_MINUTES || '360', 10) * 60 * 1000;

let cachedToken = null;
let tokenExpiry = null;
let loginPromise = null;
let bannedUntil = null;
let consecutiveBans = 0;

function currentCooldownMs() {
  const scaled = BASE_BAN_COOLDOWN_MS * Math.pow(2, consecutiveBans);
  return Math.min(scaled, MAX_BAN_COOLDOWN_MS);
}

async function getSessionToken() {
  if (bannedUntil && Date.now() < bannedUntil) {
    const waitMin = Math.ceil((bannedUntil - Date.now()) / 60000);
    throw new Error(`Betfair temporarily banned — cooldown active, ~${waitMin} min baaki (login try nahi kiya jaa raha, is se ban renew hone se bach raha hai)`);
  }
  if (bannedUntil && Date.now() >= bannedUntil) {
    bannedUntil = null;
  }

  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  if (loginPromise) {
    return loginPromise;
  }

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
        cachedToken = null;
        tokenExpiry = null;

        if (String(errorMsg).includes('TEMPORARY_BAN') || String(errorMsg).includes('TOO_MANY_REQUESTS')) {
          consecutiveBans += 1;
          const cooldown = currentCooldownMs();
          bannedUntil = Date.now() + cooldown;
          logger.error(
            `Betfair: TEMPORARY_BAN detected (${consecutiveBans}${consecutiveBans === 1 ? 'st' : consecutiveBans === 2 ? 'nd' : 'th'} baar) — ` +
            `${Math.round(cooldown / 60000)} min ke liye login attempts ROK diye gaye. ` +
            `Is dauran koi bhi Betfair request nahi jayegi.`
          );
        }
        throw new Error(`Betfair login failed: ${errorMsg}`);
      }

      consecutiveBans = 0;
      bannedUntil = null;

      cachedToken = res.data.token;
      tokenExpiry = Date.now() + TTL_MS;
      logger.info('Betfair: New session token successfully generated');
      return cachedToken;
    } catch (err) {
      cachedToken = null;
      tokenExpiry = null;
      throw err;
    } finally {
      loginPromise = null;
    }
  })();

  return loginPromise;
}

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

    if (error && (error.code === -32099 || error.data?.APINGException?.errorCode === 'INVALID_SESSION_INFORMATION')) {
      logger.warn('Betfair: Session invalidated on RPC call, clearing cached token');
      cachedToken = null;
      tokenExpiry = null;
      if (!isRetry) {
        return jsonRpc(method, params, true);
      }
    }

    if (!result) {
      throw new Error(`No result from Betfair: ${method} - error: ${JSON.stringify(error)}`);
    }

    return result;
  } catch (err) {
    if (err.message.includes('INVALID_SESSION') || err.message.includes('login failed')) {
      cachedToken = null;
      tokenExpiry = null;
    }
    throw err;
  }
}

async function listMarketProfitAndLoss(marketIds = []) {
  return jsonRpc('SportsAPING/v1.0/listMarketProfitAndLoss', {
    marketIds,
    includeSettledBets: true,
    includeBspBets: true,
    netOfCommission: false,
  });
}

function getBanStatus() {
  if (!bannedUntil || Date.now() >= bannedUntil) return { banned: false, consecutiveBans };
  return {
    banned: true,
    consecutiveBans,
    retryAfterMs: bannedUntil - Date.now(),
    retryAt: new Date(bannedUntil).toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   ✅ BetwayInfo — odds/listing data
   ═══════════════════════════════════════════════════════════════════ */

// eventTypeId → BetwayInfo/Betfair sport naam (SPORT_MAP se hi milta hai,
// yahan sirf reverse-lookup ke liye rakha hai agar menu naam se sport
// bataye, ID se nahi).
const SPORT_NAME_TO_EVENT_TYPE = Object.fromEntries(
  Object.entries(SPORT_MAP).map(([id, name]) => [name.toLowerCase(), id])
);

/* ── /api1/menu — cache (baar baar poori list na maangi jaaye) ────── */
// ✅ TEST: pehle sirf ek unfiltered call hoti thi (jisme horse/greyhound
// kabhi nahi aate the). Ab agar eventTypeId diya jaye to usay query param
// ke taur par bhi bhejte hain — ho sakta hai server sirf tab racing
// include kare jab explicitly maanga jaye. Har eventTypeId (aur "sab")
// ka apna cache-slot hai taake football/cricket/tennis ka existing
// (working) unfiltered-call flow bilkul na chhide.
const _menuCache = new Map(); // key: eventTypeId || '__all__'  →  { data, expiresAt }
const MENU_CACHE_TTL_MS = parseInt(process.env.BETWAY_MENU_CACHE_TTL_MS || '5000', 10);

async function fetchMenu(eventTypeId = null) {
  const cacheKey = eventTypeId ? String(eventTypeId) : '__all__';
  const cached = _menuCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  // ✅ Client instruction: docs mein "/api/menu" likha tha, lekin
  // client ne kaha "/api/ ki jagah /api1/ use karo" — is liye:
  const url = `${BASE_URL}/api1/menu`;
  // 🧪 TEST: eventTypeId diya ho to query param mein bhi bhejo (kai
  // possible naam try karte hain — jo bhi server samjhe)
  const params = eventTypeId
    ? { eventTypeId, sportId: eventTypeId, sport: eventTypeId }
    : undefined;
  try {
    const res = await axios.get(url, { params, timeout: TIMEOUT_MS });
    const raw = res.data;
    // ⚠️ Exact shape unconfirmed — kai plausible variants try karte hain
    // (Rollwin migration mein bhi isi tarah defensive parsing kaam aayi thi)
    const items = Array.isArray(raw)               ? raw
                : Array.isArray(raw?.data)          ? raw.data
                : Array.isArray(raw?.result)        ? raw.result
                : Array.isArray(raw?.data?.result)  ? raw.data.result
                : Array.isArray(raw?.markets)       ? raw.markets
                : Array.isArray(raw?.menu)          ? raw.menu
                : [];

    // 🧪 TEST LOG: eventTypeId 7/4339 ke liye kya mila — dono cases
    // clearly dikhao (kitne items aaye, aur unme se kitne genuinely
    // horse/greyhound the vs sirf same purana unfiltered response wapas
    // aa gaya)
    if (eventTypeId === '7' || eventTypeId === '4339' || String(eventTypeId) === '7' || String(eventTypeId) === '4339') {
      const matchingCount = items.filter(it => {
        const etid = String(it.eventTypeId ?? it.eventtypeid ?? it.sportId ?? it.sport_id ?? '');
        return etid === String(eventTypeId);
      }).length;
      logger.warn(
        `[BetwayInfo][TEST] menu?eventTypeId=${eventTypeId} → ${items.length} total items, ` +
        `${matchingCount} match this eventTypeId. ` +
        `Sample eventTypeIds seen: ${JSON.stringify([...new Set(items.slice(0, 50).map(it => it.eventTypeId ?? it.eventtypeid ?? it.sportId ?? '?'))])}`
      );
    }

    if (!items.length) {
      logger.warn(`[BetwayInfo] menu(eventTypeId=${eventTypeId || 'none'}) — 0 items mile. Response top-level keys: ${JSON.stringify(Object.keys(raw || {}))}`);
    }

    _menuCache.set(cacheKey, { data: items, expiresAt: Date.now() + MENU_CACHE_TTL_MS });
    return items;
  } catch (err) {
    logger.error(`[BetwayInfo] menu (${url}, eventTypeId=${eventTypeId || 'none'}) fetch failed: ${err.message}`);
    throw err;
  }
}

// ✅ CONFIRMED /api1/menu shape (real sample):
//   { eventTypeId, eventTypeName, competitionId, competitionName,
//     eventid, eventname, openDate, marketId, status, inPlay }
function normalizeMenuItem(raw) {
  const eventTypeId = String(
    raw.eventTypeId ?? raw.eventtypeid ?? raw.sportId ?? raw.sport_id ??
    raw.eventType?.id ?? (raw.sport ? SPORT_NAME_TO_EVENT_TYPE[String(raw.sport).toLowerCase()] : '') ??
    (raw.eventTypeName ? SPORT_NAME_TO_EVENT_TYPE[String(raw.eventTypeName).toLowerCase()] : '') ?? ''
  );

  const marketId  = raw.marketId ?? raw.market_id ?? raw.matchId ?? raw.match_id ?? raw.id;
  // menu uses lowercase "eventid" / "eventname"
  const eventIdRaw = raw.eventid ?? raw.eventId ?? raw.event_id ?? raw.event?.id ?? raw.groupById ?? marketId;
  const eventId    = String(eventIdRaw);
  const eventName  = raw.eventname ?? raw.eventName ?? raw.event?.name ?? raw.name ?? raw.matchName ?? 'Unknown';

  const compId   = raw.competitionId ?? raw.competition_id ?? raw.competition?.id ?? null;
  const compName = raw.competitionName ?? raw.competition_name ?? raw.competition?.name ?? raw.league ?? null;
  const competition = compId ? { id: String(compId), name: compName || 'Unknown League' } : null;

  const startRaw = raw.marketStartTime ?? raw.startTime ?? raw.start_time ?? raw.start ?? raw.openDate ?? null;

  return {
    id: marketId != null ? String(marketId) : null,
    name: raw.marketName ?? raw.market_name ?? 'Match Odds',
    marketType: raw.marketType ?? 'MATCH_ODDS',
    start: startRaw,
    eventTypeId,
    inPlay: !!(raw.inPlay ?? raw.inplay ?? raw.in_play),
    matched: raw.totalMatched ?? raw.matched ?? 0,
    competition,
    event: {
      id: eventId,
      name: eventName,
      countryCode: raw.countryCode ?? null,
      venue: raw.venue ?? null,
      openDate: startRaw,
    },
    runners: Array.isArray(raw.runners) ? raw.runners : [], // menu runners nahi deta — /data/catalogs se milenge
  };
}

async function sportItems(eventTypeId) {
  if (!eventTypeId) {
    const menu = await fetchMenu();
    return menu.map(normalizeMenuItem).filter(m => m.id);
  }

  // 🧪 TEST (horse=7 / greyhound=4339 ke liye): pehle eventTypeId-scoped
  // call try karo (ho sakta hai server sirf tab racing include kare).
  // Agar wo khaali aaye, unfiltered list se client-side filter karke
  // bhi dekh lo — dono results server logs mein already log ho chuke
  // honge (fetchMenu() ke andar).
  let menu = await fetchMenu(eventTypeId).catch(() => []);
  let items = menu.map(normalizeMenuItem).filter(m => m.id && m.eventTypeId === String(eventTypeId));

  if (!items.length) {
    const allMenu = await fetchMenu(null).catch(() => []);
    items = allMenu.map(normalizeMenuItem).filter(m => m.id && m.eventTypeId === String(eventTypeId));
  }

  return items;
}

/* ── Public helpers (Betfair-shaped — market.controller.js ke liye) ── */

async function listEventTypes(filter = {}) {
  return Object.entries(SPORT_MAP).map(([id, name]) => ({
    eventType: { id, name },
    marketCount: 0,
  }));
}

async function listCompetitions(filter = {}) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  if (!eventTypeId) return [];
  const items = await sportItems(eventTypeId);

  const seen = new Map();
  items.forEach(m => {
    const comp = m.competition;
    if (!comp?.id) return;
    if (!seen.has(comp.id)) seen.set(comp.id, { competition: { id: comp.id, name: comp.name }, marketCount: 0 });
    seen.get(comp.id).marketCount++;
  });
  return Array.from(seen.values());
}

async function listEvents(filter = {}) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  if (!eventTypeId) return [];
  const items = await sportItems(eventTypeId);

  const competitionIds = filter?.competitionIds?.map(String) || null;
  const fromMs = filter?.marketStartTime?.from ? new Date(filter.marketStartTime.from).getTime() : null;
  const toMs   = filter?.marketStartTime?.to   ? new Date(filter.marketStartTime.to).getTime()   : null;

  const seen = new Map();
  items.forEach(m => {
    const ev = m.event;
    if (!ev?.id) return;
    if (competitionIds && !competitionIds.includes(String(m.competition?.id))) return;

    // Date string ya epoch — dono normalize karke compare karo (Rollwin
    // migration mein yehi bug mila tha, is liye shuru se hi robust rakha hai)
    const startMs = m.start != null ? new Date(m.start).getTime() : NaN;
    if (fromMs !== null && !isNaN(startMs) && startMs < fromMs) return;
    if (toMs   !== null && !isNaN(startMs) && startMs > toMs)   return;

    if (!seen.has(ev.id)) {
      seen.set(ev.id, {
        event: {
          id: ev.id,
          name: ev.name,
          countryCode: ev.countryCode || null,
          timezone: null,
          venue: ev.venue || null,
          openDate: ev.openDate || (!isNaN(startMs) ? new Date(startMs).toISOString() : new Date().toISOString()),
        },
        marketCount: 0,
      });
    }
    seen.get(ev.id).marketCount++;
  });
  return Array.from(seen.values());
}

/* ── /data/catalogs (batch) — runners aur market-metadata ─────────── */
async function fetchCatalogsBatch(marketIds) {
  if (!marketIds.length) return {};
  try {
    const url = `${BASE_URL}/data/catalogs`;
    const res = await axios.get(url, { params: { ids: marketIds.join(',') }, timeout: TIMEOUT_MS });
    const raw  = res.data;
    const list = Array.isArray(raw)              ? raw
               : Array.isArray(raw?.data)         ? raw.data
               : Array.isArray(raw?.result)       ? raw.result
               : Array.isArray(raw?.data?.result) ? raw.data.result
               : [];
    const map = {};
    list.forEach(c => {
      const mid = c.marketId ?? c.market_id ?? c.id;
      if (mid != null) map[String(mid)] = c;
    });
    return map;
  } catch (err) {
    logger.warn(`[BetwayInfo] catalogs (batch) fetch failed: ${err.message} — runners khali reh sakte hain is baar`);
    return {};
  }
}

/* ── Related markets expansion ───────────────────────────────────────
   Menu sirf primary market (Match Odds) deta hai. Baaki markets
   (Over/Under, Correct Score, Half Time, Tied Match, Bookmaker, Fancy…)
   same event ke sequential marketIds par hote hain.

   Strategy: seed Match Odds id se ± range ke candidates banao →
   /data/catalogs batch se fetch → sirf wahi rakho jinka eventId seed
   se match kare aur marketName valid ho ("Unable to load" drop).

   /data/catalog2 single-market deep metadata ke liye fallback hai.
   ─────────────────────────────────────────────────────────────────── */
const RELATED_MARKET_RANGE = parseInt(process.env.BETWAY_RELATED_MARKET_RANGE || '40', 10);
const RELATED_BATCH_SIZE   = parseInt(process.env.BETWAY_RELATED_BATCH_SIZE || '40', 10);
const _relatedCache = new Map(); // seedMarketId → { items: NormalizedItem[], expiresAt }
const RELATED_CACHE_TTL_MS = parseInt(process.env.BETWAY_RELATED_CACHE_TTL_MS || '15000', 10);

function parseMarketIdNumeric(marketId) {
  // Betfair style "1.259658661" → { prefix: "1.", num: 259658661 }
  const s = String(marketId || '');
  const m = s.match(/^(\d+\.)(\d+)$/);
  if (!m) return null;
  return { prefix: m[1], num: parseInt(m[2], 10) };
}

function catalogToMenuItem(cat, fallbackEventTypeId = '') {
  if (!cat) return null;
  const marketId = cat.marketId ?? cat.market_id ?? cat.id;
  if (marketId == null) return null;
  const name = cat.marketName ?? cat.market_name ?? '';
  if (!name || /unable to load/i.test(name)) return null;

  const eventId = String(cat.eventId ?? cat.event_id ?? cat.event?.id ?? '');
  const eventName = cat.eventName ?? cat.event_name ?? cat.event?.name ?? 'Unknown';
  const eventTypeId = String(
    cat.eventTypeId ?? cat.eventtypeid ?? cat.sport?.id ?? fallbackEventTypeId ?? ''
  );
  const compId = cat.competitionId ?? cat.competition_id ?? cat.competition?.id ?? null;
  const compName = cat.competitionName ?? cat.competition_name ?? cat.competition?.name ?? null;
  const startRaw = cat.marketStartTime ?? cat.marketStartTimeUtc ?? cat.startTime ?? null;

  return {
    id: String(marketId),
    name,
    marketType: cat.marketType ?? cat.market_type ?? null,
    start: startRaw,
    eventTypeId,
    inPlay: !!(cat.inPlay ?? cat.inplay),
    matched: cat.totalMatched ?? cat.matched ?? 0,
    competition: compId ? { id: String(compId), name: compName || 'Unknown League' } : null,
    event: {
      id: eventId,
      name: eventName,
      countryCode: cat.countryCode ?? null,
      venue: cat.venue ?? null,
      openDate: startRaw,
    },
    runners: Array.isArray(cat.runners) ? cat.runners : [],
    // raw catalog keep for listMarketCatalogue enrichment
    _catalog: cat,
  };
}

/**
 * Seed Match Odds marketId se related markets expand karo.
 * Returns array of normalize-style items (including the seed itself).
 */
async function expandRelatedMarkets(seedMarketId, seedEventId = null, seedEventTypeId = '') {
  if (!seedMarketId) return [];

  const cacheKey = String(seedMarketId);
  const cached = _relatedCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.items;

  const parsed = parseMarketIdNumeric(seedMarketId);
  if (!parsed) {
    // Non-standard id — sirf seed hi try karo via catalog2
    try {
      const url = `${BASE_URL}/data/catalog2`;
      const res = await axios.get(url, { params: { id: seedMarketId }, timeout: TIMEOUT_MS });
      const item = catalogToMenuItem(res.data, seedEventTypeId);
      const items = item ? [item] : [];
      _relatedCache.set(cacheKey, { items, expiresAt: Date.now() + RELATED_CACHE_TTL_MS });
      return items;
    } catch (err) {
      logger.warn(`[BetwayInfo] catalog2 seed=${seedMarketId} failed: ${err.message}`);
      return [];
    }
  }

  // Candidates: seed, seed+1 ... seed+(RANGE-1)
  const candidateIds = [];
  for (let i = 0; i < RELATED_MARKET_RANGE; i++) {
    candidateIds.push(`${parsed.prefix}${parsed.num + i}`);
  }

  const allCats = {};
  // Batch in chunks
  for (let i = 0; i < candidateIds.length; i += RELATED_BATCH_SIZE) {
    const chunk = candidateIds.slice(i, i + RELATED_BATCH_SIZE);
    const map = await fetchCatalogsBatch(chunk);
    Object.assign(allCats, map);
  }

  // Agar batch se kuch nahi mila, single catalog2 fallback on seed
  if (!Object.keys(allCats).length) {
    try {
      const res = await axios.get(`${BASE_URL}/data/catalog2`, {
        params: { id: seedMarketId },
        timeout: TIMEOUT_MS,
      });
      if (res.data) allCats[String(seedMarketId)] = res.data;
    } catch (err) {
      logger.warn(`[BetwayInfo] catalog2 fallback seed=${seedMarketId}: ${err.message}`);
    }
  }

  const targetEventId = seedEventId != null ? String(seedEventId) : null;
  const items = [];
  const seen = new Set();

  // Prefer order by marketId numeric
  const orderedIds = Object.keys(allCats).sort((a, b) => {
    const pa = parseMarketIdNumeric(a);
    const pb = parseMarketIdNumeric(b);
    if (pa && pb) return pa.num - pb.num;
    return a.localeCompare(b);
  });

  for (const mid of orderedIds) {
    const cat = allCats[mid];
    const item = catalogToMenuItem(cat, seedEventTypeId);
    if (!item || seen.has(item.id)) continue;
    // Same event filter (jab seed eventId pata ho)
    if (targetEventId && item.event?.id && item.event.id !== targetEventId) continue;
    // Agar eventId missing on seed, seed ke eventId se lock kar lo pehle valid item se
    seen.add(item.id);
    items.push(item);
  }

  // Ensure seed itself is present even if catalogs skipped it
  if (!seen.has(String(seedMarketId)) && allCats[String(seedMarketId)]) {
    const item = catalogToMenuItem(allCats[String(seedMarketId)], seedEventTypeId);
    if (item) items.unshift(item);
  }

  _relatedCache.set(cacheKey, { items, expiresAt: Date.now() + RELATED_CACHE_TTL_MS });
  logger.info(
    `[BetwayInfo] expandRelated seed=${seedMarketId} → ${items.length} markets` +
    (items.length ? ` (${items.map(i => i.name).slice(0, 8).join(', ')}${items.length > 8 ? '…' : ''})` : '')
  );
  return items;
}

/**
 * Kai seed (Match Odds) markets ke liye related expand + dedupe.
 */
async function expandAllRelated(seedItems) {
  if (!seedItems.length) return [];
  const results = await Promise.all(
    seedItems.map(s =>
      expandRelatedMarkets(s.id, s.event?.id, s.eventTypeId).catch(err => {
        logger.warn(`[BetwayInfo] expand failed for ${s.id}: ${err.message}`);
        return [s]; // fallback: kam az kam seed hi
      })
    )
  );
  const byId = new Map();
  results.flat().forEach(m => {
    if (m?.id && !byId.has(m.id)) byId.set(m.id, m);
  });
  return Array.from(byId.values());
}

// Betfair jaisa shape: [{ marketId, marketName, marketStartTime, totalMatched,
//                          competition, event, eventType, runners:[{selectionId, runnerName, sortPriority}] }]
//
// ✅ Match Odds ke alawa related markets bhi: menu sirf primary (Match Odds)
// deta hai. expandRelatedMarkets() seed id se sequential /data/catalogs
// (aur zarurat par /data/catalog2) se Over/Under, Correct Score, Half Time,
// Tied Match, Fancy, Bookmaker wagaira nikaalta hai.
async function listMarketCatalogue(filter = {}, maxResults = '20', marketProjection) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  let seedItems = [];

  if (eventTypeId) {
    seedItems = await sportItems(eventTypeId);
  } else if (filter?.marketIds?.length || filter?.eventIds?.length) {
    // Sport pata nahi — poori menu list mein se dhoondo
    const all = await sportItems(null);
    if (filter?.marketIds?.length) {
      const ids = filter.marketIds.map(String);
      seedItems = all.filter(m => ids.includes(m.id));
    } else if (filter?.eventIds?.length) {
      const ids = filter.eventIds.map(String);
      seedItems = all.filter(m => ids.includes(m.event?.id));
    }
  }

  if (filter?.eventIds?.length) {
    const ids = filter.eventIds.map(String);
    seedItems = seedItems.filter(m => ids.includes(m.event?.id));
  }

  // marketIds filter: agar user specific market maang raha hai to seed
  // ke taur par unhe use karo (expand unke event ke related bhi de sakta hai
  // jab eventIds na hon — lekin strict marketIds hone par sirf wahi return).
  const strictMarketIds = filter?.marketIds?.length ? filter.marketIds.map(String) : null;

  if (strictMarketIds && !filter?.eventIds?.length && !eventTypeId) {
    // Direct market id lookup — menu mein na mile to catalog2/catalogs se lao
    const fromMenu = seedItems.filter(m => strictMarketIds.includes(m.id));
    const missing = strictMarketIds.filter(id => !fromMenu.some(m => m.id === id));
    if (missing.length) {
      const map = await fetchCatalogsBatch(missing);
      for (const id of missing) {
        const cat = map[id];
        if (cat) {
          const item = catalogToMenuItem(cat);
          if (item) fromMenu.push(item);
        } else {
          // single catalog2 fallback
          try {
            const res = await axios.get(`${BASE_URL}/data/catalog2`, {
              params: { id },
              timeout: TIMEOUT_MS,
            });
            const item = catalogToMenuItem(res.data);
            if (item) fromMenu.push(item);
          } catch (_) { /* ignore */ }
        }
      }
    }
    seedItems = fromMenu;
  }

  // ✅ Related markets expand (Match Odds → saari sibling markets)
  // Agar strict marketIds + koi event/sport filter nahi, to expand mat karo
  // (user ne exact ids maangi hain). Warna event/sport listing mein saari markets lao.
  let items;
  if (strictMarketIds && !filter?.eventIds?.length && !eventTypeId) {
    items = seedItems;
  } else {
    // Unique seeds by event (ek event ka ek Match Odds seed kaafi)
    const seedByEvent = new Map();
    seedItems.forEach(s => {
      const eid = s.event?.id || s.id;
      if (!seedByEvent.has(eid)) seedByEvent.set(eid, s);
    });
    items = await expandAllRelated(Array.from(seedByEvent.values()));
  }

  if (strictMarketIds) {
    items = items.filter(m => strictMarketIds.includes(m.id));
  }
  if (filter?.eventIds?.length) {
    const ids = filter.eventIds.map(String);
    items = items.filter(m => ids.includes(m.event?.id));
  }

  const sliced = items.slice(0, parseInt(maxResults, 10) || 20);
  if (!sliced.length) return [];

  // Catalogs batch — jo expand se _catalog nahi aaya unke liye
  const needFetch = sliced.filter(m => !m._catalog).map(m => m.id);
  const catalogMap = needFetch.length ? await fetchCatalogsBatch(needFetch) : {};

  return sliced.map(m => {
    const cat = m._catalog || catalogMap[m.id] || {};
    const runners = Array.isArray(cat.runners) ? cat.runners : m.runners;
    const startMs = m.start != null ? new Date(m.start).getTime() : NaN;
    const eid = String(m.eventTypeId || eventTypeId || cat.eventTypeId || '');

    return {
      marketId: m.id,
      marketName: cat.marketName || cat.market_name || m.name,
      marketType: cat.marketType || m.marketType || null,
      marketStartTime: !isNaN(startMs) ? new Date(startMs).toISOString() : (m.event?.openDate || new Date().toISOString()),
      totalMatched: m.matched || cat.totalMatched || 0,
      competition: m.competition ? { id: m.competition.id, name: m.competition.name } : (
        cat.competitionId ? { id: String(cat.competitionId), name: cat.competitionName || 'Unknown League' } : null
      ),
      event: m.event ? {
        id: m.event.id, name: m.event.name,
        countryCode: m.event.countryCode || cat.countryCode || null,
        openDate: m.event.openDate || (!isNaN(startMs) ? new Date(startMs).toISOString() : null),
      } : null,
      eventType: { id: eid, name: SPORT_MAP[eid] || cat.eventType || cat.sport?.name || 'Other' },
      runners: (runners || []).map(r => {
        let meta = r.metadata;
        if (typeof meta === 'string') {
          try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
        }
        meta = meta && typeof meta === 'object' ? meta : {};
        return {
          // ✅ Number() se normalize — Data endpoint (/data/Data) ka runner.id
          // bhi selectionId hi hota hai, aur dono jagah consistent type
          // (number) rakhna zaroori hai warna frontend price ko sahi runner
          // se match hi nahi kar pata (string "47998" !== number 47998)
          selectionId: Number(r.selectionId ?? r.id),
          runnerName:  r.runnerName ?? r.name,
          sortPriority: r.sortPriority ?? r.sort ?? 0,
          handicap: r.handicap ?? r.hdp ?? 0,
          metadata: {
            ...meta,
            CLOTH_NUMBER: meta.CLOTH_NUMBER ?? r.clothNumber ?? r.cloth ?? null,
            JOCKEY_NAME:  meta.JOCKEY_NAME  ?? r.jockey ?? r.jockeyName ?? r.jockeyName ?? null,
            TRAINER_NAME: meta.TRAINER_NAME ?? r.trainer ?? r.trainerName ?? null,
            STALL_DRAW:   meta.STALL_DRAW   ?? r.stallDraw ?? r.stall ?? null,
            COLOURS_FILENAME_URL: meta.COLOURS_FILENAME_URL ?? r.silk ?? r.silkUrl ?? r.silkColor ?? null,
            FORM: meta.FORM ?? r.form ?? r.lastRun ?? null,
            AGE:  meta.AGE  ?? r.age  ?? null,
          },
        };
      }),
    };
  });
}

// Betfair jaisa shape: [{ marketId, status, inplay, betDelay, totalMatched,
//                          runners: [{selectionId, status, lastPriceTraded,
//                                     ex: { availableToBack, availableToLay } }],
//                          scoreboard? }]  ← scoreboard sirf cricket ke liye
//
// ✅ CONFIRMED (real in-play match se, marketId=1.259466913):
//   marketBooks[0] = { id, winners, betDelay, totalMatched, marketStatus,
//                       maxBetSize, bettingAllowed, isMarketDataDelayed,
//                       runners:[{ id, price1..3, size1..3, lay1..3, ls1..3,
//                                  status, handicap }], isRoot, timestamp, winnerIDs }
//   → status field ka asal naam "marketStatus" hai (generic "status" nahi)
//   → lay SIZE field "ls1/ls2/ls3" hai (pehle "laySize"/"lsize" try ho raha
//     tha, jo kabhi match nahi hota tha — isi wajah se LAY size hamesha 0
//     aata tha, aur frontend size=0 wale cells ko non-clickable/blank
//     dikhata hai)
async function listMarketBook(marketIds = [], priceProjection) {
  if (!marketIds.length) return [];

  const results = await Promise.all(marketIds.map(async (id) => {
    try {
      const url = `${BASE_URL}/data/Data`;
      const res = await axios.get(url, { params: { id }, timeout: TIMEOUT_MS });
      const raw = res.data;

      // marketBooks empty ho sakta hai agar market abhi actively traded
      // nahi ho raha (docs + humara apna test confirm karta hai)
      const mbRaw = raw?.marketBooks;
      const mb = Array.isArray(mbRaw) ? mbRaw[0] : mbRaw;

      if (!mb) {
        return { marketId: id, status: 'OPEN', inplay: false, betDelay: 0, totalMatched: 0, runners: [] };
      }

      const runners = mb.runners || mb.runner || [];

      return {
        marketId: id,
        // ✅ FIX: real field "marketStatus" hai, "status" nahi
        status: mb.marketStatus || mb.status || 'OPEN',
        inplay: !!(mb.inplay ?? mb.inPlay),
        betDelay: mb.betDelay ?? 0,
        totalMatched: mb.totalMatched ?? mb.matched ?? 0,
        runners: runners.map(r => {
          const back = [];
          const lay  = [];
          for (let i = 1; i <= 3; i++) {
            if (r[`price${i}`] != null) back.push({ price: r[`price${i}`], size: r[`size${i}`] ?? 0 });
            // ✅ FIX: lay size ka real field "ls1/ls2/ls3" hai
            if (r[`lay${i}`]   != null) lay.push({ price: r[`lay${i}`], size: r[`ls${i}`] ?? r[`laySize${i}`] ?? r[`lsize${i}`] ?? 0 });
          }
          // Fallback: agar price1/lay1 style fields bilkul na milen, shayad
          // Betfair-native "back"/"lay" array format bhi ho sakta hai
          const backFallback = Array.isArray(r.back) ? r.back.map(b => ({ price: b.price, size: b.size })) : [];
          const layFallback  = Array.isArray(r.lay)  ? r.lay.map(l  => ({ price: l.price, size: l.size }))  : [];

          return {
            // ✅ FIX: catalog2 ke selectionId se type-consistent rakhne ke
            // liye Number() — warna frontend price ko runner se match hi
            // nahi kar pata (string vs number mismatch se dono BACK aur
            // LAY khaali/blank dikhte hain)
            selectionId: Number(r.selectionId ?? r.id),
            status: r.status || 'ACTIVE',
            lastPriceTraded: r.lastPriceTraded ?? r.ltp ?? null,
            ex: {
              availableToBack: back.length ? back : backFallback,
              availableToLay:  lay.length  ? lay  : layFallback,
            },
          };
        }),
        // ✅ Cricket scoreboard pass-through (t1_runs/t1_wickets/t1_overs/
        // commentry) — controller ya frontend jahan zaroorat ho use kar sake
        scoreboard: raw.scoreboard || null,
      };
    } catch (err) {
      logger.error(`[BetwayInfo] Data?id=${id} failed: ${err.message}`);
      return { marketId: id, status: 'OPEN', inplay: false, betDelay: 0, totalMatched: 0, runners: [] };
    }
  }));

  return results;
}

/* ── getEventDetails (orders.js compatible) ─────────────── */
async function getEventDetails(marketId) {
  try {
    const catalogue = await listMarketCatalogue({ marketIds: [marketId] }, '1', ['EVENT', 'EVENT_TYPE']);
    const market = catalogue?.[0];
    if (!market?.event) return { eventName: 'Unknown Event', category: 'Other' };
    return { eventName: market.event.name, category: market.eventType?.name || 'Other' };
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
  getBanStatus,
};
