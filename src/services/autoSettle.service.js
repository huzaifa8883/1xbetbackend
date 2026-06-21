'use strict';

/* ═══════════════════════════════════════════════════════════════════
   autoSettle.service.js  v3

   ROOT CAUSE FIX:
   - catalog2 API mein `status` field NAHI hota
   - CLOSED status sirf prices/markets/data API ke `Book.marketStatus` mein hota hai
   - Winners bhi wahan se milte hain Book.runners[].status === 'WINNER'

   V3 APPROACH:
   1. prices/markets/data?id=  →  Book.marketStatus === 'CLOSED' check karo
                                   Book.runners se WINNER find karo (id field)
   2. Fallback: catalog2 runners se lastPriceTraded === 1.0 check karo

   FILE LOCATION: services/autoSettle.service.js
═══════════════════════════════════════════════════════════════════ */

const { Op }              = require('sequelize');
const { Order }           = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

// ── Config ────────────────────────────────────────────────────────
const POLL_INTERVAL  = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS      || '10000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');

// catalog2 base — apna own backend
const CATALOG_BASE = process.env.PRICES_API_URL || process.env.OWN_API_URL || 'https://1xbetbackend.work.gd/api/v1';
// prices/Book API base — betfair live data
const PRICES_BASE  = process.env.PRICES_DATA_URL || 'https://prices9.mgs11.com/api/v1';

// Race condition avoid karne ke liye
const _inProgress = new Set();
// Already settled markets is session mein dubara check mat karo
const _settled    = new Set();

/* ─────────────────────────────────────────────────────────────────
   fetchWithTimeout  — generic fetch helper
──────────────────────────────────────────────────────────────────*/
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    clearTimeout(t);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   fetchBookData  — prices/markets/data?id=  (Book API)
   Returns: { marketStatus, runners: [{id, status}] } | null
──────────────────────────────────────────────────────────────────*/
async function fetchBookData(marketId) {
  const url  = `${PRICES_BASE}/markets/data?id=${encodeURIComponent(marketId)}`;
  const json = await fetchWithTimeout(url, 6000);
  if (!json) return null;

  // Unwrap { success, data } format
  const data = (json.success && json.data) ? json.data : json;

  // marketBooks array se apna market nikalo
  const books = data.marketBooks || [];
  const book  = books.find(b => String(b.id) === String(marketId)) || books[0];
  return book || null;
}

/* ─────────────────────────────────────────────────────────────────
   fetchCatalogData  — catalog2 (own backend)
   Returns catalog object | null
──────────────────────────────────────────────────────────────────*/
async function fetchCatalogData(marketId) {
  const url  = `${CATALOG_BASE}/markets/catalog2?id=${encodeURIComponent(marketId)}`;
  const json = await fetchWithTimeout(url, 8000);
  if (!json) return null;
  return (json.success && json.data) ? json.data : json;
}

/* ─────────────────────────────────────────────────────────────────
   detectWinner  — Book API + catalog2 se winner dhundho

   Priority:
   1. Book.marketStatus === 'CLOSED' + Book.runners winner  ← MAIN METHOD
   2. catalog2 runners lastPriceTraded <= 1.01              ← FALLBACK
   3. catalog2 runners sp.nearPrice <= 1.01                 ← FALLBACK

   Returns: { winningSelectionId: string } | null
──────────────────────────────────────────────────────────────────*/
async function detectWinner(marketId) {

  // ── METHOD 1: Book API (prices server) ──────────────────────────
  try {
    const book = await fetchBookData(marketId);

    if (book) {
      const mktStatus = (book.marketStatus || '').toUpperCase();
      logger.debug(`[AutoSettle] market=${marketId} Book.marketStatus=${mktStatus}`);

      if (mktStatus === 'CLOSED') {
        const runners = book.runners || [];

        // Runner jiska status WINNER hai
        const winnerRunner = runners.find(r =>
          (r.status || '').toUpperCase() === 'WINNER'
        );

        if (winnerRunner) {
          // Book API mein runner id field hota hai (selectionId nahi)
          const selId = String(winnerRunner.id || winnerRunner.selectionId || '');
          if (selId) {
            logger.info(`[AutoSettle] ✅ METHOD1 Book API — market=${marketId} winner selId=${selId}`);
            return { winningSelectionId: selId };
          }
        }

        // CLOSED hai lekin runner WINNER status nahi mila abhi — wait karo
        logger.info(`[AutoSettle] Market ${marketId} CLOSED via Book but no WINNER runner yet`);
      }
    }
  } catch (e) {
    logger.warn(`[AutoSettle] Book API error market=${marketId}: ${e.message}`);
  }

  // ── FALLBACK: catalog2 API ────────────────────────────────────────
  try {
    const catalog = await fetchCatalogData(marketId);
    if (!catalog) return null;

    const runners = catalog.runners || [];

    // Fallback 1: lastPriceTraded === 1.0
    const lptWinner = runners.find(r => {
      const lpt = parseFloat(r.lastPriceTraded || r.LastPriceTraded || 0);
      return lpt > 0 && lpt <= 1.01;
    });
    if (lptWinner) {
      const selId = String(lptWinner.selectionId || lptWinner.selection_id || '');
      if (selId) {
        logger.info(`[AutoSettle] ✅ METHOD2 lastPriceTraded — market=${marketId} winner=${selId}`);
        return { winningSelectionId: selId };
      }
    }

    // Fallback 2: SP nearPrice
    const spWinner = runners.find(r => {
      const np = parseFloat(r?.sp?.nearPrice || r?.SP?.NearPrice || 0);
      return np > 0 && np <= 1.01;
    });
    if (spWinner) {
      const selId = String(spWinner.selectionId || spWinner.selection_id || '');
      if (selId) {
        logger.info(`[AutoSettle] ✅ METHOD3 sp.nearPrice — market=${marketId} winner=${selId}`);
        return { winningSelectionId: selId };
      }
    }
  } catch (e) {
    logger.warn(`[AutoSettle] catalog2 fallback error market=${marketId}: ${e.message}`);
  }

  logger.debug(`[AutoSettle] Market ${marketId} — no winner detected yet`);
  return null;
}

/* ─────────────────────────────────────────────────────────────────
   processMarket  — ek market check karo aur settle karo
──────────────────────────────────────────────────────────────────*/
async function processMarket(marketId) {
  if (_inProgress.has(marketId)) return;
  if (_settled.has(marketId))    return;
  _inProgress.add(marketId);

  try {
    const result = await detectWinner(marketId);
    if (!result) return;

    const { winningSelectionId } = result;
    _settled.add(marketId); // duplicate settlement se bacho

    logger.info(`[AutoSettle] Settling market=${marketId} winner=${winningSelectionId}`);

    const settled = await settleEventBets(
      marketId,
      winningSelectionId,
      { commissionPct: COMMISSION_PCT }
    );

    logger.info(`[AutoSettle] ✅ market=${marketId} done — ${settled.settled} users settled`);

  } catch (err) {
    _settled.delete(marketId); // retry on error
    logger.error(`[AutoSettle] processMarket error [market=${marketId}]: ${err.message}`);
  } finally {
    _inProgress.delete(marketId);
  }
}

/* ─────────────────────────────────────────────────────────────────
   pollAndSettle  — har interval pe DB se MATCHED markets lo
──────────────────────────────────────────────────────────────────*/
async function pollAndSettle() {
  try {
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.MATCHED },
      group:      ['market_id'],
      raw:        true,
    });

    if (!rows.length) return;

    const marketIds = rows
      .map(r => r.market_id)
      .filter(id => !_settled.has(id));

    if (!marketIds.length) return;

    logger.debug(`[AutoSettle] Polling ${marketIds.length} market(s): ${marketIds.join(', ')}`);

    // Max 5 parallel
    for (let i = 0; i < marketIds.length; i += 5) {
      await Promise.all(marketIds.slice(i, i + 5).map(processMarket));
    }
  } catch (err) {
    logger.error(`[AutoSettle] poll error: ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────────
   manualSettle  — Admin ya test se directly call karo
   Usage: await manualSettle('1.259320440')
──────────────────────────────────────────────────────────────────*/
async function manualSettle(marketId) {
  _settled.delete(marketId); // force re-check
  await processMarket(marketId);
}

/* ─────────────────────────────────────────────────────────────────
   startAutoSettlement  — server start pe call karo (server.js mein)
──────────────────────────────────────────────────────────────────*/
function startAutoSettlement() {
  logger.info(
    `[AutoSettle] v3 Started — interval=${POLL_INTERVAL/1000}s, commission=${COMMISSION_PCT}%`
  );
  logger.info(`[AutoSettle] Book API: ${PRICES_BASE} | Catalog API: ${CATALOG_BASE}`);
  setTimeout(pollAndSettle, 5000);
  setInterval(pollAndSettle, POLL_INTERVAL);
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle };
