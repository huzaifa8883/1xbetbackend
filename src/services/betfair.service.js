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

   ⚠️ UNCONFIRMED HISSE (real sample se verify nahi hue abhi tak):
   1) /api1/menu ka EXACT response shape — sirf itna pata hai ke isse
      "eventName → matchId" milta hai (docs se). eventTypeId/competition/
      startTime jaise fields kis naam se aate hain, confirm nahi —
      is liye normalizeMenuItem() mein kai plausible field-name variants
      try kiye hain (defensive parsing), taake jo bhi shape ho crash na ho.
   2) /data/Data ka marketBooks[].runners[] structure — docs sirf itna
      batate hain ke "price1/size1/lay1" jaisi fields hoti hain, lekin
      humara test empty market (Tournament Winner, not actively traded)
      pe khaali aaya tha ("marketBooks": []) — isliye price1/price2/
      price3 (3-level back) aur lay1/lay2/lay3 (3-level lay) ka structure
      BEST-GUESS hai, ek active/in-play match ke real response se abhi
      tak verify nahi hua.

   ➡️ AGLA STEP: ek in-play match dhoond kar
      curl "https://betwayinfo.com/data/Data?id=<marketId>" ka poora
      (untruncated) response bhejna — us se ye dono cheezein pin-point
      confirm/fix ho jayengi.
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
const _menuCache = { data: null, expiresAt: 0 };
const MENU_CACHE_TTL_MS = parseInt(process.env.BETWAY_MENU_CACHE_TTL_MS || '5000', 10);

async function fetchMenu() {
  if (_menuCache.data && Date.now() < _menuCache.expiresAt) return _menuCache.data;

  // ✅ Client instruction: docs mein "/api/menu" likha tha, lekin
  // client ne kaha "/api/ ki jagah /api1/ use karo" — is liye:
  const url = `${BASE_URL}/api1/menu`;
  try {
    const res = await axios.get(url, { timeout: TIMEOUT_MS });
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

    if (!items.length) {
      logger.warn(`[BetwayInfo] menu — 0 items mile. Response top-level keys: ${JSON.stringify(Object.keys(raw || {}))}`);
    }

    _menuCache.data = items;
    _menuCache.expiresAt = Date.now() + MENU_CACHE_TTL_MS;
    return items;
  } catch (err) {
    logger.error(`[BetwayInfo] menu (${url}) fetch failed: ${err.message}`);
    throw err;
  }
}

// ⚠️ UNCONFIRMED field-names — real /api1/menu sample milte hi verify/fix karo.
function normalizeMenuItem(raw) {
  const eventTypeId = String(
    raw.eventTypeId ?? raw.eventtypeid ?? raw.sportId ?? raw.sport_id ??
    raw.eventType?.id ?? (raw.sport ? SPORT_NAME_TO_EVENT_TYPE[String(raw.sport).toLowerCase()] : '') ?? ''
  );

  const marketId  = raw.marketId ?? raw.market_id ?? raw.matchId ?? raw.match_id ?? raw.id;
  const eventIdRaw = raw.eventId ?? raw.event_id ?? raw.event?.id ?? raw.groupById ?? marketId;
  const eventId    = String(eventIdRaw);
  const eventName  = raw.eventname ?? raw.eventName ?? raw.event?.name ?? raw.name ?? raw.matchName ?? 'Unknown';

  const compId   = raw.competitionId ?? raw.competition_id ?? raw.competition?.id ?? null;
  const compName = raw.competitionName ?? raw.competition_name ?? raw.competition?.name ?? raw.league ?? null;
  const competition = compId ? { id: String(compId), name: compName || 'Unknown League' } : null;

  const startRaw = raw.marketStartTime ?? raw.startTime ?? raw.start_time ?? raw.start ?? raw.openDate ?? null;

  return {
    id: marketId != null ? String(marketId) : null,
    name: raw.marketName ?? raw.market_name ?? 'Match Odds',
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
    runners: Array.isArray(raw.runners) ? raw.runners : [], // menu shayad runners na de — /data/catalogs se milenge
  };
}

async function sportItems(eventTypeId) {
  const menu = await fetchMenu();
  const items = menu.map(normalizeMenuItem).filter(m => m.id);
  return eventTypeId ? items.filter(m => m.eventTypeId === String(eventTypeId)) : items;
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

// Betfair jaisa shape: [{ marketId, marketName, marketStartTime, totalMatched,
//                          competition, event, eventType, runners:[{selectionId, runnerName, sortPriority}] }]
async function listMarketCatalogue(filter = {}, maxResults = '20', marketProjection) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  let items = [];

  if (eventTypeId) {
    items = await sportItems(eventTypeId);
  } else if (filter?.marketIds?.length || filter?.eventIds?.length) {
    // Sport pata nahi — poori menu list mein se dhoondo
    const all = await sportItems(null);
    if (filter?.marketIds?.length) {
      const ids = filter.marketIds.map(String);
      items = all.filter(m => ids.includes(m.id));
    } else if (filter?.eventIds?.length) {
      const ids = filter.eventIds.map(String);
      items = all.filter(m => ids.includes(m.event?.id));
    }
  }

  if (filter?.eventIds?.length) {
    const ids = filter.eventIds.map(String);
    items = items.filter(m => ids.includes(m.event?.id));
  }
  if (filter?.marketIds?.length) {
    const ids = filter.marketIds.map(String);
    items = items.filter(m => ids.includes(m.id));
  }

  const sliced = items.slice(0, parseInt(maxResults, 10) || 20);
  if (!sliced.length) return [];

  // ✅ /data/catalog2 (single) ki jagah /data/catalogs (batch) use karo —
  // ek hi HTTP call mein saare markets ki details mil jaati hain (docs
  // mein explicitly "optimized endpoint for fetching metadata for
  // multiple related markets" likha hai).
  const catalogMap = await fetchCatalogsBatch(sliced.map(m => m.id));

  return sliced.map(m => {
    const cat = catalogMap[m.id] || {};
    const runners = Array.isArray(cat.runners) ? cat.runners : m.runners;
    const startMs = m.start != null ? new Date(m.start).getTime() : NaN;
    const eid = String(m.eventTypeId || eventTypeId || '');

    return {
      marketId: m.id,
      marketName: cat.marketName || cat.market_name || m.name,
      marketStartTime: !isNaN(startMs) ? new Date(startMs).toISOString() : (m.event?.openDate || new Date().toISOString()),
      totalMatched: m.matched || 0,
      competition: m.competition ? { id: m.competition.id, name: m.competition.name } : null,
      event: m.event ? {
        id: m.event.id, name: m.event.name,
        countryCode: m.event.countryCode || null,
        openDate: m.event.openDate || (!isNaN(startMs) ? new Date(startMs).toISOString() : null),
      } : null,
      eventType: { id: eid, name: SPORT_MAP[eid] || 'Other' },
      runners: (runners || []).map(r => ({
        selectionId: r.selectionId ?? r.id,
        runnerName:  r.runnerName ?? r.name,
        sortPriority: r.sortPriority ?? r.sort ?? 0,
        handicap: r.handicap ?? r.hdp ?? 0,
        metadata: {
          ...r.metadata,
          CLOTH_NUMBER: r.metadata?.CLOTH_NUMBER ?? r.clothNumber ?? r.cloth ?? null,
          JOCKEY_NAME:  r.metadata?.JOCKEY_NAME  ?? r.jockey ?? r.jockeyName ?? null,
          TRAINER_NAME: r.metadata?.TRAINER_NAME ?? r.trainer ?? r.trainerName ?? null,
          STALL_DRAW:   r.metadata?.STALL_DRAW   ?? r.stallDraw ?? r.stall ?? null,
          COLOURS_FILENAME_URL: r.metadata?.COLOURS_FILENAME_URL ?? r.silk ?? r.silkUrl ?? null,
          FORM: r.metadata?.FORM ?? r.form ?? null,
          AGE:  r.metadata?.AGE  ?? r.age  ?? null,
        },
      })),
    };
  });
}

// Betfair jaisa shape: [{ marketId, status, inplay, betDelay, totalMatched,
//                          runners: [{selectionId, status, lastPriceTraded,
//                                     ex: { availableToBack, availableToLay } }],
//                          scoreboard? }]  ← scoreboard sirf cricket ke liye
//
// ⚠️ /data/Data ka price1/size1/lay1... structure abhi tak REAL in-play
// sample se confirm nahi hua (dekho file ke top wala notice) — best-guess
// hai. 3 levels try karte hain (price1..3 / lay1..3), jitne bhi mile
// utne le lete hain, extra ko chup-chaap ignore karte hain.
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
        status: mb.status || 'OPEN',
        inplay: !!(mb.inplay ?? mb.inPlay),
        betDelay: mb.betDelay ?? 0,
        totalMatched: mb.totalMatched ?? mb.matched ?? 0,
        runners: runners.map(r => {
          const back = [];
          const lay  = [];
          for (let i = 1; i <= 3; i++) {
            if (r[`price${i}`] != null) back.push({ price: r[`price${i}`], size: r[`size${i}`] ?? 0 });
            if (r[`lay${i}`]   != null) lay.push({ price: r[`lay${i}`], size: r[`laySize${i}`] ?? r[`lsize${i}`] ?? 0 });
          }
          // Fallback: agar price1/lay1 style fields bilkul na milen, shayad
          // Betfair-native "back"/"lay" array format bhi ho sakta hai
          const backFallback = Array.isArray(r.back) ? r.back.map(b => ({ price: b.price, size: b.size })) : [];
          const layFallback  = Array.isArray(r.lay)  ? r.lay.map(l  => ({ price: l.price, size: l.size }))  : [];

          return {
            selectionId: r.selectionId ?? r.id,
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
