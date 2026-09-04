

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
let _highlightsFailStreak = 0;
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
  try { await ensureBpexchSession(); } catch (_) {}
  const res = await axios.get(url, {
    timeout: TIMEOUT_MS,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `${BPEXCH_BASE_URL}/Common/Dashboard`,
      Origin: BPEXCH_BASE_URL,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ...(typeof bpexchHeaders === 'function' ? bpexchHeaders() : {}),
      'Cache-Control': 'no-cache',
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
  // Session cookie lagao — hours baad anonymous/CF feed band kar sakta hai
  try { await ensureBpexchSession(); } catch (_) { /* non-fatal */ }
  const res = await axios.get(url, {
    params: { _: Date.now() },
    timeout: TIMEOUT_MS,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'text/html, */*',
      ...(typeof bpexchHeaders === 'function' ? bpexchHeaders() : {}),
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    validateStatus: s => s < 500,
  });
  if (res.status !== 200) throw new Error(`MarketHighlights HTTP ${res.status}`);
  const html = typeof res.data === 'string' ? res.data : String(res.data || '');
  if (!html || html.length < 200) throw new Error('MarketHighlights empty/short body');
  if (html.includes('Just a moment') || /cf-browser-verification/i.test(html)) {
    throw new Error('MarketHighlights cloudflare challenge');
  }
  return html;
}

async function getHighlightsHtml() {
  if (_highlightsHtmlCache && Date.now() < _highlightsHtmlExpiry) return _highlightsHtmlCache;
  try {
    const html = await fetchHighlightsHtml();
    _highlightsHtmlCache = html;
    _highlightsHtmlExpiry = Date.now() + HIGHLIGHTS_CACHE_TTL_MS;
    _highlightsFailStreak = 0;
    return html;
  } catch (err) {
    _highlightsFailStreak = (_highlightsFailStreak || 0) + 1;
    logger.warn(`[bpexch] highlights fetch fail #${_highlightsFailStreak}: ${err.message}`);
    // Short grace: stale cache better than empty
    if (_highlightsHtmlCache && _highlightsFailStreak < 5) {
      _highlightsHtmlExpiry = Date.now() + 2000;
      return _highlightsHtmlCache;
    }
    // Repeated fails → hard reset session + caches (self-heal, no restart)
    if (_highlightsFailStreak >= 3) {
      _bpexchCookie = '';
      _bpexchCookieExpiry = 0;
      _highlightsHtmlCache = null;
      _highlightsHtmlExpiry = 0;
      _highlightsJsonCache = null;
      _highlightsJsonExpiry = 0;
      _matchOddsLookupPromise = null;
      try { await ensureBpexchSession(); } catch (_) {}
    }
    throw err;
  }
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

// Race slider — multiple HTML shapes (bpexch changes markup often)
// Original working pattern + looser fallbacks
const RACE_ITEM_RE = /href="\/Common\/Event\/([^"?#]+)(?:\?[^"]*)?"[\s\S]*?utctime[^>]*>\s*([^<]*?)\s*<\/span>[\s\S]*?slidename['"]?\s*>\s*([^<]+?)\s*<\/span>/gi;
const RACE_ITEM_RE2 = /href="\/Common\/Event\/(?:\?id=)?([^"?#]+)"[\s\S]{0,600}?slidename['"]?\s*>\s*([^<]+?)\s*<\/span>/gi;
const RACE_ITEM_RE3 = /href="\/Common\/Event\/([^"?#]+)"[^>]*>[\s\S]{0,200}?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)[\s\S]{0,200}?([A-Za-z][^<]{2,40})\s*<\/span>/gi;

function normalizeRaceStart(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s || /^in[\s-]?play$/i.test(s) || s === '-' || s === '--') return null;
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const d = new Date();
    const parts = s.split(':').map(Number);
    d.setHours(parts[0], parts[1], parts[2] || 0, 0);
    return d.toISOString();
  }
  // "Aug 23 3:10 AM" style
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 2020 || y > 2100) return null;
  return d.toISOString();
}

function parseRaceItems(sectionHtml, eventTypeId) {
  const items = [];
  const seen = new Set();
  const html = sectionHtml || '';

  function push(id, startRaw, venueRaw) {
    id = decodeURIComponent(String(id || '').trim());
    if (!id || seen.has(id)) return;
    // must look like race composite id OR numeric event
    if (!/^\d{5,}(\.\d+)?$/.test(id)) return;
    seen.add(id);
    const venue = String(venueRaw || 'Race').replace(/\s+/g, ' ').trim();
    const startIso = normalizeRaceStart(startRaw) || null;
    if (startIso) {
      const t = new Date(startIso).getTime();
      const now = Date.now();
      if (!isNaN(t)) {
        if (t < now - 72 * 3600 * 1000) return;
        if (t > now + 96 * 3600 * 1000) return;
      }
    }
    items.push({
      id,
      name: `${venue} - Win`,
      start: startIso || new Date(Date.now() + 30 * 60000).toISOString(),
      eventTypeId: String(eventTypeId),
      inPlay: false,
      matched: 0,
      competition: null,
      event: {
        id,
        name: venue,
        countryCode: null,
        venue,
        openDate: startIso || new Date(Date.now() + 30 * 60000).toISOString(),
      },
      runners: [],
    });
  }

  let m;
  RACE_ITEM_RE.lastIndex = 0;
  while ((m = RACE_ITEM_RE.exec(html)) !== null) {
    push(m[1], m[2], m[3]);
  }
  if (items.length < 3) {
    RACE_ITEM_RE2.lastIndex = 0;
    while ((m = RACE_ITEM_RE2.exec(html)) !== null) {
      push(m[1], null, m[2]);
    }
  }
  if (items.length < 3) {
    RACE_ITEM_RE3.lastIndex = 0;
    while ((m = RACE_ITEM_RE3.exec(html)) !== null) {
      push(m[1], m[2], m[3]);
    }
  }
  // Last resort: any /Common/Event/digits.digits link in section
  if (items.length === 0) {
    const loose = /\/Common\/Event\/(\d{6,}\.\d+)/g;
    while ((m = loose.exec(html)) !== null) {
      push(m[1], null, 'Race');
    }
  }

  logger.info(`[bpexch] parseRaceItems eventTypeId=${eventTypeId} races=${items.length} htmlLen=${html.length}`);
  return items;
}

async function scrapeBpexchRaceEventPage(raceId) {
  const id = String(raceId || '').trim();
  if (!id) return null;
  await ensureBpexchSession();

  // 1) Prefer catalog2 (real runner names + cloth/jockey when available)
  try {
    const cat = await fetchBpexchCatalog2(id);
    if (cat && Array.isArray(cat.runners) && cat.runners.length) {
      const clean = cat.runners
        .map((r, i) => sanitizeRaceRunner(r, i))
        .filter(Boolean);
      if (clean.length) {
        logger.info(`[bpexch] race ${id} catalog2 runners=${clean.length}`);
        return {
          ...cat,
          marketId: cat.marketId || id,
          marketName: cat.marketName || 'Win',
          marketType: cat.marketType || 'WIN',
          eventId: id,
          eventName: cat.eventName || cat.event?.name || cat.marketName,
          eventTypeId: String(cat.eventTypeId || cat.sport?.id || '7'),
          eventType: cat.eventType || cat.sport?.name || 'Horse Racing',
          marketStartTime: cat.marketStartTime || cat.marketStartTimeUtc,
          runners: clean,
          subMarkets: [],
          source: 'bpexch-catalog2',
        };
      }
    }
  } catch (e) {
    logger.warn(`[bpexch] race catalog2 ${id}: ${e.message}`);
  }

  // 2) Scrape Event HTML for runner list (strict name filter — no Vue/score junk)
  const urls = [
    `${BPEXCH_BASE_URL}/Common/Event/${encodeURIComponent(id)}`,
    `${BPEXCH_BASE_URL}/Common/Event?id=${encodeURIComponent(id)}`,
  ];
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: bpexchHeaders({ Accept: 'text/html,application/xhtml+xml' }),
        validateStatus: s => s < 500,
        maxRedirects: 5,
      });
      if (res.status !== 200 || typeof res.data !== 'string') continue;
      const html = res.data;
      if (res.headers['set-cookie']) {
        _bpexchCookie = mergeSetCookie(_bpexchCookie, res.headers['set-cookie']);
      }

      let eventName = null;
      const titleM = html.match(/<h[12][^>]*>\s*([^<]{3,100})\s*<\/h[12]>/i)
        || html.match(/class="[^"]*(?:event-name|race-name|market-title)[^"]*"[^>]*>\s*([^<]{3,100})/i);
      if (titleM) eventName = titleM[1].replace(/\s+/g, ' ').trim();

      let startIso = null;
      const timeM = html.match(/utctime[^>]*>\s*([^<]+)/i)
        || html.match(/data-(?:utc|start)=["']([^"']+)["']/i);
      if (timeM) startIso = normalizeRaceStart(timeM[1]);

      const runners = [];
      const seen = new Set();

      // JSON: "runnerName":"Dog Name" / "selectionId":123
      const pairRe = /\{\s*"selectionId"\s*:\s*(\d+)[\s\S]{0,400}?"runnerName"\s*:\s*"([^"]{2,80})"/gi;
      let pm;
      while ((pm = pairRe.exec(html)) !== null) {
        const r = sanitizeRaceRunner({
          selectionId: Number(pm[1]),
          runnerName: pm[2],
        }, runners.length);
        if (!r || seen.has(r.selectionId)) continue;
        seen.add(r.selectionId);
        runners.push(r);
      }
      // reverse order fields
      if (!runners.length) {
        const pairRe2 = /\{\s*"runnerName"\s*:\s*"([^"]{2,80})"[\s\S]{0,400}?"selectionId"\s*:\s*(\d+)/gi;
        while ((pm = pairRe2.exec(html)) !== null) {
          const r = sanitizeRaceRunner({
            selectionId: Number(pm[2]),
            runnerName: pm[1],
          }, runners.length);
          if (!r || seen.has(r.selectionId)) continue;
          seen.add(r.selectionId);
          runners.push(r);
        }
      }

      // data-runner-name / cloth attributes
      if (!runners.length) {
        const attrRe = /data-(?:runner-?name|name)=["']([^"']{2,60})["'][^>]*(?:data-(?:selection|id)=["'](\d+)["'])?/gi;
        while ((pm = attrRe.exec(html)) !== null) {
          const r = sanitizeRaceRunner({
            selectionId: pm[2] ? Number(pm[2]) : runners.length + 1,
            runnerName: pm[1],
          }, runners.length);
          if (!r || seen.has(r.runnerName.toLowerCase())) continue;
          seen.add(r.runnerName.toLowerCase());
          runners.push(r);
        }
      }

      // Trap/cloth number + name: "1. Ringo" or "(1) Ringo"
      if (!runners.length) {
        const clothRe = /(?:^|>|\s)(\d{1,2})\s*[.)]\s*([A-Za-z][A-Za-z0-9' .\-]{1,40})(?:\s*<|\s*\(|$)/gm;
        while ((pm = clothRe.exec(html)) !== null && runners.length < 24) {
          const r = sanitizeRaceRunner({
            selectionId: Number(pm[1]),
            clothNumber: pm[1],
            runnerName: pm[2].trim(),
          }, runners.length);
          if (!r || seen.has(r.runnerName.toLowerCase())) continue;
          seen.add(r.runnerName.toLowerCase());
          runners.push(r);
        }
      }

      if (!runners.length) {
        logger.warn(`[bpexch] race page ${id} no clean runners`);
        continue;
      }

      // Detect greyhound vs horse from page text
      const isGrey = /grey\s*hound|greyhound/i.test(html) || /Healesville|Capalaba|Angle Park/i.test(html + (eventName || ''));
      const eventTypeId = isGrey ? '4339' : '7';

      logger.info(`[bpexch] race page ${id} scraped runners=${runners.length} type=${eventTypeId}`);
      return {
        marketId: id,
        marketName: 'Win',
        marketType: 'WIN',
        marketStartTime: startIso,
        marketStartTimeUtc: startIso,
        eventId: id,
        eventName: eventName || 'Race',
        eventTypeId,
        eventType: isGrey ? 'Greyhound Racing' : 'Horse Racing',
        status: 'OPEN',
        runners: runners.map(r => ({ ...r, back: r.back || [], lay: r.lay || [] })),
        subMarkets: [],
        source: 'bpexch-race-html',
      };
    } catch (err) {
      logger.warn(`[bpexch] race page ${id}: ${err.message}`);
    }
  }
  return null;
}

/** Reject Vue templates / score fields / junk as runner names */
function sanitizeRaceRunner(r, index) {
  if (!r) return null;
  let name = String(r.runnerName || r.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length < 2 || name.length > 60) return null;
  if (/\{\{|\}|scores\.|^\{\s*gs|runner-score|v-if|v-for/i.test(name)) return null;
  if (/^(back|lay|odds|price|size|win|place|market|runner|selection)$/i.test(name)) return null;
  if (/^[\d.\s]+$/.test(name)) return null;
  const sid = Number(r.selectionId || r.id || index + 1);
  let cloth = r.clothNumber || r.trapNumber || null;
  if (cloth == null && sid >= 1 && sid <= 20) cloth = String(sid);
  // metadata may hold COLOURS / cloth
  let meta = r.metadata;
  if (typeof meta === 'string') {
    try { meta = JSON.parse(meta); } catch (_) { meta = {}; }
  }
  meta = meta || {};
  return {
    selectionId: sid,
    runnerName: name,
    handicap: Number(r.handicap) || 0,
    sortPriority: Number(r.sortPriority) || index + 1,
    status: r.status || 'ACTIVE',
    clothNumber: cloth || meta.CLOTH_NUMBER || meta.clothNumber || null,
    silkColor: r.silkColor || r.clothColor || null,
    jockeyName: r.jockeyName || meta.JOCKEY_NAME || '',
    trainerName: r.trainerName || meta.TRAINER_NAME || '',
    metadata: meta,
    back: Array.isArray(r.back) ? r.back : [],
    lay: Array.isArray(r.lay) ? r.lay : [],
  };
}


async function getRacingHighlights(eventTypeId) {
  const html = await getHighlightsHtml();
  let horseSection     = sliceBetweenMarkers(html, 'Horse Race', 'Grey Hound');
  let greyhoundSection = sliceBetweenMarkers(html, 'Grey Hound', 'TABS SYSTEM');
  if (!horseSection || horseSection.length < 80) {
    horseSection = sliceBetweenMarkers(html, 'Horse Racing', 'Grey')
      || sliceBetweenMarkers(html, 'Horse', 'Grey')
      || horseSection;
  }
  if (!greyhoundSection || greyhoundSection.length < 80) {
    greyhoundSection = sliceBetweenMarkers(html, 'Greyhound', 'TAB')
      || sliceBetweenMarkers(html, 'Grey Hound', 'TAB')
      || sliceBetweenMarkers(html, 'Grey', 'TAB')
      || greyhoundSection;
  }
  // Always also parse full page for composite race links (section markers often break)
  const full = html || '';
  if (!horseSection || horseSection.length < 80) horseSection = full;
  if (!greyhoundSection || greyhoundSection.length < 80) greyhoundSection = full;
  logger.info(`[bpexch] racing sections horseLen=${(horseSection||'').length} greyLen=${(greyhoundSection||'').length} htmlLen=${full.length}`);

  if (eventTypeId != null) {
    if (isHorseRacingEventType(eventTypeId)) {
      const a = parseRaceItems(horseSection, eventTypeId);
      const b2 = a.length ? a : parseRaceItems(full, eventTypeId);
      return b2;
    }
    if (isGreyhoundEventType(eventTypeId)) {
      const a = parseRaceItems(greyhoundSection, eventTypeId);
      const b2 = a.length ? a : parseRaceItems(full, eventTypeId);
      return b2;
    }
    return [];
  }
  // both sports
  let horse = parseRaceItems(horseSection, resolveHorseRacingId());
  let grey = parseRaceItems(greyhoundSection, resolveGreyhoundId());
  if (!horse.length) horse = parseRaceItems(full, resolveHorseRacingId());
  if (!grey.length) grey = parseRaceItems(full, resolveGreyhoundId());
  // If both used full page, ids may overlap — keep assignment by section when possible
  return [...horse, ...grey];
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

function dedupeMarketsById(items) {
  const seen = new Set();
  const out = [];
  for (const m of items) {
    const id = String(m.id || m.marketId || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(m);
  }
  return out;
}

async function getSportsHighlights(eventTypeId) {
  // PRIMARY: markethighlights JSON API
  const jsonItems = await getSportsHighlightsFromJson(eventTypeId);
  if (jsonItems !== null) return dedupeMarketsById(jsonItems);

  // FALLBACK: HTML scraping (original)
  // Multiple high_lights blocks can repeat the same match (InPlay + Today)
  // → dedupe by market id so dashboard / live APIs don't show duplicates.
  const html = await getHighlightsHtml();
  const sections = parseMatchOddsSections(html);
  let items;
  if (eventTypeId != null) {
    const wanted = String(eventTypeId);
    items = sections.filter(s => String(s.eventTypeId) === wanted).flatMap(s => s.items);
  } else {
    items = sections.flatMap(s => s.items);
  }
  const deduped = dedupeMarketsById(items);
  if (deduped.length !== items.length) {
    logger.info(`[bpexch] deduped highlights ${items.length} → ${deduped.length} (eventTypeId=${eventTypeId ?? 'all'})`);
  }
  return deduped;
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
      // Racing: soft window — keep if start missing; widen by 2h/6h
      if (!isNaN(startMs)) {
        if (fromMs !== null && startMs < fromMs - 2 * 3600 * 1000) { droppedTime++; return; }
        if (toMs   !== null && startMs > toMs + 6 * 3600 * 1000)   { droppedTime++; return; }
      }
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

  let sliced = items.slice(0, parseInt(maxResults, 10) || 20);
  if (!sliced.length) return [];

  // Racing / empty runners: fill names from bpexch catalog2
  for (let i = 0; i < sliced.length; i++) {
    if ((sliced[i].runners || []).length) continue;
    try {
      const cat = await fetchBpexchCatalog2(sliced[i].id);
      if (cat?.runners?.length) {
        sliced[i] = {
          ...sliced[i],
          name: cat.marketName || sliced[i].name,
          runners: cat.runners.map((r, idx) => ({
            selectionId: Number(r.selectionId ?? r.id ?? idx + 1),
            runnerName: r.runnerName || r.name || `Runner ${idx + 1}`,
            sortPriority: r.sortPriority || idx + 1,
            handicap: r.handicap || 0,
            metadata: r.metadata || {},
          })),
        };
      }
    } catch (_) { /* ignore */ }
  }

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
      return new Map((items || []).map(it => [String(it.id), it]));
    } catch (err) {
      logger.warn(`[bpexch] match-odds lookup for listMarketBook failed: ${err.message}`);
      return new Map();
    } finally {
      // Always clear so next call can retry (no hours-long stuck promise)
      setTimeout(() => { _matchOddsLookupPromise = null; }, Math.min(HIGHLIGHTS_CACHE_TTL_MS, 4000));
    }
  })();
  return _matchOddsLookupPromise;
}

async function listMarketBook(marketIds = [], priceProjection) {
  if (!marketIds.length) return [];

  const lookup = await getMatchOddsLookup();

  const results = [];
  for (const id of marketIds) {
    const key = String(id);
    const norm = (typeof normalizeMarketId === 'function' ? normalizeMarketId(key) : key) || key;
    const item = lookup.get(key) || lookup.get(norm) || lookup.get(String(norm).replace(/^1\./, 'm_1_'));
    if (item && (item.runners || []).length) {
      results.push({
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
      });
      continue;
    }

    // Horse / Greyhound / missing odds — try bpexch catalog2 for runners
    let runners = [];
    let inplay = false;
    let matched = 0;
    try {
      const cat = await fetchBpexchCatalog2(key);
      if (cat && Array.isArray(cat.runners) && cat.runners.length) {
        runners = cat.runners.map((r, i) => ({
          selectionId: Number(r.selectionId ?? r.id ?? i + 1),
          status: r.status || 'ACTIVE',
          lastPriceTraded: null,
          ex: {
            availableToBack: (r.back || []).slice(0, 3).map(b => ({
              price: b.price ?? b, size: b.size || 0,
            })),
            availableToLay: (r.lay || []).slice(0, 3).map(l => ({
              price: l.price ?? l, size: l.size || 0,
            })),
          },
        }));
        // catalog2 rarely has ladder — still expose runner names for UI
        if (!runners.some(r => (r.ex.availableToBack || []).length)) {
          runners = cat.runners.map((r, i) => ({
            selectionId: Number(r.selectionId ?? r.id ?? i + 1),
            status: r.status || 'ACTIVE',
            lastPriceTraded: null,
            ex: { availableToBack: [], availableToLay: [] },
          }));
        }
        matched = cat.totalMatched || 0;
        logger.info(`[listMarketBook] catalog2 runners=${runners.length} for ${key}`);
      }
    } catch (e) {
      logger.warn(`[listMarketBook] catalog2 for ${key}: ${e.message}`);
    }

    results.push({
      marketId: id,
      status: 'OPEN',
      inplay,
      betDelay: 0,
      totalMatched: matched,
      runners,
      scoreboard: null,
    });
  }
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

/* ── getRunnerBook (orders.js compatible) ─────────────────
   Order matching needs a live ladder. Prefer listMarketBook, then
   catalog2, then prices7. Always return a runner shell if selection
   is known so evaluateMatch can auto-match when ladder is empty.
──────────────────────────────────────────────────────────── */
async function getRunnerBook(marketId, selectionId) {
  const sel = Number(selectionId);
  const key = String(marketId);

  const pickRunner = (runners) => {
    if (!Array.isArray(runners)) return null;
    return runners.find(r => Number(r.selectionId) === sel || String(r.selectionId) === String(selectionId)) || null;
  };

  try {
    // 1) listMarketBook (highlights / catalog2)
    const books = await listMarketBook([key]);
    if (books?.length) {
      const r = pickRunner(books[0].runners);
      if (r) {
        const backs = r.ex?.availableToBack || [];
        const lays  = r.ex?.availableToLay  || [];
        if (backs.length || lays.length) return r;
        // keep as fallback if nothing better
      }
    }

    // 2) catalog2 direct
    try {
      const cat = await fetchBpexchCatalog2(key);
      if (cat && Array.isArray(cat.runners)) {
        const raw = cat.runners.find(r =>
          Number(r.selectionId ?? r.id) === sel || String(r.selectionId ?? r.id) === String(selectionId)
        );
        if (raw) {
          const back = (raw.back || []).map(b => ({ price: Number(b.price ?? b), size: Number(b.size) || 0 }));
          const lay  = (raw.lay  || []).map(l => ({ price: Number(l.price ?? l), size: Number(l.size) || 0 }));
          // price1 style
          if (!back.length && (raw.price1 || raw.price2 || raw.price3)) {
            if (raw.price1) back.push({ price: Number(raw.price1), size: Number(raw.size1) || 0 });
            if (raw.price2) back.push({ price: Number(raw.price2), size: Number(raw.size2) || 0 });
            if (raw.price3) back.push({ price: Number(raw.price3), size: Number(raw.size3) || 0 });
          }
          if (!lay.length && (raw.lay1 || raw.lay2 || raw.lay3)) {
            if (raw.lay1) lay.push({ price: Number(raw.lay1), size: Number(raw.ls1) || 0 });
            if (raw.lay2) lay.push({ price: Number(raw.lay2), size: Number(raw.ls2) || 0 });
            if (raw.lay3) lay.push({ price: Number(raw.lay3), size: Number(raw.ls3) || 0 });
          }
          return {
            selectionId: sel,
            status: raw.status || 'ACTIVE',
            ex: { availableToBack: back, availableToLay: lay },
          };
        }
      }
    } catch (e) {
      logger.warn(`[getRunnerBook] catalog2 ${key}: ${e.message}`);
    }

    // 3) prices7 live book (if token available)
    try {
      const token = process.env.PRICES7_TOKEN || '';
      if (token) {
        const live = await fetchPrices7MarketData(key, token);
        const book = live?.marketBooks?.[0];
        if (book && Array.isArray(book.runners)) {
          const lr = book.runners.find(r => Number(r.id) === sel || String(r.id) === String(selectionId));
          if (lr) {
            const ladder = prices7RunnerToLadder(lr);
            return {
              selectionId: sel,
              status: lr.status || 'ACTIVE',
              ex: {
                availableToBack: ladder.back || [],
                availableToLay:  ladder.lay  || [],
              },
            };
          }
        }
      }
    } catch (e) {
      logger.warn(`[getRunnerBook] prices7 ${key}: ${e.message}`);
    }

    // 4) Runner shell — lets evaluateMatch auto-match at taken price
    logger.info(`[getRunnerBook] shell runner for ${key}/${selectionId}`);
    return {
      selectionId: sel,
      status: 'ACTIVE',
      ex: { availableToBack: [], availableToLay: [] },
    };
  } catch (err) {
    logger.warn(`getRunnerBook failed for ${marketId}/${selectionId}: ${err.message}`);
    // still return shell so bets can match
    return {
      selectionId: sel || 0,
      status: 'ACTIVE',
      ex: { availableToBack: [], availableToLay: [] },
    };
  }
}


/* ═══════════════════════════════════════════════════════════════════
   bpexch catalog2 / catalogs / live Data — market page ke liye
   (Bookmaker, Fancy, Figure, Over/Under, scoreboard, commentary)
   Auth: optional BPEXCH_USERNAME / BPEXCH_PASSWORD login → cookies
   ═══════════════════════════════════════════════════════════════════ */

const PRICES7_BASE = process.env.PRICES7_BASE_URL || 'https://prices7.mgs11.com';

// Defaults: user provided live bpexch account (override via env in production)
const BPEXCH_USER = process.env.BPEXCH_USERNAME || process.env.BPEXCH_USER || '14Boss5555';
const BPEXCH_PASS = process.env.BPEXCH_PASSWORD || process.env.BPEXCH_PASS || 'Boss1234';

let _bpexchCookie = '';
let _bpexchCookieExpiry = 0;
let _bpexchLoginPromise = null;

function mergeSetCookie(existing, setCookieHeader) {
  const jar = {};
  String(existing || '')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean)
    .forEach(pair => {
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i)] = pair.slice(i + 1);
    });
  const list = Array.isArray(setCookieHeader) ? setCookieHeader : (setCookieHeader ? [setCookieHeader] : []);
  for (const line of list) {
    const first = String(line).split(';')[0];
    const i = first.indexOf('=');
    if (i > 0) jar[first.slice(0, i).trim()] = first.slice(i + 1).trim();
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function bpexchHeaders(extra = {}) {
  return {
    Accept: 'application/json, text/html, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${BPEXCH_BASE_URL}/Common/Dashboard`,
    Origin: BPEXCH_BASE_URL,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ...(_bpexchCookie ? { Cookie: _bpexchCookie } : {}),
    ...extra,
  };
}

/**
 * Login to bpexch.live so catalog2/catalogs return full market data.
 * Env: BPEXCH_USERNAME / BPEXCH_PASSWORD
 */
async function ensureBpexchSession() {
  if (_bpexchCookie && Date.now() < _bpexchCookieExpiry) return _bpexchCookie;
  if (!BPEXCH_USER || !BPEXCH_PASS) {
    logger.warn('[bpexch] no BPEXCH_USERNAME/PASSWORD — catalog2 may be limited');
    return _bpexchCookie || '';
  }
  if (_bpexchLoginPromise) return _bpexchLoginPromise;

  _bpexchLoginPromise = (async () => {
    try {
      // 1) GET login page for antiforgery token
      const loginPageUrl = `${BPEXCH_BASE_URL}/Users/Login`;
      const pageRes = await axios.get(loginPageUrl, {
        timeout: TIMEOUT_MS,
        headers: bpexchHeaders({ Accept: 'text/html' }),
        maxRedirects: 5,
        validateStatus: s => s < 500,
      });
      _bpexchCookie = mergeSetCookie(_bpexchCookie, pageRes.headers['set-cookie']);

      const html = typeof pageRes.data === 'string' ? pageRes.data : '';
      const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)
        || html.match(/value="([^"]+)"[^>]*name="__RequestVerificationToken"/i);
      const antiForgery = tokenMatch ? tokenMatch[1] : '';

      // 2) POST credentials
      const body = new URLSearchParams();
      body.set('user.Username', BPEXCH_USER);
      body.set('user.Password', BPEXCH_PASS);
      body.set('Device', 'Google Chrome');
      body.set('UtcOffset', '300');
      if (antiForgery) body.set('__RequestVerificationToken', antiForgery);

      const postRes = await axios.post(loginPageUrl, body.toString(), {
        timeout: TIMEOUT_MS,
        headers: bpexchHeaders({
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: loginPageUrl,
        }),
        maxRedirects: 0,
        validateStatus: s => s < 500,
      });
      _bpexchCookie = mergeSetCookie(_bpexchCookie, postRes.headers['set-cookie']);

      // follow redirect manually if 302
      if (postRes.status >= 300 && postRes.status < 400 && postRes.headers.location) {
        const loc = postRes.headers.location.startsWith('http')
          ? postRes.headers.location
          : `${BPEXCH_BASE_URL}${postRes.headers.location}`;
        const follow = await axios.get(loc, {
          timeout: TIMEOUT_MS,
          headers: bpexchHeaders(),
          maxRedirects: 5,
          validateStatus: s => s < 500,
        });
        _bpexchCookie = mergeSetCookie(_bpexchCookie, follow.headers['set-cookie']);
      }

      _bpexchCookieExpiry = Date.now() + 20 * 60_000; // 20 min — refresh before session dies
      logger.info(`[bpexch] login OK cookieLen=${_bpexchCookie.length}`);
      // After login, try to obtain prices7 JWT (async, non-blocking for cookie return)
      refreshPrices7TokenFromSession().catch(e =>
        logger.warn(`[prices7] post-login token fetch: ${e.message}`)
      );
      return _bpexchCookie;
    } catch (err) {
      logger.warn(`[bpexch] login failed: ${err.message}`);
      return _bpexchCookie || '';
    } finally {
      _bpexchLoginPromise = null;
    }
  })();

  return _bpexchLoginPromise;
}

/**
 * Obtain / refresh prices7 JWT using bpexch session.
 * Strategies (in order):
 *  1) valid in-memory / env token
 *  2) scrape Dashboard HTML/JS for eyJ... JWT
 *  3) common token API endpoints
 *  4) cookie jar JWT fields
 */

// ── prices7 JWT cache + helpers ──
let _prices7Token = process.env.PRICES7_TOKEN || '';
let _prices7TokenExp = 0;
let _prices7RefreshPromise = null;
// seed exp from env token at boot
(function seedPrices7FromEnv() {
  if (!_prices7Token) return;
  try {
    const parts = String(_prices7Token).split('.');
    if (parts.length < 2) return;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (payload.exp) _prices7TokenExp = Number(payload.exp) * 1000;
  } catch (_) {}
})();

function parseJwtExpMs(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length < 2) return 0;
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (payload.exp) return Number(payload.exp) * 1000;
  } catch (_) {}
  return 0;
}

function isPrices7TokenValid(token) {
  const t = token || _prices7Token;
  if (!t) return false;
  const exp = (token ? parseJwtExpMs(token) : (_prices7TokenExp || parseJwtExpMs(t)));
  return exp > Date.now() + 120000; // 2 min buffer
}

function setPrices7Token(token, source) {
  if (!token || String(token).length < 40) return false;
  _prices7Token = String(token).trim();
  _prices7TokenExp = parseJwtExpMs(_prices7Token) || (Date.now() + 50 * 60 * 1000);
  logger.info(`[prices7] token cached source=${source || 'unknown'} exp=${new Date(_prices7TokenExp).toISOString()}`);
  return true;
}

function extractJwtFromText(text) {
  if (!text) return null;
  const s = String(text);
  const patterns = [
    /(?:prices?7?|market)?token["'\s:=]+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i,
    /["']token["']\s*:\s*["'](eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)["']/,
    /(?:accessToken|access_token|jwt|authToken)["'\s:=]+(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/i,
    /(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m && m[1] && m[1].startsWith('eyJ')) return m[1];
  }
  return null;
}

async function refreshPrices7TokenFromSession(force = false) {
  if (!force && isPrices7TokenValid()) return _prices7Token;
  if (_prices7RefreshPromise) return _prices7RefreshPromise;

  _prices7RefreshPromise = (async () => {
    try {
      await ensureBpexchSession();

      // Cookie jar may already hold a JWT
      const fromCookie = extractJwtFromText(_bpexchCookie);
      if (fromCookie && setPrices7Token(fromCookie, 'cookie')) return _prices7Token;

      // Common API endpoints used by exchange frontends
      const apiCandidates = [
        `${BPEXCH_BASE_URL}/api/Users/GetToken`,
        `${BPEXCH_BASE_URL}/api/User/GetToken`,
        `${BPEXCH_BASE_URL}/api/Account/Token`,
        `${BPEXCH_BASE_URL}/api/Account/GetToken`,
        `${BPEXCH_BASE_URL}/api/Auth/Token`,
        `${BPEXCH_BASE_URL}/api/markets/token`,
        `${BPEXCH_BASE_URL}/Users/GetToken`,
      ];
      for (const url of apiCandidates) {
        try {
          const res = await axios.get(url, {
            timeout: 10000,
            headers: bpexchHeaders({ Accept: 'application/json, text/plain, */*' }),
            validateStatus: s => s < 500,
          });
          if (res.headers['set-cookie']) {
            _bpexchCookie = mergeSetCookie(_bpexchCookie, res.headers['set-cookie']);
          }
          const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
          const jwt = extractJwtFromText(body) || extractJwtFromText(JSON.stringify(res.headers || {}));
          if (jwt && setPrices7Token(jwt, `api:${url.split('/').slice(-2).join('/')}`)) return _prices7Token;
        } catch (_) { /* try next */ }
      }

      // Dashboard / market page HTML often embeds token for prices7
      const pageUrls = [
        `${BPEXCH_BASE_URL}/Common/Dashboard`,
        `${BPEXCH_BASE_URL}/`,
        `${BPEXCH_BASE_URL}/Common/Home`,
      ];
      for (const url of pageUrls) {
        try {
          const res = await axios.get(url, {
            timeout: 15000,
            headers: bpexchHeaders({ Accept: 'text/html,application/xhtml+xml' }),
            validateStatus: s => s < 500,
            maxRedirects: 5,
          });
          if (res.headers['set-cookie']) {
            _bpexchCookie = mergeSetCookie(_bpexchCookie, res.headers['set-cookie']);
          }
          const html = typeof res.data === 'string' ? res.data : '';
          const jwt = extractJwtFromText(html);
          if (jwt && setPrices7Token(jwt, `page:${url.split('/').pop() || 'root'}`)) return _prices7Token;
        } catch (_) { /* try next */ }
      }

      // Cookie again after page hits
      const fromCookie2 = extractJwtFromText(_bpexchCookie);
      if (fromCookie2 && setPrices7Token(fromCookie2, 'cookie-after-page')) return _prices7Token;

      if (_prices7Token && isPrices7TokenValid()) return _prices7Token;
      logger.warn('[prices7] could not auto-extract JWT after bpexch login — set PRICES7_TOKEN or check login');
      return _prices7Token || '';
    } finally {
      _prices7RefreshPromise = null;
    }
  })();

  return _prices7RefreshPromise;
}



/* ── Keepalive: odds hours baad band hone se bachao ────────────────
   Har 12 min: bpexch re-login + prices7 JWT refresh + soft cache clear.
   Process restart ki zaroorat nahi padni chahiye.
─────────────────────────────────────────────────────────────────── */
let _bpexchKeepaliveTimer = null;
function startBpexchKeepalive() {
  if (_bpexchKeepaliveTimer) return;
  const EVERY_MS = parseInt(process.env.BPEXCH_KEEPALIVE_MS || String(12 * 60 * 1000), 10);
  _bpexchKeepaliveTimer = setInterval(async () => {
    try {
      logger.info('[bpexch] keepalive tick — refresh session + token + soft cache clear');
      _bpexchCookieExpiry = 0; // force re-login
      await ensureBpexchSession();
      try {
        if (typeof refreshPrices7TokenFromSession === 'function') {
          await refreshPrices7TokenFromSession(true);
        }
      } catch (e) {
        logger.warn(`[bpexch] keepalive prices7: ${e.message}`);
      }
      _highlightsHtmlExpiry = 0;
      _highlightsJsonExpiry = 0;
      _matchOddsLookupPromise = null;
      _highlightsFailStreak = 0;
    } catch (e) {
      logger.warn(`[bpexch] keepalive error: ${e.message}`);
    }
  }, EVERY_MS);
  if (typeof _bpexchKeepaliveTimer.unref === 'function') _bpexchKeepaliveTimer.unref();
  logger.info(`[bpexch] keepalive started every ${Math.round(EVERY_MS / 60000)} min`);
}
try { startBpexchKeepalive(); } catch (e) {
  logger.warn(`[bpexch] keepalive start failed: ${e.message}`);
}

/** Public: always returns a usable token if login works */
async function getPrices7Token(explicitToken) {
  if (explicitToken && isPrices7TokenValid(explicitToken)) {
    setPrices7Token(explicitToken, 'explicit');
    return explicitToken;
  }
  if (isPrices7TokenValid()) return _prices7Token;
  // seed from env once
  if (process.env.PRICES7_TOKEN && !isPrices7TokenValid()) {
    setPrices7Token(process.env.PRICES7_TOKEN, 'env');
    if (isPrices7TokenValid()) return _prices7Token;
  }
  return refreshPrices7TokenFromSession(true);
}

async function fetchBpexchCatalog2(marketId) {
  const id = normalizeMarketId(marketId);
  await ensureBpexchSession();
  const urls = [
    `${BPEXCH_BASE_URL}/api/markets/catalog2/?id=${encodeURIComponent(id)}`,
    `${BPEXCH_BASE_URL}/api/markets/catalog2?id=${encodeURIComponent(id)}`,
  ];
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: TIMEOUT_MS,
        headers: bpexchHeaders(),
        validateStatus: s => s < 500,
      });
      if (res.headers['set-cookie']) {
        _bpexchCookie = mergeSetCookie(_bpexchCookie, res.headers['set-cookie']);
      }
      if (res.status !== 200 || !res.data) {
        lastErr = `status=${res.status}`;
        continue;
      }
      // Cloudflare HTML challenge?
      if (typeof res.data === 'string' && res.data.includes('Just a moment')) {
        lastErr = 'cloudflare challenge';
        continue;
      }
      const d = res.data.data || res.data;
      if (!d || !(d.marketId || d.marketName)) {
        lastErr = `empty body keys=${typeof res.data === 'object' ? Object.keys(res.data||{}).join(',') : typeof res.data}`;
        continue;
      }
      return d;
    } catch (err) {
      lastErr = err.message;
    }
  }
  logger.warn(`[bpexch] catalog2 failed for ${id}: ${lastErr}`);
  return null;
}

async function fetchBpexchCatalogs(marketIds = []) {
  if (!marketIds.length) return [];
  await ensureBpexchSession();
  const url = `${BPEXCH_BASE_URL}/api/markets/catalogs/`;
  try {
    const res = await axios.get(url, {
      params: { ids: marketIds.join(',') },
      timeout: TIMEOUT_MS,
      headers: bpexchHeaders(),
      validateStatus: s => s < 500,
    });
    if (res.status !== 200) return [];
    const raw = res.data;
    if (Array.isArray(raw)) return raw;
    if (Array.isArray(raw?.data)) return raw.data;
    return [];
  } catch (err) {
    logger.warn(`[bpexch] catalogs failed: ${err.message}`);
    return [];
  }
}

/**
 * Scrape Event page HTML for market ids (1.xxx / 9.xxx) when catalogs
 * discovery has no prices7 token.
 */
async function discoverMarketIdsFromEventPage(eventId) {
  if (!eventId) return [];
  await ensureBpexchSession();
  try {
    const url = `${BPEXCH_BASE_URL}/Common/Event/${encodeURIComponent(eventId)}`;
    const res = await axios.get(url, {
      timeout: TIMEOUT_MS,
      headers: bpexchHeaders({ Accept: 'text/html' }),
      validateStatus: s => s < 500,
    });
    const html = typeof res.data === 'string' ? res.data : '';
    // ✅ FIX: pehle sirf CONTEXT-LABELED IDs (marketId=/MarketId:/query
    // param/JSON key ke sath) — ye pura page ke andar kisi UNRELATED
    // widget (jaise sidebar "Trending Matches") ke IDs ke sath confuse
    // hone ka risk kam karta hai. Loose bare "1.xxx kahin bhi" pattern
    // ab sirf LAST RESORT hai, aur sirf tab try hota hai jab labeled
    // patterns kuch na dein.
    const labeled = new Set();
    let m;
    const re = /(?:marketId|MarketId|data-market(?:-id)?|market_id)["'\s:=]+([19]\.\d{5,})/gi;
    while ((m = re.exec(html)) !== null) labeled.add(m[1]);
    const re2 = /[?&]id=([19]\.\d{5,})/g;
    while ((m = re2.exec(html)) !== null) labeled.add(m[1]);
    const re4 = /"marketId"\s*:\s*"([19]\.[0-9]+)"/g;
    while ((m = re4.exec(html)) !== null) labeled.add(m[1]);

    if (labeled.size) {
      logger.info(`[bpexch] event page ${eventId} discovered ${labeled.size} labeled market ids`);
      return [...labeled];
    }

    // Last resort — loose, no context. Risky (can pick up unrelated
    // sidebar/widget ids), so caller MUST validate before trusting this.
    const loose = new Set();
    const re3 = /\b([19]\.\d{6,})\b/g;
    while ((m = re3.exec(html)) !== null) loose.add(m[1]);
    logger.warn(`[bpexch] event page ${eventId} — no labeled ids, falling back to ${loose.size} loose ids (unverified)`);
    return [...loose];
  } catch (err) {
    logger.warn(`[bpexch] event page scrape failed: ${err.message}`);
    return [];
  }
}

async function fetchPrices7MarketData(marketId, token) {
  let tok = await getPrices7Token(token || null);
  if (!tok) {
    logger.warn('[prices7] no token after auto-refresh — login may have failed');
    return null;
  }
  try {
    const id = normalizeMarketId(marketId);
    const url = `${PRICES7_BASE}/api/Markets/Data`;
    const doFetch = async (t) => axios.get(url, {
      params: { id, token: t },
      timeout: TIMEOUT_MS,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://bpexch.live/',
        Origin: 'https://bpexch.live',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      validateStatus: s => s < 500,
    });

    let res = await doFetch(tok);
    // Expired / unauthorized → force re-login + new JWT once
    if (res.status === 401 || res.status === 403 ||
        (res.status === 200 && res.data && res.data.error && /token|auth|expir/i.test(String(res.data.error)))) {
      logger.warn(`[prices7] auth fail status=${res.status} — forcing token refresh`);
      _prices7Token = '';
      _prices7TokenExp = 0;
      _bpexchCookieExpiry = 0; // force session refresh too
      tok = await refreshPrices7TokenFromSession(true);
      if (!tok) return null;
      res = await doFetch(tok);
    }
    if (res.status !== 200 || !res.data) {
      logger.warn(`[prices7] status=${res.status} for ${id}`);
      return null;
    }
    // Some APIs return 200 with empty body on bad token
    const books = res.data.marketBooks || [];
    if (!books.length && res.data.message && /token|unauthorized/i.test(String(res.data.message))) {
      logger.warn('[prices7] empty books + token error — refresh retry');
      _prices7Token = '';
      _prices7TokenExp = 0;
      tok = await refreshPrices7TokenFromSession(true);
      if (tok) {
        res = await doFetch(tok);
        return res.data || null;
      }
    }
    logger.info(`[prices7] Data OK ${id} books=${books.length}`);
    return res.data;
  } catch (err) {
    logger.warn(`[prices7] Data fetch failed for ${marketId}: ${err.message}`);
    return null;
  }
}

/** Map prices7 runner → { back, lay } ladder */
function prices7RunnerToLadder(lr) {
  if (!lr) return { back: [], lay: [] };
  const back = [
    lr.price1 != null ? { price: lr.price1, size: lr.size1 || 0 } : null,
    lr.price2 != null ? { price: lr.price2, size: lr.size2 || 0 } : null,
    lr.price3 != null ? { price: lr.price3, size: lr.size3 || 0 } : null,
  ].filter(Boolean);
  const lay = [
    lr.lay1 != null ? { price: lr.lay1, size: lr.ls1 || 0 } : null,
    lr.lay2 != null ? { price: lr.lay2, size: lr.ls2 || 0 } : null,
    lr.lay3 != null ? { price: lr.lay3, size: lr.ls3 || 0 } : null,
  ].filter(Boolean);
  return { back, lay, status: lr.status || 'ACTIVE' };
}

function categorizeSubMarket(c) {
  const t = String(c.marketType || '').toUpperCase();
  const n = String(c.marketName || '').toLowerCase();
  // Match Odds / Winner are NEVER bookmaker even if isBmMarket flag is weirdly true
  if (t === 'MATCH_ODDS' || t === 'WINNER' || t === 'WIN' || n === 'match odds') return 'matchOdds';
  if (t === 'BOOKMAKER' || t === 'BOOKMAKER2' || n.includes('bookmaker')) return 'bookmaker';
  if (c.isBmMarket && !t.includes('MATCH') && !n.includes('match odds')) return 'bookmaker';
  if (t === 'TOSS' || n.includes('toss')) return 'toss';
  if (t === 'FANCY2' || t === 'LOCAL_FANCY' || n.includes('fancy 2') || n.includes('fancy-2')) return 'fancy2';
  if (t === 'FIGURE' || (n.includes('figure') && !n.includes('odd'))) return 'figure';
  if (t === 'ODD_FIGURE' || t === 'EVEN_ODD' || n.includes('odd figure') || n.includes('even odd')) return 'oddFigure';
  if (t.includes('FANCY') || n.includes('fancy') || n.includes('session') || n.includes('innings')) return 'fancy';
  if (n.includes('over') || n.includes('under') || t.includes('OVER') || t.includes('UNDER') || t.includes('TOTAL') || t.includes('HANDICAP') || t.includes('CORRECT')) return 'other';
  return 'other';
}

/**
 * Full market page — exact bpexch flow:
 *   1) catalog2(id)           → names, eventId, runner list
 *   2) prices7 Data(id,token) → live odds + related marketBooks ids
 *   3) catalogs(ids)          → Over/Under / Bookmaker / Fancy structure
 * Merge (2) prices onto (1)/(3) runners by selectionId.
 */
// ✅ SHARED helper — composite race id (eventId.raceNumber, jaise
// "36002580.0805") ko VERIFIED real Betfair-style marketId ("1.xxx")
// mein resolve karta hai. Discover karta hai event page se candidate
// IDs, phir har candidate ka catalog2 fetch karke uska eventTypeId
// check karta hai (7=Horse, 4339=Greyhound) — isse galat-sport ka
// market kabhi accept nahi hota. getBpexchMarketPage() aur controller
// ke getMarketData() dono isi function ko use karte hain (duplicate
// logic na ho, aur dono jagah same verification guarantee mile).
//
// 🐛 BUG FIX: pehle `.split('.')[0]` se sirf integer hissa (e.g.
// "36002580") event page ko bheja jaata tha — lekin bpexch ke apne
// markethighlights se confirm hua ke ye integer sirf ek MEETING-level
// number hai, poore din ke KAI ALAG races isko share karte hain
// (e.g. 36002580.0714, 36002580.0729, 36002580.0745, 36002580.0805 —
// sab alag races, same integer prefix). Sirf ".HHMM" suffix hi race ko
// uniquely identify karta hai. Integer-only URL ek generic/ambiguous
// page deta tha jisme kabhi-kabhi bilkul dusre sport ke market-ids mil
// jaate the (isi liye "wrong sport eventTypeId=4" jaisi rejections aa
// rahi thi). Fix: FULL composite id (dot ke sath) event page ko bhejo —
// bpexch ke apne links (/Common/Event/36002580.0805) bhi isi format mein
// hain, yehi asal race-specific page hai.
async function resolveRealRaceMarketId(compositeId) {
  const fullId = String(compositeId);
  const integerOnlyId = fullId.split('.')[0];

  // Primary: full composite id — race-specific page (matches bpexch's
  // own /Common/Event/ link format exactly).
  let discovered = await discoverMarketIdsFromEventPage(fullId);

  // Fallback: integer-only id, sirf tab jab full-id page kuch na de
  // (defensive — kabhi bpexch redirect kar de to bhi kuch mile).
  if (!discovered.length && integerOnlyId !== fullId) {
    logger.warn(`[bpexch] race composite ${fullId} — full-id page empty, trying integer-only ${integerOnlyId} as fallback`);
    discovered = await discoverMarketIdsFromEventPage(integerOnlyId);
  }

  const candidates = [
    ...discovered.filter(id => id.startsWith('1.')),
    ...discovered.filter(id => !id.startsWith('1.')),
  ];
  for (const cand of candidates) {
    try {
      const probe = await fetchBpexchCatalog2(cand);
      const probeType = String(probe?.eventTypeId || probe?.sport?.id || '');
      if (probe && ['7', '4339'].includes(probeType)) {
        return { realId: cand, catalog2: probe };
      }
      if (probe) {
        logger.warn(`[bpexch] race composite ${compositeId} — candidate ${cand} rejected, wrong sport (eventTypeId=${probeType})`);
      }
    } catch (_) { /* try next candidate */ }
  }
  return { realId: null, catalog2: null };
}

async function getBpexchMarketPage(marketId, pricesToken) {
  const normalizedId = normalizeMarketId(marketId);

  // ✅ FIX: Composite race ids (jaise "36002580.0607") bpexch ke apne
  // eventId.raceNumber navigation-id hain — REAL marketId nahi. Real
  // Betfair-style marketId ("1.xxxxxxxxx") event page ke andar embedded
  // hota hai, jaisa browser DevTools se confirm hua (prices7/Data call
  // asal mein "1.261686353" jaisi ID use kar rahi thi, composite ID
  // nahi). Pehle resolveRealRaceMarketId() se real ID nikaalte hain,
  // phir NORMAL catalog2+prices7 flow use karte hain — wahi jo baaki
  // sports (cricket/tennis/football) ke liye already proven kaam kar
  // raha hai. Purana scrapeBpexchRaceEventPage() (fragile HTML
  // guessing) sirf last-resort fallback ke tor pe rakha hai.
  const isRaceComposite = /^\d{6,}\.\d+$/.test(String(normalizedId));
  let resolvedId = normalizedId;
  let mainFromProbe = null;
  if (isRaceComposite) {
    const { realId, catalog2 } = await resolveRealRaceMarketId(normalizedId);
    if (realId) {
      logger.info(`[bpexch] race composite ${normalizedId} → verified real marketId ${realId}`);
      resolvedId = realId;
      mainFromProbe = catalog2;
    } else {
      logger.warn(`[bpexch] race composite ${normalizedId} — no verified racing marketId found, falling back to HTML scrape`);
      const racePage = await scrapeBpexchRaceEventPage(normalizedId);
      if (racePage) return racePage;
      return null;
    }
  }

  // ── 1) catalog2 structure ──
  const main = mainFromProbe || await fetchBpexchCatalog2(resolvedId);
  if (!main) {
    return null;
  }

  // ── 2) prices7 live books (source of odds + related market ids) ──
  const live = await fetchPrices7MarketData(resolvedId, pricesToken);
  const books = Array.isArray(live?.marketBooks) ? live.marketBooks : [];
  const bookById = new Map(books.map(b => [String(b.id), b]));

  // Related market ids = every book except root Match Odds
  let subIds = books
    .map(b => String(b.id))
    .filter(id => id && id !== String(resolvedId));

  // Also keep any explicit related ids from catalog2
  if (Array.isArray(main.relatedMarketIds)) {
    for (const id of main.relatedMarketIds) if (id) subIds.push(String(id));
  }
  subIds = [...new Set(subIds)];

  // ── 3) catalogs for related markets ──
  let subCatalogs = [];
  if (subIds.length) {
    for (let i = 0; i < subIds.length; i += 40) {
      const part = await fetchBpexchCatalogs(subIds.slice(i, i + 40));
      subCatalogs = subCatalogs.concat(part || []);
    }
    // per-id fallback if bulk empty
    if (!subCatalogs.length) {
      const results = await Promise.all(subIds.slice(0, 20).map(id => fetchBpexchCatalog2(id).catch(() => null)));
      subCatalogs = results.filter(Boolean);
    }
  }

  const eventId = main.eventId || main.event?.id;

  function mergeBookOntoCatalog(cat) {
    const mb = bookById.get(String(cat.marketId));
    if (!mb) return cat;
    const runners = (cat.runners || []).map(r => {
      const sid = String(r.selectionId ?? r.id ?? '');
      const lr = (mb.runners || []).find(x => String(x.id) === sid);
      const ladder = prices7RunnerToLadder(lr);
      return {
        ...r,
        status: ladder.status || r.status || 'ACTIVE',
        back: ladder.back,
        lay: ladder.lay,
        // Vue templates also read price1/lay1 directly
        price1: ladder.back[0]?.price, size1: ladder.back[0]?.size,
        price2: ladder.back[1]?.price, size2: ladder.back[1]?.size,
        price3: ladder.back[2]?.price, size3: ladder.back[2]?.size,
        lay1: ladder.lay[0]?.price, ls1: ladder.lay[0]?.size,
        lay2: ladder.lay[1]?.price, ls2: ladder.lay[1]?.size,
        lay3: ladder.lay[2]?.price, ls3: ladder.lay[2]?.size,
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

  let mainEnriched = mergeBookOntoCatalog(main);

  // If prices7 had no book for root, try highlights odds
  const rootHasOdds = (mainEnriched.runners || []).some(r => (r.back && r.back.length) || (r.lay && r.lay.length));
  if (!rootHasOdds) {
    try {
      const lookup = await getMatchOddsLookup();
      const hi = lookup.get(String(resolvedId));
      if (hi?.runners?.length) {
        mainEnriched = {
          ...mainEnriched,
          totalMatched: mainEnriched.totalMatched || hi.matched || 0,
          runners: (mainEnriched.runners || []).map((r, i) => {
            const hr = hi.runners.find(x =>
              String(x.runnerName || '').toLowerCase() === String(r.runnerName || '').toLowerCase()
            ) || hi.runners[i];
            if (!hr?.ex) return r;
            const back = (hr.ex.availableToBack || []).map(b => ({ price: b.price, size: b.size || 0 }));
            const lay  = (hr.ex.availableToLay  || []).map(l => ({ price: l.price, size: l.size || 0 }));
            return {
              ...r, back, lay,
              price1: back[0]?.price, size1: back[0]?.size,
              price2: back[1]?.price, size2: back[1]?.size,
              price3: back[2]?.price, size3: back[2]?.size,
              lay1: lay[0]?.price, ls1: lay[0]?.size,
              lay2: lay[1]?.price, ls2: lay[1]?.size,
              lay3: lay[2]?.price, ls3: lay[2]?.size,
            };
          }),
        };
      }
    } catch (e) {
      logger.warn(`[bpexch] highlights merge: ${e.message}`);
    }
  }

  // Build subMarkets: catalogs structure + prices7 odds; same event only
  const eventIdStr = eventId != null ? String(eventId) : null;
  const subMarkets = [];
  const seen = new Set();

  for (const cat of subCatalogs) {
    const mid = String(cat.marketId);
    if (mid === String(resolvedId) || seen.has(mid)) continue;
    if (eventIdStr && cat.eventId != null && String(cat.eventId) !== eventIdStr) continue;
    seen.add(mid);
    const enriched = mergeBookOntoCatalog(cat);
    const category = categorizeSubMarket(enriched);
    if (category === 'matchOdds') continue;
    subMarkets.push({ ...enriched, category });
  }

  // markets that appear only in prices7 books (no catalog yet) — still expose with synthetic names
  for (const mb of books) {
    const mid = String(mb.id);
    if (mid === String(resolvedId) || seen.has(mid)) continue;
    seen.add(mid);
    const runners = (mb.runners || []).map((lr, i) => {
      const ladder = prices7RunnerToLadder(lr);
      return {
        selectionId: Number(lr.id) || i + 1,
        runnerName: `Runner ${i + 1}`,
        status: ladder.status,
        back: ladder.back,
        lay: ladder.lay,
        price1: ladder.back[0]?.price, size1: ladder.back[0]?.size,
        price2: ladder.back[1]?.price, size2: ladder.back[1]?.size,
        price3: ladder.back[2]?.price, size3: ladder.back[2]?.size,
        lay1: ladder.lay[0]?.price, ls1: ladder.lay[0]?.size,
        lay2: ladder.lay[1]?.price, ls2: ladder.lay[1]?.size,
        lay3: ladder.lay[2]?.price, ls3: ladder.lay[2]?.size,
      };
    });
    subMarkets.push({
      marketId: mid,
      marketName: `Market ${mid}`,
      marketType: 'UNKNOWN',
      status: mb.marketStatus || 'OPEN',
      totalMatched: mb.totalMatched || 0,
      runners,
      category: 'other',
    });
  }

  logger.info(`[bpexch] marketPage ${normalizedId}${resolvedId !== normalizedId ? ` (resolved→${resolvedId})` : ''} books=${books.length} subs=${subMarkets.length} scoreboard=${!!live?.scoreboard}`);

  return {
    ...mainEnriched,
    marketId: mainEnriched.marketId || resolvedId,
    eventId,
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

/**
 * Event-level markets (for Event.html path /Common/Event/<eventId>).
 * Discovers market ids from event page, loads catalogs, categorizes.
 */
async function getBpexchEventMarkets(eventId, pricesToken) {
  if (!eventId) return null;
  const eid = String(eventId);

  // 1) Highlights feed: find Match Odds row whose event.id matches
  try {
    const items = await getSportsHighlights(null);
    const hit = items.find(m => String(m.event?.id) === eid);
    if (hit) {
      const page = await getBpexchMarketPage(hit.id, pricesToken);
      if (page) return page;
      // build minimal from highlights if catalog2 fails
      return {
        marketId: hit.id,
        marketName: hit.name || 'Match Odds',
        marketStartTime: hit.start,
        eventId: eid,
        eventName: hit.event?.name,
        eventTypeId: String(hit.eventTypeId || ''),
        eventType: null,
        status: 'OPEN',
        runners: (hit.runners || []).map(r => ({
          selectionId: r.selectionId,
          runnerName: r.runnerName,
          status: 'ACTIVE',
          back: (r.ex?.availableToBack || []).map(b => ({ price: b.price, size: b.size || 0 })),
          lay:  (r.ex?.availableToLay  || []).map(l => ({ price: l.price, size: l.size || 0 })),
        })),
        subMarkets: [],
        scoreboard: null,
        source: 'highlights',
      };
    }
  } catch (e) {
    logger.warn(`[bpexch] event highlights lookup failed: ${e.message}`);
  }

  // 2) Scrape event page for market ids
  const ids = await discoverMarketIdsFromEventPage(eid);
  if (!ids.length) return null;

  const rootId = ids.find(id => id.startsWith('1.')) || ids[0];
  const page = await getBpexchMarketPage(rootId, pricesToken);
  if (page) return page;

  let cats = [];
  for (let i = 0; i < ids.length; i += 40) {
    cats = cats.concat(await fetchBpexchCatalogs(ids.slice(i, i + 40)));
  }
  if (!cats.length) return null;
  const main = cats.find(c => {
    const t = String(c.marketType || '').toUpperCase();
    return t === 'MATCH_ODDS' || t === 'WINNER' || t === 'WIN';
  }) || cats[0];
  const subMarkets = cats
    .filter(c => String(c.marketId) !== String(main.marketId) && String(c.eventId || '') === eid)
    .map(c => ({ ...c, category: categorizeSubMarket(c) }))
    .filter(c => c.category !== 'matchOdds');
  return {
    ...main,
    eventId: eid,
    eventName: main.eventName || main.event?.name,
    eventTypeId: String(main.eventTypeId || main.sport?.id || ''),
    eventType: main.eventType || main.sport?.name,
    subMarkets,
    scoreboard: null,
    scores: null,
    news: main.news || '',
    source: 'bpexch',
  };
}

/** Resolve pure eventId (e.g. 35945509) → marketId (1.xxx)
 *  ✅ FIX: pehle sirf getSportsHighlights(null) call hota tha, jo sirf
 *  cricket/tennis/football (match-odds sports) return karta hai — Horse
 *  Racing / Greyhound (racing sports) is list mein kabhi hote hi nahi
 *  the. Isliye direct-link ya session-bridge-miss case mein horse/
 *  greyhound events ka marketId kabhi resolve nahi hota tha, catalog2
 *  404 deta, aur Event page "UNABLE TO LOAD" dikhata reh jaata.
 *  sportItems(null) racing (horse+greyhound) + matchOdds (cricket/
 *  tennis/football) dono ko ek saath combine karke deta hai, isliye
 *  ab sab sports ke liye resolution kaam karega. */
async function resolveMarketIdFromEventId(eventId) {
  if (!eventId) return null;
  const eid = String(eventId);
  try {
    const items = await sportItems(null);
    const hit = items.find(m => String(m.event?.id) === eid);
    if (hit?.id) return String(hit.id);
  } catch (_) {}
  const ids = await discoverMarketIdsFromEventPage(eid);
  return ids.find(id => id.startsWith('1.')) || ids[0] || null;
}




/**
 * Resolve SportRadar match id for scorecard widget (match.lmtLight).
 * Flow:
 *   1) catalog2 → eventId + any nested scoreboard ids
 *   2) prices7 market data scoreboard
 *   3) bpexch Scorecard / Market HTML (session) — parse matchId / SIR / LMT urls
 *   4) handler AJAX endpoints
 */
const _srMatchIdCache = new Map(); // key -> { id, exp }
const SR_CACHE_TTL_MS = 30 * 60_000;

async function resolveSportRadarMatchId(marketOrEventId) {
  const raw = String(marketOrEventId || '').trim();
  if (!raw) return null;
  const id = normalizeMarketId(raw);

  const cached = _srMatchIdCache.get(id) || _srMatchIdCache.get(raw);
  if (cached && Date.now() < cached.exp) return cached.id;

  function remember(srId, source) {
    if (!srId) return null;
    const s = String(srId).replace(/\D/g, '') || String(srId);
    if (s.length < 5 || s.length > 12) return null;
    // skip only exact Betfair market numeric tail (e.g. 261961116 from 1.261961116)
    const mktTail = id.replace(/^1\./, '');
    if (s === mktTail) return null;
    logger.info(`[scorecard] SportRadar matchId=${s} via ${source} for ${id}`);
    const entry = { id: s, exp: Date.now() + SR_CACHE_TTL_MS };
    _srMatchIdCache.set(id, entry);
    _srMatchIdCache.set(raw, entry);
    return s;
  }

  function extractFromText(text) {
    if (!text) return null;
    const patterns = [
      /SIR\s*\(\s*["']addWidget["'][\s\S]{0,200}?matchId\s*:\s*(\d{5,12})/i,
      /match\.lmtLight[\s\S]{0,120}?matchId\s*:\s*(\d{5,12})/i,
      /data-sr-input-props\s*=\s*["'][^"']*matchId[^"']*?(\d{5,12})/i,
      /["']matchId["']\s*:\s*(\d{5,12})/,
      /var\s+matchId\s*=\s*(\d{5,12})\s*;/i,
      /matchId\s*=\s*(\d{5,12})\s*;/i,
      /get_scorecard\/(\d{5,12})/i,
      /lmt\.fn\.sportradar\.com\/[^"'\\s]+\/(\d{5,12})/i,
      /widgets\.sir\.sportradar\.com[^"'\\s]*matchId[=:](\d{5,12})/i,
      /sr-widget[^>]{0,200}matchId["'\s:]+(\d{5,12})/i,
      /"sportradarMatchId"\s*:\s*"?(\d{5,12})"?/i,
      /"srMatchId"\s*:\s*"?(\d{5,12})"?/i,
      /"eventId"\s*:\s*(\d{6,12}).{0,40}"provider"\s*:\s*"sportradar"/i,
      /SHOWLIVE\s*\(\s*(\d{5,12})\s*\)/i,
      /ShowLive\s*\(\s*(\d{5,12})\s*\)/i,
      /SHOWSC\s*\(\s*(\d{5,12})\s*\)/i,
      /livesc[^>]*src=["'][^"']*[?&](?:id|matchId)=(\d{5,12})/i,
      /Scorecard\?id=(\d{5,12})/i,
      /matchId["'\s:=]+(\d{6,10})/i,
    ];
    for (const re of patterns) {
      const m = re.exec(text);
      if (m && m[1]) {
        const hit = remember(m[1], 'regex');
        if (hit) return hit;
      }
    }
    return null;
  }

  // ── 1) catalog2 structure ──
  let eventId = null;
  let cat = null;
  try {
    cat = await fetchBpexchCatalog2(id);
    if (cat) {
      eventId = cat.eventId || cat.event?.id || null;
      const hit = extractFromText(JSON.stringify(cat));
      if (hit) return hit;
      // nested scoreboard
      if (cat.scoreboard) {
        const sb = cat.scoreboard;
        const cand = sb.matchId || sb.MatchId || sb.srMatchId || sb.eventId || sb.id;
        const hit2 = remember(cand, 'catalog2.scoreboard');
        if (hit2) return hit2;
      }
    }
  } catch (e) {
    logger.warn(`[scorecard] catalog2 ${id}: ${e.message}`);
  }

  // ── 2) prices7 live scoreboard ──
  try {
    const live = await fetchPrices7MarketData(id);
    if (live) {
      const hit = extractFromText(JSON.stringify(live));
      if (hit) return hit;
      const sb = live.scoreboard || live.scores || null;
      if (sb) {
        const cand = sb.matchId || sb.MatchId || sb.srMatchId || sb.eventId || sb.id;
        const hit2 = remember(cand, 'prices7.scoreboard');
        if (hit2) return hit2;
      }
    }
  } catch (e) {
    logger.warn(`[scorecard] prices7 ${id}: ${e.message}`);
  }

  // ── 3) bpexch HTML pages (need session) ──
  try { await ensureBpexchSession(); } catch (_) {}

  const idsToTry = [...new Set([id, eventId, raw].filter(Boolean).map(String))];
  const pathTemplates = [
    (x) => `${BPEXCH_BASE_URL}/Common/Scorecard?id=${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/ScorecardIframe?id=${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/Market?id=${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/Market?handler=Scorecard&id=${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/Market?handler=LMT&id=${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/Market?handler=ChannelData&Evid=${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/Event/${encodeURIComponent(x)}`,
    (x) => `${BPEXCH_BASE_URL}/Common/Event?id=${encodeURIComponent(x)}`,
  ];

  for (const xid of idsToTry) {
    for (const tpl of pathTemplates) {
      const url = tpl(xid);
      try {
        const res = await axios.get(url, {
          timeout: TIMEOUT_MS,
          headers: bpexchHeaders({
            Accept: 'text/html,application/xhtml+xml,application/json',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${BPEXCH_BASE_URL}/Common/Market?id=${encodeURIComponent(id)}`,
          }),
          validateStatus: s => s < 500,
          maxRedirects: 5,
        });
        if (res.headers['set-cookie']) {
          _bpexchCookie = mergeSetCookie(_bpexchCookie, res.headers['set-cookie']);
        }
        let body = res.data;
        if (body && typeof body === 'object') body = JSON.stringify(body);
        body = String(body || '');
        if (body.length < 40) continue;
        if (/Just a moment|cf-browser-verification|Access denied|Error 1005/i.test(body)) {
          logger.warn(`[scorecard] blocked/challenge at ${url.split('?')[0]}`);
          continue;
        }
        const hit = extractFromText(body);
        if (hit) return hit;
      } catch (e) {
        logger.warn(`[scorecard] ${url.split('?')[0]}: ${e.message}`);
      }
    }
  }

  logger.warn(`[scorecard] no SportRadar matchId for market=${id} event=${eventId || '-'}`);
  return null;
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
  getBpexchEventMarkets,
  resolveMarketIdFromEventId,
  resolveRealRaceMarketId,
  ensureBpexchSession,
  getPrices7Token,
  resolveSportRadarMatchId,
  startBpexchKeepalive,
  refreshPrices7TokenFromSession,
  fetchPrices7MarketData,
  // ✅ Single-scrape entry point — getLiveHorse/getLiveGreyhound ab isi ek
  // fetch se events + catalogues dono derive karte hain, taake do alag
  // independent bpexch fetches se IDs mismatch na ho (races silently
  // gayab hone ka asli bug).
  sportItems,
};
