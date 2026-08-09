'use strict';

/* ═══════════════════════════════════════════════════════════════════
   ⚠️ MIGRATION NOTICE (please read before relying on this file)
   ═══════════════════════════════════════════════════════════════════
   Ye file pehle SEEDHA Betfair API call karti thi. Ab market/odds LIST
   Shubdx/Rollwin (rollwinpk.org) se aata hai — file ka NAAM same rakha
   hai (betfair.service.js) taake market.controller.js aur baaki
   consumers mein import paths na badalne padein.

   FUNCTION NAMES aur RETURN SHAPES Betfair jaisi hi rakhi hain (event,
   competition, runners[].back/lay waghera) — taake existing controller
   code zyada tabdeeli ke bagair chal jaye.

   ✅ IMPORTANT DISCOVERY: Rollwin/Shubdx ek AGGREGATOR hai — har market
   ke response mein "op" field batata hai asal source kya hai:
     - op === "Betfair"  → market ID ASAL Betfair market ID hai
                            (e.g. "1.260868269") — Betfair ISE PEHCHANTA
                            HAI. Is liye settlement (listMarketProfitAndLoss)
                            REAL Betfair API se hi ho sakti hai, jaisa
                            pehle hota tha — code neeche waisa hi rakha hai.
     - op === "Shubdx"   → market ID Shubdx ka apna synthetic ID hai
                            (e.g. "1.72221158.3d57ee9d30") — Betfair ko
                            ye pata hi nahi. Aise markets ke liye settlement
                            abhi possible NAHI hai jab tak Shubdx khud
                            result/winner data na de (unconfirmed).

   Practical asar: op:"Betfair" wale matches (jo majority lagte hain)
   NORMAL settle hote rahenge. op:"Shubdx" wale matches settle nahi
   honge jab tak alag se result-source confirm na ho — aise stuck
   markets humara pehle se bana hua "STUCK MARKET" warning system
   (autoSettle_service.js) khud pakad lega, chup-chaap nahi rahega.
   ═══════════════════════════════════════════════════════════════════ */

const axios  = require('axios');
const logger = require('../utils/logger');
const { SPORT_MAP } = require('../config/constants');

const BASE_URL = process.env.SHUBDX_BASE_URL || 'https://rollwinpk.org/sports';
const TIMEOUT_MS = 15000;

/* ── ✅ Real Betfair session/login — SETTLEMENT ke liye zinda rakha hai
   (listMarketProfitAndLoss), kyunki op:"Betfair" wale markets ka ID
   asal Betfair ko pata hota hai. Odds/listing ke liye ab iski zaroorat
   nahi (wo Rollwin se aata hai), lekin settlement isi pe depend karta
   hai — is liye original code bilkul waisa hi rakha hai. ──────────── */
const BF_APP_KEY  = process.env.BETFAIR_APP_KEY;
const BF_USERNAME = process.env.BETFAIR_USERNAME;
const BF_PASSWORD = process.env.BETFAIR_PASSWORD;
const BF_LOGIN_URL = process.env.BETFAIR_LOGIN_URL || 'https://identitysso.betfair.com/api/login';
const BF_API_URL   = process.env.BETFAIR_API_URL   || 'https://api.betfair.com/exchange/betting/json-rpc/v1';
const BF_TTL_MS     = parseInt(process.env.BETFAIR_SESSION_TTL_MINUTES || '25', 10) * 60 * 1000;

let _bfCachedToken = null;
let _bfTokenExpiry = null;
let _bfLoginPromise = null;

async function getBetfairSessionToken() {
  if (_bfCachedToken && _bfTokenExpiry && Date.now() < _bfTokenExpiry) return _bfCachedToken;
  if (_bfLoginPromise) return _bfLoginPromise;

  _bfLoginPromise = (async () => {
    try {
      logger.info('Betfair: Requesting new session token...');
      const res = await axios.post(
        BF_LOGIN_URL,
        new URLSearchParams({ username: BF_USERNAME, password: BF_PASSWORD }),
        { headers: { 'X-Application': BF_APP_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      if (res.data.status !== 'SUCCESS') {
        _bfCachedToken = null; _bfTokenExpiry = null;
        throw new Error(`Betfair login failed: ${res.data.error || 'UNKNOWN_ERROR'}`);
      }
      _bfCachedToken = res.data.token;
      _bfTokenExpiry = Date.now() + BF_TTL_MS;
      logger.info('Betfair: New session token successfully generated');
      return _bfCachedToken;
    } catch (err) {
      _bfCachedToken = null; _bfTokenExpiry = null;
      throw err;
    } finally {
      _bfLoginPromise = null;
    }
  })();
  return _bfLoginPromise;
}

async function bfJsonRpc(method, params, isRetry = false) {
  try {
    const token = await getBetfairSessionToken();
    const body  = [{ jsonrpc: '2.0', method, params, id: 1 }];
    const resp  = await axios.post(BF_API_URL, body, {
      headers: { 'X-Application': BF_APP_KEY, 'X-Authentication': token, 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    const result = resp.data[0]?.result;
    const error  = resp.data[0]?.error;

    if (error && (error.code === -32099 || error.data?.APINGException?.errorCode === 'INVALID_SESSION_INFORMATION')) {
      logger.warn('Betfair: Session invalidated on RPC call, clearing cached token');
      _bfCachedToken = null; _bfTokenExpiry = null;
      if (!isRetry) return bfJsonRpc(method, params, true);
    }
    if (!result) throw new Error(`No result from Betfair: ${method} - error: ${JSON.stringify(error)}`);
    return result;
  } catch (err) {
    if (err.message.includes('INVALID_SESSION') || err.message.includes('login failed')) {
      _bfCachedToken = null; _bfTokenExpiry = null;
    }
    throw err;
  }
}

// Betfair eventTypeId → Shubdx/Rollwin URL sport-segment mapping.
// SPORT_MAP (config/constants) se hi eventTypeId → naam milta hai,
// yahan sirf naam ko API ke URL-friendly slug mein convert kar rahe hain.
const EVENT_TYPE_TO_SPORT_SLUG = {
  '1':    'football',
  '2':    'tennis',
  '4':    'cricket',
  '7':    'horse',
  '4339': 'greyhound',
};

/* ── Short-TTL cache: ek hi sport ke liye baar baar "allmatches" na
   maara jaaye jab multiple functions (events/competitions/catalogue)
   thodi thodi der mein call ho rahe hon. ────────────────────────── */
const _cache = new Map(); // sportSlug → { data, expiresAt }
const CACHE_TTL_MS = parseInt(process.env.SHUBDX_CACHE_TTL_MS || '4000', 10);

async function fetchAllMatches(sportSlug) {
  const cached = _cache.get(sportSlug);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const url = `${BASE_URL}/${sportSlug}/allmatches`;
  try {
    const res = await axios.get(url, { timeout: TIMEOUT_MS });
    const raw = res.data;
    // ✅ Confirmed shapes (asal server response se):
    //   allmatches:  { status:"success", data: { status:{...}, success:true, result:[...] } }
    //   fetchmatch:  { status:{...}, success:true, result:[...] }
    const markets = Array.isArray(raw?.data?.result) ? raw.data.result   // allmatches shape
                  : Array.isArray(raw?.result)       ? raw.result        // fetchmatch shape
                  : Array.isArray(raw)                ? raw
                  : Array.isArray(raw?.data)          ? raw.data
                  : [];

    if (!markets.length) {
      logger.warn(`[Shubdx] allmatches(${sportSlug}) — 0 markets mile. Response shape: ${JSON.stringify(Object.keys(raw || {}))}`);
    }

    _cache.set(sportSlug, { data: markets, expiresAt: Date.now() + CACHE_TTL_MS });
    return markets;
  } catch (err) {
    logger.error(`[Shubdx] fetchAllMatches(${sportSlug}) failed: ${err.message}`);
    throw err;
  }
}

async function fetchOneMatch(sportSlug, matchOrEventId) {
  const url = `${BASE_URL}/${sportSlug}/fetchmatch`;
  try {
    const res = await axios.get(url, { params: { match: matchOrEventId }, timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    logger.error(`[Shubdx] fetchOneMatch(${sportSlug}, ${matchOrEventId}) failed: ${err.message}`);
    throw err;
  }
}

function sportSlugFromEventTypeId(eventTypeId) {
  const slug = EVENT_TYPE_TO_SPORT_SLUG[String(eventTypeId)];
  if (!slug) throw new Error(`Unknown eventTypeId for Shubdx mapping: ${eventTypeId}`);
  return slug;
}

/* ── Public helpers (Betfair-shaped) ─────────────────────────────── */

// Betfair jaisa shape: [{ eventType: { id, name }, marketCount }]
// Shubdx ke paas "list all sports" wala endpoint nahi hai — SPORT_MAP
// (config/constants, jo already existing hai) se hi static list deta hai.
async function listEventTypes(filter = {}) {
  return Object.entries(SPORT_MAP).map(([id, name]) => ({
    eventType: { id, name },
    marketCount: 0, // Shubdx count nahi deta upfront — UI isko normally ignore karta hai
  }));
}

// Betfair jaisa shape: [{ competition: {id, name}, marketCount }]
async function listCompetitions(filter = {}) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  if (!eventTypeId) return [];
  const sportSlug = sportSlugFromEventTypeId(eventTypeId);
  const markets = await fetchAllMatches(sportSlug);

  const seen = new Map(); // competitionId → { competition, count }
  markets.forEach(m => {
    const comp = m.competition;
    if (!comp?.id) return;
    if (!seen.has(comp.id)) seen.set(comp.id, { competition: { id: comp.id, name: comp.name }, marketCount: 0 });
    seen.get(comp.id).marketCount++;
  });
  return Array.from(seen.values());
}

// Betfair jaisa shape: [{ event: {id,name,countryCode,timezone,venue,openDate}, marketCount }]
async function listEvents(filter = {}) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  if (!eventTypeId) return [];
  const sportSlug = sportSlugFromEventTypeId(eventTypeId);
  const markets = await fetchAllMatches(sportSlug);

  const competitionIds = filter?.competitionIds?.map(String) || null;
  const fromMs = filter?.marketStartTime?.from ? new Date(filter.marketStartTime.from).getTime() : null;
  const toMs   = filter?.marketStartTime?.to   ? new Date(filter.marketStartTime.to).getTime()   : null;

  const seen = new Map(); // eventId → { event, marketCount }
  markets.forEach(m => {
    const ev = m.event;
    if (!ev?.id) return;
    if (competitionIds && !competitionIds.includes(String(m.competition?.id))) return;

    // ✅ FIX: m.start Shubdx response mein number (epoch ms) ya string
    // (ISO date) — dono ho sakta hai. Pehle seedha numeric comparison
    // (m.start < fromMs) hoti thi jo agar m.start string ho to hamesha
    // fail hoti (NaN comparison) — is se date-range filter silently
    // kaam nahi karta tha, ya to sab match gayab ho jaate ya sab reh jaate.
    // Ab hamesha Date object se normalize karke compare karte hain.
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

// Betfair jaisa shape: [{ marketId, marketName, marketStartTime, totalMatched,
//                          competition, event, eventType, runners:[{selectionId, runnerName, sortPriority}] }]
async function listMarketCatalogue(filter = {}, maxResults = '20', marketProjection = ['EVENT', 'RUNNER_METADATA']) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  let markets = [];

  if (eventTypeId) {
    const sportSlug = sportSlugFromEventTypeId(eventTypeId);
    markets = await fetchAllMatches(sportSlug);
  } else if (filter?.marketIds?.length) {
    // Sport pata nahi — saare sports try karo jab tak market ID na mile
    // (getEventDetails/getRunnerBook jaise callers sirf marketId dete hain)
    for (const slug of Object.values(EVENT_TYPE_TO_SPORT_SLUG)) {
      const list = await fetchAllMatches(slug).catch(() => []);
      const hit = list.filter(m => filter.marketIds.includes(m.id));
      if (hit.length) { markets = hit; break; }
    }
  }

  if (filter?.eventIds?.length) {
    markets = markets.filter(m => filter.eventIds.includes(m.event?.id));
  }
  if (filter?.marketIds?.length) {
    markets = markets.filter(m => filter.marketIds.includes(m.id));
  }

  return markets.slice(0, parseInt(maxResults, 10) || 20).map(m => {
    const startMs = m.start != null ? new Date(m.start).getTime() : NaN;
    return {
      marketId: m.id,
      marketName: m.name,
      marketStartTime: !isNaN(startMs) ? new Date(startMs).toISOString() : (m.event?.openDate || new Date().toISOString()),
      totalMatched: m.matched || 0,
      competition: m.competition ? { id: m.competition.id, name: m.competition.name } : null,
      event: m.event ? {
        id: m.event.id, name: m.event.name,
        countryCode: m.event.countryCode || null,
        openDate: m.event.openDate || (!isNaN(startMs) ? new Date(startMs).toISOString() : null),
      } : null,
      eventType: { id: String(m.eventTypeId), name: SPORT_MAP[String(m.eventTypeId)] || 'Other' },
      runners: (m.runners || []).map(r => ({
        selectionId: r.id,
        runnerName: r.name,
        sortPriority: r.sort || 0,
        handicap: r.hdp || 0,
        // ✅ Raw runner object pass-through as metadata — Shubdx horse/
        // greyhound runners mein jockey/trainer/silk/cloth-number jaisi
        // details ho sakti hain kisi bhi naming convention mein. Purana
        // Betfair-based buildOddsPayload() pehle se hi kai naming variants
        // check karta hai (CLOTH_NUMBER/cloth_number/ClothNumber, etc.) —
        // poora raw object bhej dene se agar Shubdx ka field naam match
        // kare to wo turant dikhna shuru ho jayega, warna gracefully null
        // rahega (koi crash nahi). metadataDict se raw fields dikh bhi
        // jayenge debugging ke liye.
        metadata: {
          ...r,
          CLOTH_NUMBER: r.clothNumber ?? r.cloth ?? r.CLOTH_NUMBER ?? null,
          JOCKEY_NAME:  r.jockey      ?? r.jockeyName ?? r.JOCKEY_NAME ?? null,
          TRAINER_NAME: r.trainer     ?? r.trainerName ?? r.TRAINER_NAME ?? null,
          STALL_DRAW:   r.stallDraw   ?? r.stall ?? r.STALL_DRAW ?? null,
          COLOURS_FILENAME_URL: r.silk ?? r.silkUrl ?? r.COLOURS_FILENAME_URL ?? null,
          FORM:         r.form  ?? r.FORM ?? null,
          AGE:          r.age   ?? r.AGE  ?? null,
        },
      })),
    };
  });
}

// Betfair jaisa shape: [{ marketId, status, inplay, betDelay,
//                          runners: [{selectionId, status, lastPriceTraded,
//                                     ex: { availableToBack, availableToLay } }] }]
async function listMarketBook(marketIds = [], priceProjection) {
  if (!marketIds.length) return [];

  // marketIds mein se sport pata nahi hota (koi eventTypeId prefix nahi) —
  // saare sports mein dhoondo (cache ki wajah se ye sasta hai, 4s tak reuse hoti hai)
  const results = [];
  for (const slug of Object.values(EVENT_TYPE_TO_SPORT_SLUG)) {
    const list = await fetchAllMatches(slug).catch(() => []);
    list.forEach(m => {
      if (!marketIds.includes(m.id)) return;
      results.push({
        marketId: m.id,
        status: m.status || 'OPEN',
        inplay: !!m.inPlay,
        betDelay: m.betDelay || 0,
        totalMatched: m.matched || 0,
        runners: (m.runners || []).map(r => ({
          selectionId: r.id,
          status: r.status || 'ACTIVE',
          lastPriceTraded: r.lastPriceTraded || null,
          ex: {
            availableToBack: (r.back || []).map(b => ({ price: b.price, size: b.size })),
            availableToLay:  (r.lay  || []).map(l => ({ price: l.price, size: l.size })),
          },
        })),
      });
    });
    if (results.length >= marketIds.length) break; // sab mil gaye, aage dhoondhne ki zaroorat nahi
  }
  return results;
}

// ⚠️ INTENTIONALLY DISABLED — dekhein file ke top wala notice.
// Shubdx ke market IDs Betfair ko pata nahi, is liye Betfair se
// settlement query karna hamesha fail hoga. Jab tak Shubdx khud
// result/winner data confirm na kare, ye function explicitly error
// deti hai — chup-chaap galat/khaali data return nahi karti, taake
// autoSettle_service.js turant pata laga sake ke ye layer available
// nahi hai (uska already-maujood fallback/warning system use hoga).
// ✅ RESTORED: op:"Betfair" wale markets ka ID asal Betfair ko pata hota
// hai, is liye settlement REAL Betfair API se hi query karte hain —
// bilkul jaisa migration se pehle hota tha. op:"Shubdx" wale markets ke
// liye Betfair ye query fail karega (INVALID_MARKET_ID jaisa error) —
// wo autoSettle_service.js mein already-maujood "winner not determinable"
// / stuck-market warning flow mein visible ho jayega, chup-chaap nahi.
async function listMarketProfitAndLoss(marketIds = []) {
  return bfJsonRpc('SportsAPING/v1.0/listMarketProfitAndLoss', {
    marketIds,
    includeSettledBets: true,
    includeBspBets: true,
    netOfCommission: false,
  });
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
  listEventTypes,
  listCompetitions,
  listEvents,
  listMarketCatalogue,
  listMarketBook,
  listMarketProfitAndLoss,
  getEventDetails,
  getRunnerBook,
};
