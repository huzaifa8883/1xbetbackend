'use strict';

/* ═══════════════════════════════════════════════════════════════════
   ⚠️ MIGRATION NOTICE — BetwayInfo POORI TARAH HATA DI GAYI HAI
   ═══════════════════════════════════════════════════════════════════
   Ab koi bhi odds/listing data BetwayInfo (betwayinfo.com) se nahi
   aata — poora relay hata diya gaya hai, jaisa client ne kaha tha.

   ✅ Odds/listing (listEvents, listMarketCatalogue, listMarketBook,
      listCompetitions, listEventTypes) — SABHI sports (Horse Racing,
      Greyhound, Cricket, Tennis, Football/Soccer) ab bpexch.live ke
      /Common/MarketHighlights response se aate hain (neeche).
   ✅ Settlement (listMarketProfitAndLoss) — REAL Betfair API se hi
      (login/session code neeche zinda hai) — UNCHANGED.

   ⚠️ ZAROORI CAVEAT (ise chhupaya nahi ja raha):
   Horse Racing/Greyhound ke market IDs pehle se hi bpexch ke apne
   composite IDs the (jaise "35954463.1822"), aur ab Football/Cricket/
   Tennis ke IDs bhi bpexch ke apne row IDs hain (jaise
   "m_1_260688187") — BetwayInfo catalog2 se jo IDs milte the wo
   *confirmed genuine Betfair IDs* the ("origin":"BETFAIR"). bpexch ke
   IDs Betfair format ("1.xxxxxxx") mein NAHI hain, is liye
   listMarketProfitAndLoss (settlement) in bpexch-sourced markets ke
   liye ab kaam NAHI karega — real Betfair API in IDs ko pehchanega
   nahi. Ye trade-off hai jo BetwayInfo hataane se seedha aata hai;
   agar settlement chahiye to alag se real Betfair market IDs ka
   mapping banana padega.

   ✅ CONFIRMED ROW FORMAT (real bpexch HTML sample se, Football
   section, 20 rows) — sab sports isi <tr class="...McomCustom">
   structure ko share karte hain (same site, same CSS classes):
     <tr id="m_1_260688187" class="m_1_260688187 McomCustom">
       <td class="sport-date"><span class="day">Today|Tomorrow|InPlay</span>
         <span class="market-time">HH:MM</span>
         <span class="utctime" data-target="time">ISO-8601</span></td>
       <td><div class="teams"><strong class="team-1"><a href="/Common/Event/ID">
         Team A v Team B</a></strong><strong class="team-2"><a>...</a></strong></div></td>
       <td><span class="TMFORDESK">matched amount</span></td>
       <td>x6 <div class="box -blue|-pink"><strong>price</strong><span>size</span></div>
         → back1, lay1, backX, layX, back2, lay2 (X = draw, "-" = no price)
     </tr>
   ⚠️ Cricket aur Tennis tables isi HTML mein is waqt maujood the (nav
   tabs Cricket/Tennis/Soccer dikhate hain) lekin jo sample bheja gaya
   usme Cricket ka <tbody></tbody> khaali tha aur Tennis table sirf
   bheja hi nahi gaya. Parser generic hai (label text "Cricket"/
   "Tennis"/"Football" se detect karta hai) — jis din unka tbody bhi
   bharega, automatically kaam karega. Abhi ke liye khaali array milega
   (crash nahi hoga, chup-chaap 0 items).
   ═══════════════════════════════════════════════════════════════════ */

const axios  = require('axios');
const logger = require('../utils/logger');
const { SPORT_MAP } = require('../config/constants');

const TIMEOUT_MS = 15000;

const BPEXCH_BASE_URL = process.env.BPEXCH_BASE_URL || 'https://bpexch.live';

/**
 * bpexch highlights row id "m_1_261306873" → real Betfair marketId "1.261306873"
 * "m_2_123" → "1.123" still uses 1. prefix (Betfair market ids always 1.xxx)
 * Already "1.261306873" / "9.20660370" / "35962147.1654" → unchanged
 */
function normalizeMarketId(id) {
  if (id == null) return id;
  const s = String(id).trim();
  const m = /^m_(\d+)_(.+)$/i.exec(s);
  if (m) return `1.${m[2]}`;
  return s;
}


/* ── eventTypeId resolution — SPORT_MAP se naam-based match (ID
   hardcode nahi karte, jaisi Rollwin/Greyhound fix mein pehle bhi
   pattern tha) ─────────────────────────────────────────────────── */
function isEventTypeMatching(eventTypeId, keywords) {
  const name = String(SPORT_MAP?.[String(eventTypeId)] || '').toLowerCase();
  return keywords.some(k => name.includes(k));
}
function resolveEventTypeIdByKeywords(keywords, fallback) {
  const found = Object.entries(SPORT_MAP || {}).find(([, name]) =>
    keywords.some(k => String(name || '').toLowerCase().includes(k))
  );
  return found ? found[0] : fallback;
}

function isHorseRacingEventType(eventTypeId) {
  return isEventTypeMatching(eventTypeId, ['horse']) || String(eventTypeId) === '7';
}
function isGreyhoundEventType(eventTypeId) {
  return isEventTypeMatching(eventTypeId, ['grey', 'dog racing']) || String(eventTypeId) === '4339';
}
function isCricketEventType(eventTypeId) {
  // ✅ FIX: horse/greyhound ki tarah hi hardcoded standard Betfair ID
  // fallback add kiya — pehle sirf SPORT_MAP naam-match pe depend karta
  // tha, aur agar wahan "cricket" keyword match nahi hota (naam missing
  // ya thoda different likha ho) to ye function hamesha false deta,
  // aur sportItems() cricket ke liye chup-chaap khaali [] return karta
  // — yahi wajah thi ke dashboard mein cricket data kabhi nahi aata tha.
  return isEventTypeMatching(eventTypeId, ['cricket']) || String(eventTypeId) === '4';
}
function isTennisEventType(eventTypeId) {
  // ✅ FIX: same reason — standard Betfair tennis eventTypeId '2' fallback
  return isEventTypeMatching(eventTypeId, ['tennis']) || String(eventTypeId) === '2';
}
function isFootballEventType(eventTypeId) {
  // ✅ FIX: same reason — standard Betfair soccer eventTypeId '1' fallback
  return isEventTypeMatching(eventTypeId, ['football', 'soccer']) || String(eventTypeId) === '1';
}

function resolveHorseRacingId() {
  return resolveEventTypeIdByKeywords(['horse'], '7');
}
function resolveGreyhoundId() {
  return resolveEventTypeIdByKeywords(['grey', 'dog racing'], '4339');
}
function resolveCricketId() {
  // ✅ FIX: pehle fallback null tha — agar SPORT_MAP mein "cricket" naam
  // match na ho to null milta, aur parseMatchOddsSections() us block ko
  // "eventTypeId hi nahi mili" bol ke skip kar deta (rows parse hone ke
  // baad bhi discard ho jaate). Ab horse('7')/greyhound('4339') jaisa hi
  // hardcoded standard Betfair ID fallback hai.
  return resolveEventTypeIdByKeywords(['cricket'], '4');
}
function resolveTennisId() {
  return resolveEventTypeIdByKeywords(['tennis'], '2');
}
function resolveFootballId() {
  return resolveEventTypeIdByKeywords(['football', 'soccer'], '1');
}

/* ── /Common/MarketHighlights — cached fetch (racing + match-odds
   sports dono isi ek response se aate hain) ───────────────────────── */
let _highlightsHtmlCache = null;
let _highlightsHtmlExpiry = 0;
// Chhota TTL rakha hai taake "time ke sath data update" ho — har naya
// request (cache expire hone ke baad) fresh HTML khींchta hai.
const HIGHLIGHTS_CACHE_TTL_MS = parseInt(process.env.BPEXCH_HIGHLIGHTS_CACHE_TTL_MS || '4000', 10);

/* ── /api1/markethighlights JSON endpoint — PRIMARY data source
   Ye bpexch ka native JSON feed hai (HTML scraping se zyada reliable).
   HTML scraping ab FALLBACK hai agar ye fail ho.                       */
const HIGHLIGHTS_JSON_TTL_MS = parseInt(process.env.BETWAY_HIGHLIGHTS_CACHE_TTL_MS || '5000', 10);
let _highlightsJsonCache  = null;
let _highlightsJsonExpiry = 0;
let _highlightsJsonPromise = null;  // in-flight dedup

async function fetchMarkethighlightsJson() {
  const url = `${BPEXCH_BASE_URL}/api1/markethighlights`;
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BPEXCH_BASE_URL}/Common/Dashboard`,
      Origin: BPEXCH_BASE_URL,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    validateStatus: s => s < 500,
  });
  if (res.status !== 200 || !res.data) throw new Error(`markethighlights HTTP ${res.status}`);
  return res.data;
}

async function getMarkethighlightsJson() {
  if (_highlightsJsonCache && Date.now() < _highlightsJsonExpiry) return _highlightsJsonCache;
  if (_highlightsJsonPromise) return _highlightsJsonPromise;
  _highlightsJsonPromise = fetchMarkethighlightsJson()
    .then(data => {
      _highlightsJsonCache  = data;
      _highlightsJsonExpiry = Date.now() + HIGHLIGHTS_JSON_TTL_MS;
      _highlightsJsonPromise = null;
      logger.info('[bpexch] markethighlights JSON fetched successfully');
      return data;
    })
    .catch(err => {
      _highlightsJsonPromise = null;
      throw err;
    });
  return _highlightsJsonPromise;
}

/**
 * normalizeHighlightItem — raw markethighlights JSON item → internal format
 * Compatible with parseMatchRow output shape.
 */
function normalizeHighlightItem(item) {
  if (!item) return null;

  // marketId: m_1_XXXXXXXX → 1.XXXXXXXX
  const rawId   = String(item.id || item.marketId || '');
  const marketId = normalizeMarketId(rawId);
  if (!marketId) return null;

  // eventTypeId — map sport label strings to Betfair IDs
  let eventTypeId = String(item.eventTypeId || item.sport?.id || '');
  if (!eventTypeId || eventTypeId === 'undefined') {
    const label = String(item.sport?.name || item.sportName || item.eventType || '').toLowerCase();
    if (label.includes('cricket'))              eventTypeId = '4';
    else if (label.includes('tennis'))          eventTypeId = '2';
    else if (label.includes('football') || label.includes('soccer')) eventTypeId = '1';
    else if (label.includes('horse'))           eventTypeId = '7';
    else if (label.includes('grey') || label.includes('dog')) eventTypeId = '4339';
  }
  if (!eventTypeId) return null;

  const startIso = item.startTime || item.openDate || item.marketStartTime
    || item.event?.openDate || new Date().toISOString();

  // Event id — prefer href-based / field
  const eventId = item.eventId || item.event?.id || item.event?.eventId || rawId;

  // Team / runner names
  const team1 = item.team1 || item.home || item.runner1 || '';
  const team2 = item.team2 || item.away || item.runner2 || '';
  const eventName = item.eventName || item.event?.name
    || (team1 && team2 ? `${team1} v ${team2}` : team1 || marketId);

  // Runners — some highlights feeds include them, some don't
  let runners = [];
  if (Array.isArray(item.runners) && item.runners.length) {
    runners = item.runners.map((r, i) => ({
      selectionId: r.selectionId || r.id || (i + 1),
      runnerName:  r.runnerName  || r.name || `Runner ${i + 1}`,
      sortPriority: r.sortPriority || r.sort || (i + 1),
      handicap: r.handicap || r.hdp || 0,
      metadata: r.metadata || {},
      ex: {
        availableToBack: (r.back || r.availableToBack || []).slice(0, 3).map(b =>
          ({ price: b.price ?? b, size: b.size || 0 })),
        availableToLay:  (r.lay  || r.availableToLay  || []).slice(0, 3).map(l =>
          ({ price: l.price ?? l, size: l.size || 0 })),
      },
    }));
  }

  return {
    id: marketId,
    name: item.marketName || item.name || 'Match Odds',
    start: startIso,
    eventTypeId,
    inPlay: !!(item.inPlay || item.inplay || item.isInPlay),
    matched: item.totalMatched || item.matched || 0,
    competition: item.competition || (item.competitionName ? { id: item.competitionId || '', name: item.competitionName } : null),
    event: {
      id:          String(eventId),
      name:        eventName,
      countryCode: item.countryCode || item.event?.countryCode || null,
      venue:       item.venue       || item.event?.venue       || null,
      openDate:    startIso,
    },
    runners,
  };
}

async function fetchHighlightsHtml() {
  const url = `${BPEXCH_BASE_URL}/Common/MarketHighlights`;
  const res = await axios.get(url, {
    params: { _: Date.now() }, // site khud bhi cache-buster query bhejta hai
    timeout: TIMEOUT_MS,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*',
    },
  });
  return typeof res.data === 'string' ? res.data : String(res.data);
}

async function getHighlightsHtml() {
  if (_highlightsHtmlCache && Date.now() < _highlightsHtmlExpiry) return _highlightsHtmlCache;
  const html = await fetchHighlightsHtml();
  _highlightsHtmlCache = html;
  _highlightsHtmlExpiry = Date.now() + HIGHLIGHTS_CACHE_TTL_MS;
  return html;
}

function sliceBetweenMarkers(html, startMarker, endMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return '';
  const from = startIdx + startMarker.length;
  const endIdx = endMarker ? html.indexOf(endMarker, from) : -1;
  return endIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, endIdx);
}

/* ═══════════════════════════════════════════════════════════════════
   Horse Racing / Greyhound — HTML-embedded slider (CONFIRMED, unchanged)
   ═══════════════════════════════════════════════════════════════════ */

// <a href="/Common/Event/35954463.1822">...utctime...2026-08-19T18:22:00...
// ...slidename'>Finger Lakes (US)...
const RACE_ITEM_RE = /href="\/Common\/Event\/([^"]+)"[\s\S]*?utctime[^>]*>\s*([^<]+?)\s*<\/span>[\s\S]*?slidename'>\s*([^<]+?)\s*<\/span>/g;

function parseRaceItems(sectionHtml, eventTypeId) {
  const items = [];
  let m;
  RACE_ITEM_RE.lastIndex = 0;
  while ((m = RACE_ITEM_RE.exec(sectionHtml)) !== null) {
    const [, hrefId, startIsoRaw, venueRaw] = m;
    const id = hrefId.trim(); // poora string hi unique race id hai
    const venue = venueRaw.trim();
    const startIso = startIsoRaw.trim();
    items.push({
      id,
      name: `${venue} - Win`,
      start: startIso,
      eventTypeId: String(eventTypeId),
      inPlay: false,
      matched: 0,
      competition: null,
      event: {
        id,
        name: venue,
        countryCode: null,
        venue,
        openDate: startIso,
      },
      runners: [], // is highlights feed mein runners nahi aate — sirf meeting/race listing hai
    });
  }
  return items;
}

async function getRacingHighlights(eventTypeId) {
  // PRIMARY: try markethighlights JSON (may include racing sections)
  try {
    const jsonItems = await getSportsHighlightsFromJson(eventTypeId);
    if (jsonItems !== null && jsonItems.length > 0) return jsonItems;
  } catch(e) { /* fall through */ }

  // FALLBACK: HTML scraping (always worked for racing)
  const html = await getHighlightsHtml();
  const horseSection     = sliceBetweenMarkers(html, 'Horse Race', 'Grey Hound');
  const greyhoundSection = sliceBetweenMarkers(html, 'Grey Hound', 'TABS SYSTEM');

  if (eventTypeId != null) {
    if (isHorseRacingEventType(eventTypeId)) return parseRaceItems(horseSection, eventTypeId);
    if (isGreyhoundEventType(eventTypeId))   return parseRaceItems(greyhoundSection, eventTypeId);
    return [];
  }

  return [
    ...parseRaceItems(horseSection,     resolveHorseRacingId()),
    ...parseRaceItems(greyhoundSection, resolveGreyhoundId()),
  ];
}

/* ═══════════════════════════════════════════════════════════════════
   Cricket / Tennis / Football — match-odds tables (CONFIRMED via
   Football sample; parser generic hai, Cricket/Tennis automatically
   kaam karega jis din unka tbody bhi bhare)
   ═══════════════════════════════════════════════════════════════════ */

const MATCH_ROW_RE = /<tr id="([^"]+)"[^>]*class="[^"]*McomCustom[^"]*"[\s\S]*?<\/tr>/g;
const DAY_RE = /<span class="day">([^<]*)<\/span>/;
// ✅ FIX: pehle `[^<]+` tha (kam se kam 1 char required) — is-play/live
// matches ke liye bpexch ye span KHAALI chhod deta hai (kyunki unka koi
// future start-time dikhana nahi hota, bas "In-Play" status day-span mein
// dikhta hai). Khaali span pe match fail ho jata tha aur poori row hi
// discard ho jaati thi — yahi wajah thi ke exactly live/in-play matches
// (jo dashboard pe sabse zyada chahiye) gayab ho rahe the. Ab `*` use
// kar rahe hain (0 ya zyada chars) taake khaali span bhi match ho.
const TIME_ISO_RE = /data-target="time">\s*([^<]*?)\s*<\/span>/;
const TEAM1_RE = /<strong class="team-1">\s*<a href="([^"]*)">\s*([^<]*?)\s*<\/a>/;
const TEAM2_RE = /<strong class="team-2">\s*<a[^>]*>\s*([^<]*?)\s*<\/a>/;
const MATCHED_RE = /class="TMFORDESK">([^<]*)<\/span>/;
const BOX_RE = /class="box\s+(-blue|-pink)[^"]*">\s*<strong>\s*([^<]*?)\s*<\/strong>\s*<span>\s*([^<]*?)\s*<\/span>/g;

// "22.9k" → 22900, "3,099" → 3099, "-" / "" → 0
function parseCompactNumber(str) {
  if (str == null) return 0;
  const s = String(str).trim().replace(/,/g, '');
  if (!s || s === '-') return 0;
  if (/k$/i.test(s)) {
    const n = parseFloat(s);
    return isNaN(n) ? 0 : Math.round(n * 1000);
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// "-" / "" → null (no price offered), warna float
function parsePrice(str) {
  const s = String(str ?? '').trim();
  if (!s || s === '-') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseMatchRow(rowHtml, rowId, eventTypeId) {
  const t1M = TEAM1_RE.exec(rowHtml);
  if (!t1M) return null; // team hi na mili to row samajh nahi aayi — skip, crash mat karo

  const isoM = TIME_ISO_RE.exec(rowHtml);
  const dayM = DAY_RE.exec(rowHtml);
  const t2M = TEAM2_RE.exec(rowHtml);
  const matchedM = MATCHED_RE.exec(rowHtml);

  const day = (dayM?.[1] || '').trim();
  // ✅ FIX: in-play matches ke liye time span khaali hota hai (upar
  // TIME_ISO_RE comment dekho). Khaali/missing ho to "abhi" (current
  // timestamp) use karo — match already chal raha hai, is liye "start"
  // ko past/now maan lena sahi hai aur ye listEvents() ke window filter
  // se bhi bahar nahi jayega.
  // bpexch kabhi-kabhi "2026-08-21T14:00:00.0000000Z" (7 frac digits) deta
  // hai — Node parse kar leta hai, lekin safe normalize: frac digits ko 3
  // tak truncate + trim newlines/spaces.
  let rawIso = (isoM?.[1] || '').trim().replace(/\s+/g, '');
  if (rawIso) {
    rawIso = rawIso.replace(/(\.\d{3})\d+(Z)$/i, '$1$2');
  }
  const startIso = rawIso || new Date().toISOString();
  const eventHref = t1M[1] || '';
  const eventId = eventHref.split('/').filter(Boolean).pop() || rowId;
  const team1Text = (t1M[2] || '').trim();
  const team2Text = (t2M?.[1] || '').trim();

  // Football jaisa format: team-1 anchor mein hi "Team A v Team B" poora
  // aata hai, team-2 anchor khaali rehta hai — is liye " v " se split karo.
  let homeName = team1Text;
  let awayName = team2Text || null;
  if (!awayName && / v /i.test(team1Text)) {
    const parts = team1Text.split(/ v /i);
    homeName = parts[0].trim();
    awayName = parts.slice(1).join(' v ').trim();
  }

  const boxes = [];
  BOX_RE.lastIndex = 0;
  let boxM;
  while ((boxM = BOX_RE.exec(rowHtml)) !== null) {
    boxes.push({
      side: boxM[1] === '-blue' ? 'back' : 'lay',
      price: parsePrice(boxM[2]),
      size: parseCompactNumber(boxM[3]),
    });
  }
  // Expected order: back1, lay1, backX, layX, back2, lay2
  const outcomeNames = [homeName || 'Runner 1', 'The Draw', awayName || 'Runner 2'];
  const runners = [];
  for (let i = 0; i < 3; i++) {
    const back = boxes[i * 2];
    const lay = boxes[i * 2 + 1];
    // Dono side khaali ("-") → ye outcome market mein hi nahi hai (e.g.
    // tennis mein "X"/Draw kabhi nahi hota) — skip karo, fake runner na banao.
    if ((!back || back.price == null) && (!lay || lay.price == null)) continue;
    runners.push({
      selectionId: i + 1, // synthetic — sirf isi market ke andar unique/consistent
      runnerName: outcomeNames[i],
      sortPriority: i + 1,
      handicap: 0,
      metadata: {},
      ex: {
        availableToBack: back && back.price != null ? [{ price: back.price, size: back.size || 0 }] : [],
        availableToLay:  lay  && lay.price  != null ? [{ price: lay.price,  size: lay.size  || 0 }] : [],
      },
    });
  }

  // ✅ m_1_261306873 → 1.261306873 taake Market.html?id= catalog2 / bpexch se match kare
  const marketId = normalizeMarketId(rowId);

  return {
    id: marketId,
    name: 'Match Odds',
    start: startIso,
    eventTypeId: String(eventTypeId),
    inPlay: /^in\s*-?\s*play/i.test(day),
    matched: parseCompactNumber(matchedM?.[1]),
    competition: null,
    event: {
      id: eventId,
      name: awayName ? `${homeName} v ${awayName}` : homeName,
      countryCode: null,
      venue: null,
      openDate: startIso,
    },
    runners,
  };
}

// ✅ REVERTED to div/svg-based block detection — verified directly against
// REAL live HTML the user pasted from DevTools (not a guess this time).
// Each sport genuinely lives in its own `<div class="high_lights">...
// <table>...</table></div>` block, with the sport name inside `<title>`
// (svg icon title, e.g. `<title>tennis</title>`) — that's the most stable
// label source since it's semantic markup, not display text.
//
// ⚠️ The PREVIOUS revision here (nav-order marker slicing) was wrong: it
// found "Cricket"/"Tennis"/"Football" text in whatever order they first
// appear in the page (which is the TAB-BUTTON nav, e.g. "Cricket, Tennis,
// Football"), but the actual DATA sections appear in a different order
// ("Football, Tennis, Cricket" in the real response) — so it sliced the
// wrong regions and got 0 rows for Cricket/Tennis. Confirmed by testing
// this block-based approach directly against the real pasted HTML.
// ✅ More robust: don't require exact "</table></div>" adjacency (live HTML
// sometimes has whitespace/comments/extra wrappers). Capture until the next
// high_lights block or end of string; rows are still found via MATCH_ROW_RE.
const HIGHLIGHTS_BLOCK_RE = /<div class="high_lights"[^>]*>([\s\S]*?)(?=<div class="high_lights"|$)/g;
const SPORT_TITLE_RE = /<title>\s*([A-Za-z]+)\s*<\/title>/i;
const SPORT_LABEL_FALLBACK_RE = /<\/svg>\s*([A-Za-z]+)\s*<\/div>/;

function extractSportLabel(blockHtml) {
  const titleM = SPORT_TITLE_RE.exec(blockHtml);
  if (titleM) return titleM[1];
  const fbM = SPORT_LABEL_FALLBACK_RE.exec(blockHtml);
  return fbM ? fbM[1] : '';
}

function eventTypeIdForSportLabel(label) {
  // ✅ CRITICAL FIX: marketcontroller.js cricket/tennis/football endpoints
  // hardcode standard Betfair IDs (4 / 2 / 1). Agar SPORT_MAP mein naam
  // match ho ke koi ALAG id return ho jaye, to getSportsHighlights() exact
  // string filter fail ho jata hai → events=0. Is liye yahan hamesha
  // standard Betfair IDs force karo — resolve* sirf is*EventType / racing
  // ke liye use hote hain.
  const l = String(label || '').toLowerCase();
  if (l.includes('cricket')) return '4';
  if (l.includes('tennis')) return '2';
  if (l.includes('football') || l.includes('soccer')) return '1';
  return null;
}

function parseMatchOddsSections(html) {
  const sections = [];
  let block;
  HIGHLIGHTS_BLOCK_RE.lastIndex = 0;
  let blockCount = 0;
  while ((block = HIGHLIGHTS_BLOCK_RE.exec(html)) !== null) {
    blockCount++;
    const blockHtml = block[1];
    const label = extractSportLabel(blockHtml);
    const eventTypeId = eventTypeIdForSportLabel(label);

    const items = [];
    if (eventTypeId) {
      let rowM;
      MATCH_ROW_RE.lastIndex = 0;
      while ((rowM = MATCH_ROW_RE.exec(blockHtml)) !== null) {
        const item = parseMatchRow(rowM[0], rowM[1], eventTypeId);
        if (item) items.push(item);
      }
    }
    logger.info(`[bpexch] block#${blockCount} label="${label}" eventTypeId=${eventTypeId} rows=${items.length}`);
    if (!eventTypeId) continue; // is sport ki SPORT_MAP mein ID hi nahi mili — safe skip
    sections.push({ label, eventTypeId, items });
  }
  if (!blockCount) {
    logger.warn('[bpexch] no "high_lights" blocks found at all in MarketHighlights response');
  }
  return sections;
}

async function getSportsHighlightsFromJson(eventTypeId) {
  try {
    const data = await getMarkethighlightsJson();
    // Response may be: { cricket:[...], football:[...], tennis:[...] }
    // OR: [ { eventTypeId, markets:[...] } ]
    // OR: flat array of items
    let items = [];

    if (Array.isArray(data)) {
      // Flat array or array of sport groups
      for (const entry of data) {
        if (Array.isArray(entry.markets)) {
          items.push(...entry.markets.map(normalizeHighlightItem).filter(Boolean));
        } else if (entry.id || entry.marketId) {
          const n = normalizeHighlightItem(entry);
          if (n) items.push(n);
        }
      }
    } else if (data && typeof data === 'object') {
      // Key → array shape: { cricket:[...], football:[...] }
      for (const [key, val] of Object.entries(data)) {
        if (!Array.isArray(val)) continue;
        for (const item of val) {
          const n = normalizeHighlightItem(item);
          if (n) items.push(n);
        }
      }
    }

    if (!items.length) throw new Error('markethighlights JSON returned 0 items');

    if (eventTypeId != null) {
      const wanted = String(eventTypeId);
      items = items.filter(m => String(m.eventTypeId) === wanted);
    }
    logger.info(`[bpexch] markethighlights JSON: ${items.length} items (eventTypeId=${eventTypeId ?? 'all'})`);
    return items;
  } catch (err) {
    logger.warn(`[bpexch] markethighlights JSON failed (eventTypeId=${eventTypeId}): ${err.message} — falling back to HTML`);
    return null;  // null = caller falls back to HTML scraper
  }
}

async function getSportsHighlights(eventTypeId) {
  // PRIMARY: markethighlights JSON API
  const jsonItems = await getSportsHighlightsFromJson(eventTypeId);
  if (jsonItems !== null) return jsonItems;

  // FALLBACK: HTML scraping (original)
  const html = await getHighlightsHtml();
  const sections = parseMatchOddsSections(html);
  if (eventTypeId != null) {
    const wanted = String(eventTypeId);
    return sections.filter(s => String(s.eventTypeId) === wanted).flatMap(s => s.items);
  }
  return sections.flatMap(s => s.items);
}

/* ═══════════════════════════════════════════════════════════════════
   ✅ REAL Betfair session/login — SETTLEMENT ke liye zinda hai
   (listMarketProfitAndLoss). Ye code bilkul waisa hi hai jo pehle tha
   — UNCHANGED. Dhyaan rahe: ab sirf genuine Betfair-format market IDs
   ke liye kaam karega (upar wala caveat dekh lo).
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
   sportItems() — sabhi sports ka single entry point, ab poori tarah
   bpexch.live se (BetwayInfo hata diya gaya hai)
   ═══════════════════════════════════════════════════════════════════ */
async function sportItems(eventTypeId) {
  if (isHorseRacingEventType(eventTypeId) || isGreyhoundEventType(eventTypeId)) {
    return getRacingHighlights(eventTypeId).catch(err => {
      logger.error(`[bpexch] racing highlights fetch failed (eventTypeId=${eventTypeId}): ${err.message}`);
      return [];
    });
  }

  if (eventTypeId != null && (isCricketEventType(eventTypeId) || isTennisEventType(eventTypeId) || isFootballEventType(eventTypeId))) {
    return getSportsHighlights(eventTypeId).catch(err => {
      logger.error(`[bpexch] match-odds highlights fetch failed (eventTypeId=${eventTypeId}): ${err.message}`);
      return [];
    });
  }

  if (!eventTypeId) {
    // Sport specify nahi hui — racing + cricket/tennis/football, sab
    // isi ek bpexch highlights response se mila ke do
    const [racing, matchOdds] = await Promise.all([
      getRacingHighlights(null).catch(err => {
        logger.error(`[bpexch] racing highlights fetch failed: ${err.message}`);
        return [];
      }),
      getSportsHighlights(null).catch(err => {
        logger.error(`[bpexch] match-odds highlights fetch failed: ${err.message}`);
        return [];
      }),
    ]);
    return [...racing, ...matchOdds];
  }

  // Koi aur/unknown sport — BetwayInfo hat chuka hai, iske liye ab koi
  // source nahi hai
  return [];
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

  // Cricket / Tennis / Football highlights already curated by bpexch
  // (sirf relevant current + upcoming). Tight marketStartTime window
  // (esp. jab SportConfig.hours_ahead chhota ho ya In-Play match ka
  // start lookback se pehle ho) unhe discard kar deta tha → events=0.
  // Racing ke liye filter zaroori hai, match-odds ke liye soft.
  const isMatchOddsSport =
    isCricketEventType(eventTypeId) ||
    isTennisEventType(eventTypeId) ||
    isFootballEventType(eventTypeId);

  const seen = new Map();
  let kept = 0, droppedComp = 0, droppedTime = 0, droppedNoId = 0;
  items.forEach(m => {
    const ev = m.event;
    if (!ev?.id) { droppedNoId++; return; }

    // ✅ CRITICAL: match-odds items have competition: null always (bpexch
    // highlights mein competition/league id nahi aata). Agar SportConfig
    // mein allowed_competition_ids set ho to purana code har row discard
    // kar deta tha → events=0 even when rows parsed. Skip competition
    // filter for cricket/tennis/football.
    if (!isMatchOddsSport) {
      if (competitionIds && !competitionIds.includes(String(m.competition?.id))) {
        droppedComp++;
        return;
      }
    }

    const startMs = m.start != null ? new Date(m.start).getTime() : NaN;

    if (!isMatchOddsSport) {
      // Racing: strict window
      if (fromMs !== null && !isNaN(startMs) && startMs < fromMs) { droppedTime++; return; }
      if (toMs   !== null && !isNaN(startMs) && startMs > toMs)   { droppedTime++; return; }
    }
    // Match-odds: NO time filter — bpexch highlights already curated.
    // (previous wide-window still dropped some edge cases)

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
    kept++;
  });
  logger.info(`[listEvents] eventTypeId=${eventTypeId} matchOdds=${isMatchOddsSport} items=${items.length} kept=${kept} droppedComp=${droppedComp} droppedTime=${droppedTime} droppedNoId=${droppedNoId} events=${seen.size}`);
  return Array.from(seen.values());
}

// Betfair jaisa shape: [{ marketId, marketName, marketStartTime, totalMatched,
//                          competition, event, eventType, runners:[{selectionId, runnerName, sortPriority}] }]
//
// ✅ Ab koi alag catalogs/catalog2 call nahi lagti — bpexch ki highlights
// HTML mein hi runner names + prices dono ek saath aa jaate hain (racing
// ke liye runners khaali rehte hain, jaisa pehle bhi tha).
async function listMarketCatalogue(filter = {}, maxResults = '20', marketProjection) {
  const eventTypeId = filter?.eventTypeIds?.[0];
  let items = [];

  if (eventTypeId) {
    items = await sportItems(eventTypeId);
  } else if (filter?.marketIds?.length || filter?.eventIds?.length) {
    // Sport pata nahi — poori list mein se dhoondo
    const all = await sportItems(null);
    if (filter?.marketIds?.length) {
      const ids = new Set();
      for (const raw of filter.marketIds.map(String)) {
        ids.add(raw);
        ids.add(normalizeMarketId(raw));
      }
      items = all.filter(m => ids.has(String(m.id)) || ids.has(normalizeMarketId(m.id)));
    } else if (filter?.eventIds?.length) {
      const ids = filter.eventIds.map(String);
      items = all.filter(m => ids.includes(String(m.event?.id)));
    }
  }

  if (filter?.eventIds?.length) {
    const ids = filter.eventIds.map(String);
    items = items.filter(m => ids.includes(String(m.event?.id)));
  }
  if (filter?.marketIds?.length) {
    // accept both raw and normalized forms (m_1_xxx ↔ 1.xxx)
    const ids = new Set();
    for (const raw of filter.marketIds.map(String)) {
      ids.add(raw);
      ids.add(normalizeMarketId(raw));
    }
    items = items.filter(m => ids.has(String(m.id)) || ids.has(normalizeMarketId(m.id)));
  }

  const sliced = items.slice(0, parseInt(maxResults, 10) || 20);
  if (!sliced.length) return [];

  return sliced.map(m => {
    const startMs = m.start != null ? new Date(m.start).getTime() : NaN;
    const eid = String(m.eventTypeId || eventTypeId || '');

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
      eventType: { id: eid, name: SPORT_MAP[eid] || 'Other' },
      runners: (m.runners || []).map(r => ({
        // Number() se normalize — listMarketBook ka runner.selectionId bhi
        // isi tarah number hota hai, dono jagah consistent type zaroori hai
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
//                                     ex: { availableToBack, availableToLay }}] }]
//
// ✅ BetwayInfo ka /data/Data endpoint hata diya gaya hai. Cricket/Tennis/
// Football ke liye prices already listing-time par hi bpexch highlights
// HTML se mil jaate hain (getSportsHighlights() ke ex.back/lay), is liye
// unhi ko yahan dobara lookup karke return kar dete hain — alag price-call
// ki zaroorat nahi. Horse Racing/Greyhound ke liye abhi koi live-price
// source nahi hai (highlights feed mein sirf listing hai, odds nahi) —
// unke liye safe default (khaali runners) milta hai, jaisa pehle bhi tha.
let _matchOddsLookupPromise = null;
async function getMatchOddsLookup() {
  if (_matchOddsLookupPromise) return _matchOddsLookupPromise;
  _matchOddsLookupPromise = (async () => {
    try {
      const items = await getSportsHighlights(null);
      return new Map(items.map(it => [String(it.id), it]));
    } catch (err) {
      logger.warn(`[bpexch] match-odds lookup for listMarketBook failed: ${err.message}`);
      return new Map();
    }
  })();
  // Highlights cache jitni der valid hai usi hisaab se ye lookup bhi
  // dobara banega — is promise ko highlights cache expiry ke sath hi reset karo
  setTimeout(() => { _matchOddsLookupPromise = null; }, HIGHLIGHTS_CACHE_TTL_MS);
  return _matchOddsLookupPromise;
}

async function listMarketBook(marketIds = [], priceProjection) {
  if (!marketIds.length) return [];

  const lookup = await getMatchOddsLookup();

  return marketIds.map((id) => {
    const item = lookup.get(String(id));
    if (item) {
      return {
        marketId: id,
        status: 'OPEN',
        inplay: !!item.inPlay,
        betDelay: 0,
        totalMatched: item.matched || 0,
        runners: (item.runners || []).map(r => ({
          selectionId: Number(r.selectionId),
          status: 'ACTIVE',
          lastPriceTraded: null,
          ex: r.ex,
        })),
        scoreboard: null,
      };
    }
    // Horse racing/greyhound ya unrecognized market — koi live price
    // source abhi available nahi, safe default
    return { marketId: id, status: 'OPEN', inplay: false, betDelay: 0, totalMatched: 0, runners: [] };
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


/* ═══════════════════════════════════════════════════════════════════
   bpexch catalog2 / catalogs / live Data — market page ke liye
   (Bookmaker, Fancy, Figure, scoreboard, commentary)
   ═══════════════════════════════════════════════════════════════════ */

const PRICES7_BASE = process.env.PRICES7_BASE_URL || 'https://prices7.mgs11.com';

async function fetchBpexchCatalog2(marketId) {
  const id = normalizeMarketId(marketId);
  // try a few URL shapes (trailing slash / no slash) — CF/proxy sometimes picky
  const urls = [
    `${BPEXCH_BASE_URL}/api/markets/catalog2/?id=${encodeURIComponent(id)}`,
    `${BPEXCH_BASE_URL}/api/markets/catalog2?id=${encodeURIComponent(id)}`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: {
          Accept: 'application/json, text/plain, */*',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${BPEXCH_BASE_URL}/Common/Dashboard`,
          Origin: BPEXCH_BASE_URL,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        validateStatus: s => s < 500,
      });
      if (res.status !== 200 || !res.data) {
        lastErr = `status=${res.status}`;
        continue;
      }
      const d = res.data.data || res.data;
      if (!d || !(d.marketId || d.marketName)) {
        lastErr = 'empty body';
        continue;
      }
      return d;
    } catch (err) {
      lastErr = err.message;
    }
  }
  logger.warn(`[bpexch] catalog2 all attempts failed for ${id}: ${lastErr}`);
  return null;
}

async function fetchBpexchCatalogs(marketIds = []) {
  if (!marketIds.length) return [];
  const url = `${BPEXCH_BASE_URL}/api/markets/catalogs/`;
  const res = await axios.get(url, {
    params: { ids: marketIds.join(',') },
    timeout: TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BPEXCH_BASE_URL}/`,
    },
    validateStatus: s => s < 500,
  });
  if (res.status !== 200) return [];
  const raw = res.data;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.data)) return raw.data;
  return [];
}

/**
 * Live prices + scoreboard + commentary.
 * prices7 JWT user-session token maangta hai — agar env PRICES7_TOKEN
 * set ho to use hoga, warna null (scoreboard optional).
 */
async function fetchPrices7MarketData(marketId, token) {
  const tok = token || process.env.PRICES7_TOKEN || '';
  if (!tok) return null;
  try {
    const url = `${PRICES7_BASE}/api/Markets/Data`;
    const res = await axios.get(url, {
      params: { id: marketId, token: tok },
      timeout: TIMEOUT_MS,
      headers: { Accept: 'application/json' },
      validateStatus: s => s < 500,
    });
    if (res.status !== 200 || !res.data) return null;
    return res.data;
  } catch (err) {
    logger.warn(`[prices7] Data fetch failed for ${marketId}: ${err.message}`);
    return null;
  }
}

/**
 * Full market page payload: main catalog + subMarkets + optional scoreboard.
 * Prefer bpexch APIs (real 1.xxx / 9.xxx IDs). Fallback null → controller
 * purane listMarketCatalogue path pe chala jayega.
 */
async function getBpexchMarketPage(marketId, pricesToken) {
  const normalizedId = normalizeMarketId(marketId);
  const main = await fetchBpexchCatalog2(normalizedId).catch(err => {
    logger.warn(`[bpexch] catalog2 failed for ${normalizedId}: ${err.message}`);
    return null;
  });
  if (!main) return null;

  // Related sub-market IDs from catalog2 fields if present
  let subIds = [];
  if (Array.isArray(main.relatedMarketIds)) subIds = main.relatedMarketIds.map(String);
  if (Array.isArray(main.subMarketIds)) subIds = subIds.concat(main.subMarketIds.map(String));
  // common bpexch shape: hasBookmakerMarkets / linked ids in externalId patterns — ignore

  // ✅ Scorecard/prices7 SKIP by default (JWT required). Only if explicit token.
  const live = pricesToken
    ? await fetchPrices7MarketData(normalizedId, pricesToken).catch(() => null)
    : null;
  if (live?.marketBooks?.length) {
    for (const mb of live.marketBooks) {
      if (mb.id && String(mb.id) !== String(normalizedId)) subIds.push(String(mb.id));
    }
  }
  subIds = [...new Set(subIds.filter(id => id && id !== String(normalizedId)))];

  let subCatalogs = [];
  if (subIds.length) {
    subCatalogs = await fetchBpexchCatalogs(subIds).catch(err => {
      logger.warn(`[bpexch] catalogs failed: ${err.message}`);
      return [];
    });
  }

  // Map live prices onto main + subs when available
  const bookById = new Map();
  if (live?.marketBooks) {
    for (const mb of live.marketBooks) bookById.set(String(mb.id), mb);
  }

  function attachLive(cat) {
    const mb = bookById.get(String(cat.marketId));
    if (!mb) return cat;
    const runners = (cat.runners || []).map(r => {
      const lr = (mb.runners || []).find(x => String(x.id) === String(r.selectionId));
      if (!lr) return r;
      return {
        ...r,
        status: lr.status || r.status,
        // price ladder (back/lay) for UI
        back: [
          lr.price1 != null ? { price: lr.price1, size: lr.size1 || 0 } : null,
          lr.price2 != null ? { price: lr.price2, size: lr.size2 || 0 } : null,
          lr.price3 != null ? { price: lr.price3, size: lr.size3 || 0 } : null,
        ].filter(Boolean),
        lay: [
          lr.lay1 != null ? { price: lr.lay1, size: lr.ls1 || 0 } : null,
          lr.lay2 != null ? { price: lr.lay2, size: lr.ls2 || 0 } : null,
          lr.lay3 != null ? { price: lr.lay3, size: lr.ls3 || 0 } : null,
        ].filter(Boolean),
      };
    });
    return {
      ...cat,
      status: mb.marketStatus || cat.status,
      totalMatched: mb.totalMatched ?? cat.totalMatched,
      betDelay: mb.betDelay ?? cat.betDelay,
      runners,
    };
  }

  const mainEnriched = attachLive(main);
  const subMarkets = subCatalogs.map(c => {
    const enriched = attachLive(c);
    const t = String(enriched.marketType || '').toUpperCase();
    const n = String(enriched.marketName || '').toLowerCase();
    let category = 'other';
    if (t === 'BOOKMAKER' || n.includes('bookmaker') || enriched.isBmMarket) category = 'bookmaker';
    else if (t === 'TOSS' || n.includes('toss')) category = 'toss';
    else if (t === 'FANCY2' || t === 'LOCAL_FANCY' || n.includes('fancy')) category = 'fancy2';
    else if (t === 'FIGURE' || n.includes('figure')) category = 'figure';
    else if (t === 'ODD_FIGURE' || n.includes('odd')) category = 'oddFigure';
    else if (t.includes('FANCY') || n.includes('session') || n.includes('over')) category = 'fancy';
    return { ...enriched, category };
  });

  return {
    ...mainEnriched,
    eventId: main.eventId || main.event?.id,
    eventName: main.eventName || main.event?.name,
    eventTypeId: String(main.eventTypeId || main.sport?.id || ''),
    eventType: main.eventType || main.sport?.name,
    subMarkets,
    scoreboard: live?.scoreboard || null,
    scores: live?.scores || null,
    news: live?.news || main.news || '',
    source: 'bpexch',
  };
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
  normalizeMarketId,
  fetchBpexchCatalog2,
  fetchBpexchCatalogs,
  fetchPrices7MarketData,
  getBpexchMarketPage,
};
