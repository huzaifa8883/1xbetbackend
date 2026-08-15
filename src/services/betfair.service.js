'use strict';

/* ═══════════════════════════════════════════════════════════════════
   BetwayInfo (betwayinfo.com) adapter
   ═══════════════════════════════════════════════════════════════════
   ⚠️ UNVERIFIED SHAPE WARNING: Client-provided documentation ne sirf
   FIELD NAMES diye hain (price1, size1, lay1, t1_runs, waghera) — koi
   actual sample JSON response nahi diya. Humne is poori project mein
   baar baar dekha hai (Shubdx/Rollwin) ke bina real curl output dekhe
   guess karna GALAT nikalta hai aur poora integration tootta hai.

   Is liye: neeche wali parsing logic ek REASONABLE GUESS hai documented
   field-names ke hisab se — lekin isko production mein bharosa karne se
   pehle real response se verify karna ZAROORI hai (neeche
   "VERIFICATION NEEDED" comments dekhein).

   ✅ Client-instructed correction applied: docs mein "/api/menu" likha
   tha, client ne bataya asal path "/api1/menu" hai — wahi use kiya hai.
   ═══════════════════════════════════════════════════════════════════ */

const axios  = require('axios');
const logger = require('../utils/logger');

const BASE_URL = process.env.BETWAYINFO_BASE_URL || 'https://betwayinfo.com';
const TIMEOUT_MS = 15000;

/* ── 1. Match Menu Discovery ──────────────────────────────
   GET /api1/menu  (✅ client-corrected — docs mein "/api/menu" tha)
   Primary listing — eventName → matchId mapping ke liye use hota hai. */
async function fetchMenu() {
  const url = `${BASE_URL}/api1/menu`; // ✅ /api/ → /api1/ (client correction)
  try {
    const res = await axios.get(url, { timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    logger.error(`[BetwayInfo] fetchMenu failed: ${err.message}`);
    throw err;
  }
}

/* ── 2. Catalog Metadata ───────────────────────────────────
   GET /data/catalog2?id={marketId}
   Ek market ki deep config: marketName, bettingType, runners[], rules */
async function fetchCatalog2(marketId) {
  const url = `${BASE_URL}/data/catalog2`;
  try {
    const res = await axios.get(url, { params: { id: marketId }, timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    logger.error(`[BetwayInfo] fetchCatalog2(${marketId}) failed: ${err.message}`);
    throw err;
  }
}

/* ── 3. Real-Time Market Data ──────────────────────────────
   GET /data/Data?id={marketId}
   High-frequency data: marketBooks (prices/sizes) + scoreboard
   (t1_runs, t1_wickets, t1_overs, commentry, session markets) —
   ⚠️ VERIFICATION NEEDED: docs sirf field-names batate hain
   (price1/size1/lay1), exact nesting structure confirm nahi hai.
   Best-guess: runner ke andar flat fields hote hain (price1..priceN,
   size1..sizeN, lay1..layN) — Betfair/Shubdx ki tarah back[]/lay[]
   arrays NAHI, balke numbered flat fields lagte hain. */
async function fetchMarketData(marketId) {
  const url = `${BASE_URL}/data/Data`;
  try {
    const res = await axios.get(url, { params: { id: marketId }, timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    logger.error(`[BetwayInfo] fetchMarketData(${marketId}) failed: ${err.message}`);
    throw err;
  }
}

/* ── 4. Batch Market Retrieval ─────────────────────────────
   GET /data/catalogs?ids={comma_separated_ids}
   Multiple related markets (Match Odds + Completed Match + Bookmaker
   waghera) ek hi request mein — cricket ke Fancy/Bookmaker submarkets
   ke liye especially useful. */
async function fetchCatalogsBatch(marketIds = []) {
  if (!marketIds.length) return [];
  const url = `${BASE_URL}/data/catalogs`;
  try {
    const res = await axios.get(url, { params: { ids: marketIds.join(',') }, timeout: TIMEOUT_MS });
    return res.data;
  } catch (err) {
    logger.error(`[BetwayInfo] fetchCatalogsBatch failed: ${err.message}`);
    throw err;
  }
}

/* ── Helper: scoreboard se live score nikalna (cricket) ────
   ⚠️ VERIFICATION NEEDED: field names docs se liye hain
   (t1_runs, t1_wickets, t1_overs, commentry) — asal response mein
   yehi naam/nesting hai ya nahi, curl se confirm karna zaroori hai. */
function extractScoreboard(marketDataResponse) {
  const sb = marketDataResponse?.scoreboard;
  if (!sb) return null;
  return {
    team1Runs:    sb.t1_runs    ?? null,
    team1Wickets: sb.t1_wickets ?? null,
    team1Overs:   sb.t1_overs   ?? null,
    commentary:   sb.commentry  ?? null, // ⚠️ docs mein "commentry" (typo?) likha hai, waisa hi rakha
    raw: sb, // poora raw object bhi de dete hain — jab tak shape confirm na ho, kaam aayega
  };
}

module.exports = {
  fetchMenu,
  fetchCatalog2,
  fetchMarketData,
  fetchCatalogsBatch,
  extractScoreboard,
};
