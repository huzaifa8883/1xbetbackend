'use strict';

/* ═══════════════════════════════════════════════════════════════════
   autoSettle.service.js  v2

   PROBLEM SOLVED:
   - Market CLOSED hoti hai betfair pe
   - Lekin "Winners: 0" hota hai (betfair ne winner declare nahi kiya)
   - Isliye pehla version kaam nahi karta tha

   V2 APPROACH — Teen tarike se winner detect karo:
   1. runner.status === 'WINNER'           (betfair ne declare kiya)
   2. runner.lastPriceTraded === 1.0       (1.0 pe settle = winner)  
   3. runner.sp.nearPrice === 1.0          (SP near 1.0 = winner)

   FILE LOCATION: services/autoSettle.service.js
   USAGE in app.js:
     const { startAutoSettlement } = require('./services/autoSettle.service');
     startAutoSettlement();
═══════════════════════════════════════════════════════════════════ */

const { Op }              = require('sequelize');
const { Order }           = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

// ── Config ────────────────────────────────────────────────────────
const POLL_INTERVAL  = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS     || '10000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');
const CATALOG_BASE   = process.env.PRICES_API_URL || process.env.OWN_API_URL || 'https://1xbetbackend.work.gd/api/v1';

// Race condition avoid karne ke liye
const _inProgress = new Set();
// Already settled markets is session mein dubara check mat karo
const _settled    = new Set();

/* ─────────────────────────────────────────────────────────────────
   fetchMarketCatalog  — apna catalog2 API hit karo
──────────────────────────────────────────────────────────────────*/
async function fetchMarketCatalog(marketId) {
  const url = `${CATALOG_BASE}/markets/catalog2?id=${encodeURIComponent(marketId)}`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res  = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data || json || null;
  } catch (e) {
    clearTimeout(t);
    logger.warn(`[AutoSettle] catalog fetch error market=${marketId}: ${e.message}`);
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   detectWinner  — teen tarike se winner dhundho

   Returns: { winningSelectionId: string } | null
──────────────────────────────────────────────────────────────────*/
function detectWinner(catalog) {
  if (!catalog) return null;

  const mktStatus = (
    catalog.status       ||
    catalog.marketStatus ||
    catalog.Status       ||
    ''
  ).toUpperCase();

  // Market CLOSED honi chahiye
  if (mktStatus !== 'CLOSED') return null;

  const runners = catalog.runners || catalog.Runners || [];
  if (!runners.length) return null;

  // ── Method 1: explicit WINNER status (betfair ne declare kiya) ──
  const explicitWinner = runners.find(r => {
    const rs = (r.status || r.runnerStatus || r.Status || '').toUpperCase();
    return rs === 'WINNER';
  });
  if (explicitWinner) {
    const selId = String(
      explicitWinner.selectionId ||
      explicitWinner.selection_id ||
      explicitWinner.SelectionId || ''
    );
    if (selId) {
      logger.info(`[AutoSettle] Winner via status=WINNER: selId=${selId}`);
      return { winningSelectionId: selId };
    }
  }

  // ── Method 2: lastPriceTraded === 1.0 (winner always settles at 1) ──
  const lptWinner = runners.find(r => {
    const lpt = parseFloat(r.lastPriceTraded || r.LastPriceTraded || 0);
    return lpt > 0 && lpt <= 1.01; // slight tolerance
  });
  if (lptWinner) {
    const selId = String(
      lptWinner.selectionId ||
      lptWinner.selection_id ||
      lptWinner.SelectionId || ''
    );
    if (selId) {
      logger.info(`[AutoSettle] Winner via lastPriceTraded=1.0: selId=${selId}`);
      return { winningSelectionId: selId };
    }
  }

  // ── Method 3: SP nearPrice ~= 1.0 ──
  const spWinner = runners.find(r => {
    const np = parseFloat(r?.sp?.nearPrice || r?.SP?.NearPrice || 0);
    return np > 0 && np <= 1.01;
  });
  if (spWinner) {
    const selId = String(
      spWinner.selectionId ||
      spWinner.selection_id ||
      spWinner.SelectionId || ''
    );
    if (selId) {
      logger.info(`[AutoSettle] Winner via sp.nearPrice=1.0: selId=${selId}`);
      return { winningSelectionId: selId };
    }
  }

  // Winner detect nahi hua — betfair ne abhi declare nahi kiya
  logger.debug(`[AutoSettle] Market ${catalog.marketId || '?'} CLOSED but no winner yet`);
  return null;
}

/* ─────────────────────────────────────────────────────────────────
   processMarket  — ek market check karo aur settle karo
──────────────────────────────────────────────────────────────────*/
async function processMarket(marketId) {
  if (_inProgress.has(marketId)) return;
  if (_settled.has(marketId))    return; // already done this session
  _inProgress.add(marketId);

  try {
    const catalog = await fetchMarketCatalog(marketId);
    const result  = detectWinner(catalog);

    if (!result) return; // not closed or no winner yet

    const { winningSelectionId } = result;
    _settled.add(marketId); // prevent duplicate settlement

    logger.info(`[AutoSettle] Settling market=${marketId} winner=${winningSelectionId}`);

    const settled = await settleEventBets(
      marketId,
      winningSelectionId,
      { commissionPct: COMMISSION_PCT }
    );

    logger.info(`[AutoSettle] ✅ market=${marketId} done — ${settled.settled} users settled`);

  } catch (err) {
    _settled.delete(marketId); // retry allowed on error
    logger.error(`[AutoSettle] processMarket error [market=${marketId}]: ${err.message}`);
  } finally {
    _inProgress.delete(marketId);
  }
}

/* ─────────────────────────────────────────────────────────────────
   pollAndSettle  — har interval pe DB se active markets lo
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
      .filter(id => !_settled.has(id)); // skip already settled

    if (!marketIds.length) return;

    logger.debug(`[AutoSettle] Polling ${marketIds.length} market(s)...`);

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
   Usage: await manualSettle('1.259133848')
──────────────────────────────────────────────────────────────────*/
async function manualSettle(marketId) {
  _settled.delete(marketId); // force re-check
  await processMarket(marketId);
}

/* ─────────────────────────────────────────────────────────────────
   startAutoSettlement  — server start pe call karo
──────────────────────────────────────────────────────────────────*/
function startAutoSettlement() {
  logger.info(
    `[AutoSettle] Started — interval=${POLL_INTERVAL/1000}s, commission=${COMMISSION_PCT}%`
  );
  setTimeout(pollAndSettle, 5000);         // server warm-up ke baad
  setInterval(pollAndSettle, POLL_INTERVAL);
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle };
