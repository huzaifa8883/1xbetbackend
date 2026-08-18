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

   ⚠️ UNCONFIRMED HISSA (abhi tak real sample se verify nahi hua):
   1) /api1/menu ka EXACT response shape — sirf itna pata hai ke isse
      "eventName → matchId" milta hai (docs se). eventTypeId/competition/
      startTime jaise fields kis naam se aate hain, confirm nahi —
      is liye normalizeMenuItem() mein kai plausible field-name variants
      try kiye hain (defensive parsing), taake jo bhi shape ho crash na ho.

   ✅ CONFIRMED (real in-play match, marketId=1.259466913 se):
   2) /data/Data ka marketBooks[].runners[] structure ab confirm ho chuka
      hai: { id, price1/2/3, size1/2/3, lay1/2/3, ls1/2/3 (← lay SIZE,
      "laySize" nahi), status, handicap }. listMarketBook() ab isi ke
      hisab se sahi parse karta hai. Pehle "ls1/2/3" ki jagah "laySize"/
      "lsize" try ho raha tha (kabhi match nahi hota tha → LAY size hamesha
      0 aata tha), aur marketBooks[0].marketStatus field ko "status"
      samjha ja raha tha (galat naam, hamesha default 'OPEN' fallback
      chalta tha) — dono fix ho chuke hain.

   ➡️ AGLA STEP (agar kuch bacha ho): /api1/menu ka real sample bhejna
      taake normalizeMenuItem() ki defensive-parsing guesses confirm ho
      sakein.

   ⚠️ UPDATE (3rd migration): PRIMARY listing source ab /api1/menu nahi,
      /api1/markethighlights hai (featured/in-play + upcoming active
      matches — homepage instantly load hoti hai, empty catalog nahi
      dikhta). /api1/menu ab sirf FALLBACK hai jab highlights khaali ho
      ya fail ho jaaye. Dono cached hain (BETWAY_HIGHLIGHTS_CACHE_TTL_MS
      / BETWAY_MENU_CACHE_TTL_MS, default 5s). listCompetitions(),
      listEvents(), listMarketCatalogue() sab sportItems() se hi data
      lete hain, jo highlights→menu fallback chain khud handle karta
      hai — un functions mein koi change nahi karna pada.
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

async function menuItems(eventTypeId) {
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

/* ═══════════════════════════════════════════════════════════════════
   ✅ NEW PRIMARY SOURCE — /api1/markethighlights
   ═══════════════════════════════════════════════════════════════════
   Highlights endpoint featured/in-play + upcoming active matches deta
   hai — /api1/menu se zyada "curated" hai, is liye ab primary source
   yahi hai. /api1/menu ab sirf FALLBACK hai (agar highlights khaali
   ho ya fail ho jaaye).

   ⚠️ Exact response shape bhi unconfirmed hai (jaisa menu ke saath tha),
   is liye normalizeHighlightItem() bhi defensive parsing karta hai —
   dono flat shape ("[{marketId,...}]") aur nested shape
   ("[{eventId, event:{...}, markets:[{marketId,...}, ...]}]") dono
   handle karta hai (flattenHighlightEntries() se).
   ═══════════════════════════════════════════════════════════════════ */
const _highlightsCache = new Map(); // key: eventTypeId || '__all__' → { data, expiresAt }
const HIGHLIGHTS_CACHE_TTL_MS = parseInt(process.env.BETWAY_HIGHLIGHTS_CACHE_TTL_MS || '5000', 10);

async function fetchHighlights(eventTypeId = null) {
  const cacheKey = eventTypeId ? String(eventTypeId) : '__all__';
  const cached = _highlightsCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const url = `${BASE_URL}/api1/markethighlights`;
  const params = eventTypeId
    ? { eventTypeId, sportId: eventTypeId, sport: eventTypeId }
    : undefined;

  try {
    const res = await axios.get(url, { params, timeout: TIMEOUT_MS });
    const raw = res.data;
    // ⚠️ Unconfirmed shape — same defensive-parsing pattern as fetchMenu()
    const items = Array.isArray(raw)                ? raw
                : Array.isArray(raw?.data)           ? raw.data
                : Array.isArray(raw?.result)         ? raw.result
                : Array.isArray(raw?.data?.result)   ? raw.data.result
                : Array.isArray(raw?.markets)        ? raw.markets
                : Array.isArray(raw?.highlights)     ? raw.highlights
                : Array.isArray(raw?.events)         ? raw.events
                : Array.isArray(raw?.data?.markets)  ? raw.data.markets
                : [];

    if (!items.length) {
      logger.warn(
        `[BetwayInfo] markethighlights(eventTypeId=${eventTypeId || 'none'}) — 0 items mile. ` +
        `Response top-level keys: ${JSON.stringify(Object.keys(raw || {}))}`
      );
    }

    // Sirf successful (even if empty) responses cache karo — taake ek
    // real "abhi koi highlight nahi hai" result 5s ke liye repeat na ho,
    // lekin ek transient error cache na ho jaaye (neeche catch cache
    // set nahi karta, is liye agli call turant retry karegi).
    _highlightsCache.set(cacheKey, { data: items, expiresAt: Date.now() + HIGHLIGHTS_CACHE_TTL_MS });
    return items;
  } catch (err) {
    logger.error(`[BetwayInfo] markethighlights (${url}, eventTypeId=${eventTypeId || 'none'}) fetch failed: ${err.message}`);
    return [];
  }
}

// Highlights feed possibly event-grouped ho ("event" + nested "markets"
// array) instead of flat per-market entries jaisa /api1/menu deta hai.
// Isko normalize se pehle flatten karte hain taake normalizeHighlightItem()
// har market ke liye ek consistent flat object dekhe.
function flattenHighlightEntries(rawItems) {
  const flat = [];
  (rawItems || []).forEach(entry => {
    if (!entry || typeof entry !== 'object') return;
    const marketsArr = Array.isArray(entry.markets) ? entry.markets
                      : Array.isArray(entry.market)  ? entry.market
                      : null;

    if (marketsArr && marketsArr.length) {
      marketsArr.forEach(mkt => flat.push({ ...entry, ...mkt, _highlightParent: entry }));
    } else {
      flat.push(entry);
    }
  });
  return flat;
}

// ⚠️ UNCONFIRMED field-names — real /api1/markethighlights sample milte hi
// verify/fix karo (same caveat jo normalizeMenuItem() ke liye hai).
function normalizeHighlightItem(raw) {
  const parent = raw._highlightParent || raw;

  const eventTypeId = String(
    raw.eventTypeId ?? raw.eventtypeid ?? raw.sportId ?? raw.sport_id ??
    raw.eventType?.id ?? parent.eventTypeId ?? parent.eventType?.id ??
    (raw.sport ? SPORT_NAME_TO_EVENT_TYPE[String(raw.sport).toLowerCase()] : '') ?? ''
  );

  const marketId   = raw.marketId ?? raw.market_id ?? raw.matchId ?? raw.match_id ?? raw.id;
  const eventIdRaw = raw.eventId ?? raw.event_id ?? raw.event?.id ?? parent.eventId ?? parent.id ?? marketId;
  const eventId    = String(eventIdRaw);
  const eventName  = raw.eventname ?? raw.eventName ?? raw.event?.name ?? parent.eventName ?? parent.name ?? raw.name ?? raw.matchName ?? 'Unknown';

  const compId   = raw.competitionId ?? raw.competition_id ?? raw.competition?.id ?? parent.competitionId ?? parent.competition?.id ?? null;
  const compName = raw.competitionName ?? raw.competition_name ?? raw.competition?.name ?? parent.competition?.name ?? raw.league ?? null;
  const competition = compId ? { id: String(compId), name: compName || 'Unknown League' } : null;

  const startRaw = raw.marketStartTime ?? raw.startTime ?? raw.start_time ?? raw.start ?? raw.openDate
                 ?? parent.startTime ?? parent.openDate ?? null;

  // Highlights endpoint ka poora point hi in-play/featured matches upar
  // laana hai — is liye inPlay flag ko defensively kai naamon se parse
  // karte hain (parent-level bhi check karte hain, kyunki kabhi kabhi
  // "live" flag event-level pe hota hai, market-level pe nahi).
  const inPlay = !!(
    raw.inPlay ?? raw.inplay ?? raw.in_play ?? raw.isInPlay ??
    raw.live ?? raw.isLive ??
    parent.inPlay ?? parent.inplay ?? parent.live ?? parent.isLive ?? false
  );

  return {
    id: marketId != null ? String(marketId) : null,
    name: raw.marketName ?? raw.market_name ?? 'Match Odds',
    start: startRaw,
    eventTypeId,
    inPlay,
    matched: raw.totalMatched ?? raw.matched ?? 0,
    competition,
    event: {
      id: eventId,
      name: eventName,
      countryCode: raw.countryCode ?? parent.countryCode ?? null,
      venue: raw.venue ?? parent.venue ?? null,
      openDate: startRaw,
    },
    runners: Array.isArray(raw.runners) ? raw.runners
           : Array.isArray(parent.runners) ? parent.runners
           : [],
  };
}

// In-play matches pehle, phir jo jald shuru honge — homepage/featured
// listing ke liye sabse useful order (highlights endpoint ka poora
// maqsad hi ye hai ke "abhi kya chal raha hai" upar dikhe).
function sortHighlighted(items) {
  return items.slice().sort((a, b) => {
    if (a.inPlay !== b.inPlay) return a.inPlay ? -1 : 1;
    const aMs = a.start != null ? new Date(a.start).getTime() : Infinity;
    const bMs = b.start != null ? new Date(b.start).getTime() : Infinity;
    return (isNaN(aMs) ? Infinity : aMs) - (isNaN(bMs) ? Infinity : bMs);
  });
}

async function highlightItems(eventTypeId) {
  const raw = await fetchHighlights(eventTypeId).catch(() => []);
  let items = flattenHighlightEntries(raw).map(normalizeHighlightItem).filter(m => m.id);
  if (eventTypeId) items = items.filter(m => m.eventTypeId === String(eventTypeId));

  // Same "unfiltered + client-side filter" retry jo fetchMenu() mein hai —
  // ho sakta hai eventTypeId-scoped call server-side support na ho.
  if (eventTypeId && !items.length) {
    const allRaw = await fetchHighlights(null).catch(() => []);
    items = flattenHighlightEntries(allRaw).map(normalizeHighlightItem)
      .filter(m => m.id && m.eventTypeId === String(eventTypeId));
  }

  return sortHighlighted(items);
}

/* ── sportItems(): unified entry point — markethighlights PRIMARY,
   /api1/menu FALLBACK (sirf tab jab highlights khaali/fail ho) ────── */
async function sportItems(eventTypeId) {
  try {
    const highlighted = await highlightItems(eventTypeId);
    if (highlighted.length) return highlighted;
    logger.warn(
      `[BetwayInfo] markethighlights khaali (eventTypeId=${eventTypeId || 'none'}) — ` +
      `/api1/menu par fallback ho raha hai.`
    );
  } catch (err) {
    logger.error(
      `[BetwayInfo] markethighlights fetch mein exception (eventTypeId=${eventTypeId || 'none'}): ` +
      `${err.message} — /api1/menu par fallback ho raha hai.`
    );
  }

  return menuItems(eventTypeId);
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
        // ✅ Number() se normalize — Data endpoint (/data/Data) ka runner.id
        // bhi selectionId hi hota hai, aur dono jagah consistent type
        // (number) rakhna zaroori hai warna frontend price ko sahi runner
        // se match hi nahi kar pata (string "47998" !== number 47998)
        selectionId: Number(r.selectionId ?? r.id),
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
  // Exposed mainly for diagnostics/tests — not needed by controllers,
  // since listCompetitions/listEvents/listMarketCatalogue already route
  // through sportItems() internally.
  fetchHighlights,
  normalizeHighlightItem,
};
