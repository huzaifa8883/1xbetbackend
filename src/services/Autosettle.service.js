'use strict';

/* ═══════════════════════════════════════════════════════════════════
   autoSettle.service.js

   PURPOSE:
   Betfair pe market CLOSED hone par automatically backend settle
   karta hai. Koi manual admin action ki zaroorat nahi.

   HOW IT WORKS:
   1. Har POLL_INTERVAL ms pe DB se sabhi MATCHED orders ka unique
      market_id list nikalega (yani woh markets jo abhi settle nahi hue)
   2. Har market ke liye betfair se catalog2 fetch karega
   3. Agar status === 'CLOSED' aur koi runner.status === 'WINNER' mile
      → settleEventBets(marketId, winningSelectionId) call karega
   4. Already settled markets dobara process nahi honge (Order.MATCHED
      check hi nahi aayega)

   USAGE (app.js ya server.js mein):
   ───────────────────────────────
   const { startAutoSettlement } = require('./services/autoSettle.service');
   startAutoSettlement();          // server start pe ek baar call karo

   ENV VARIABLES (optional, defaults provided):
   ─────────────────────────────────────────────
   AUTO_SETTLE_INTERVAL_MS   = 10000   (10 seconds)
   AUTO_SETTLE_COMMISSION_PCT = 0
═══════════════════════════════════════════════════════════════════ */

const { Op }             = require('sequelize');
const { Order }          = require('../models');
const { ORDER_STATUS }   = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger             = require('../utils/logger');

// ── Config ────────────────────────────────────────────────────────
const POLL_INTERVAL   = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS    || '10000', 10);
const COMMISSION_PCT  = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');

// In-memory set: markets jo currently process ho rahe hain (race condition avoid)
const _inProgress = new Set();

/* ─────────────────────────────────────────────────────────────────
   fetchMarketCatalog
   Betfair catalog2 API se market status + runners fetch karo
──────────────────────────────────────────────────────────────────*/
async function fetchMarketCatalog(marketId) {
  const baseUrl = process.env.PRICES_API_URL || 'https://prices9.mgs11.com/api';
  const url     = `${baseUrl}/markets/catalog2?id=${encodeURIComponent(marketId)}`;

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 8000);

  try {
    const res  = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data || json || null;
  } catch (e) {
    clearTimeout(timeout);
    logger.warn(`[AutoSettle] fetchMarketCatalog error market=${marketId}: ${e.message}`);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   getWinnerFromCatalog
   Catalog data se winning selection ID dhundhna
   Returns: winningSelectionId (string) | null
──────────────────────────────────────────────────────────────────*/
function getWinnerFromCatalog(catalog) {
  if (!catalog) return null;

  const marketStatus = (catalog.status || catalog.marketStatus || '').toUpperCase();

  // Market CLOSED hona chahiye
  if (marketStatus !== 'CLOSED') return null;

  // runners array se WINNER dhundo
  const runners = catalog.runners || catalog.Runners || [];
  const winner  = runners.find(r => {
    const rs = (r.status || r.runnerStatus || '').toUpperCase();
    return rs === 'WINNER';
  });

  if (winner) {
    return String(winner.selectionId || winner.selection_id || winner.SelectionId || '');
  }

  // numberOfWinners aur lastPriceTraded se bhi try karo (fallback)
  // Kuch betfair responses mein status 'WINNER' nahi hota lekin
  // runners ke lastPriceTraded se pata chalta hai
  // Is case mein null return karo — safe approach
  return null;
}

/* ─────────────────────────────────────────────────────────────────
   processMarket
   Ek market ko check karo aur zaroorat ho to settle karo
──────────────────────────────────────────────────────────────────*/
async function processMarket(marketId) {
  if (_inProgress.has(marketId)) return; // already processing
  _inProgress.add(marketId);

  try {
    const catalog = await fetchMarketCatalog(marketId);
    if (!catalog) return;

    const winningSelId = getWinnerFromCatalog(catalog);
    if (!winningSelId) return; // market abhi CLOSED nahi ya winner nahi mila

    logger.info(`[AutoSettle] Market ${marketId} CLOSED — winner: ${winningSelId}. Settling...`);

    const result = await settleEventBets(marketId, winningSelId, { commissionPct: COMMISSION_PCT });

    logger.info(`[AutoSettle] Market ${marketId} settled — ${result.settled} users processed.`);

  } catch (err) {
    logger.error(`[AutoSettle] processMarket error [market=${marketId}]: ${err.message}`);
  } finally {
    _inProgress.delete(marketId);
  }
}

/* ─────────────────────────────────────────────────────────────────
   pollAndSettle
   DB se active MATCHED markets dhundo, phir check + settle karo
──────────────────────────────────────────────────────────────────*/
async function pollAndSettle() {
  try {
    // Sirf woh markets jahan abhi bhi MATCHED orders hain
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.MATCHED },
      group:      ['market_id'],
      raw:        true,
    });

    if (!rows.length) return; // koi active market nahi

    const marketIds = rows.map(r => r.market_id);
    logger.debug(`[AutoSettle] Checking ${marketIds.length} active market(s)...`);

    // Parallel process karo (max concurrency 5 taake API rate limit na ho)
    const chunks = [];
    for (let i = 0; i < marketIds.length; i += 5) {
      chunks.push(marketIds.slice(i, i + 5));
    }
    for (const chunk of chunks) {
      await Promise.all(chunk.map(processMarket));
    }

  } catch (err) {
    logger.error(`[AutoSettle] pollAndSettle error: ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────────
   startAutoSettlement  (EXPORT)
   Server start pe ek baar call karo
──────────────────────────────────────────────────────────────────*/
function startAutoSettlement() {
  logger.info(`[AutoSettle] Started — polling every ${POLL_INTERVAL / 1000}s, commission=${COMMISSION_PCT}%`);

  // Pehli baar 5 second baad (server warm-up time)
  setTimeout(pollAndSettle, 5000);

  // Phir har POLL_INTERVAL pe
  setInterval(pollAndSettle, POLL_INTERVAL);
}

module.exports = { startAutoSettlement, pollAndSettle };