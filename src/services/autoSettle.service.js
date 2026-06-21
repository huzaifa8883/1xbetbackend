'use strict';

/*
  autoSettle.service.js  v4 — FINAL FIX

  ROOT CAUSE:
  - prices9.mgs11.com/markets/data → yeh third party server hai, iska response format
    hume pata nahi tha. Ab seedha call karte hain aur SAARI possible fields check karte hain.
  - catalog2 bhi apne backend pe hai - dono try karo

  STRATEGY: 3 methods try karo order mein:
  1. prices9 /markets/data → Book.marketStatus=CLOSED + runner.status=WINNER
  2. apna backend catalog2 → runner.lastPriceTraded <= 1.01
  3. apna backend catalog2 → runner.status = WINNER (agar backend set karta ho)
*/

const { Order }           = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

const POLL_MS        = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS      || '10000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');

// prices9 = betfair live data server (frontend ke pricesUrl se liya)
const PRICES_BASE  = 'https://prices9.mgs11.com/api/v1';
// apna backend
const OWN_BASE     = process.env.OWN_API_URL || process.env.PRICES_API_URL || 'https://1xbetbackend.work.gd/api/v1';

const _busy    = new Set();
const _settled = new Set();

/* ── safe fetch — koi error nahi throw hoga ── */
async function safeFetch(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) {
      logger.debug(`[AutoSettle] HTTP ${r.status} for ${url}`);
      return null;
    }
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    clearTimeout(t);
    logger.debug(`[AutoSettle] fetch failed ${url}: ${e.message}`);
    return null;
  }
}

/* ──────────────────────────────────────────────────────────
   METHOD 1: prices9 Book API
   Response: { marketBooks: [{ id, marketStatus, runners: [{id, status}] }] }
────────────────────────────────────────────────────────── */
async function tryBookAPI(marketId) {
  const json = await safeFetch(`${PRICES_BASE}/markets/data?id=${marketId}`, 6000);
  if (!json) return null;

  // unwrap possible { success, data } wrapper
  const payload = (json.success && json.data) ? json.data : json;

  // marketBooks array
  const books = payload.marketBooks || payload.MarketBooks || [];
  if (!books.length) {
    logger.debug(`[AutoSettle] prices9: no marketBooks for ${marketId}`);
    return null;
  }

  // apna market ID match karo
  const book = books.find(b =>
    String(b.id || b.marketId || b.Id || '') === String(marketId)
  ) || books[0];

  if (!book) return null;

  const mktStatus = (
    book.marketStatus || book.MarketStatus || book.status || ''
  ).toUpperCase();

  logger.debug(`[AutoSettle] prices9 market=${marketId} status=${mktStatus}`);
  if (mktStatus !== 'CLOSED') return null;

  const runners = book.runners || book.Runners || [];
  const winner  = runners.find(r =>
    (r.status || r.Status || r.runnerStatus || '').toUpperCase() === 'WINNER'
  );

  if (!winner) {
    logger.info(`[AutoSettle] prices9: ${marketId} CLOSED but no WINNER runner yet`);
    return null;
  }

  // Book API mein runner ID = selectionId
  const selId = String(winner.id || winner.selectionId || winner.Id || '');
  if (!selId) return null;

  logger.info(`[AutoSettle] ✅ prices9 WINNER: market=${marketId} runner=${selId}`);
  return selId;
}

/* ──────────────────────────────────────────────────────────
   METHOD 2 & 3: apna catalog2
   runners.lastPriceTraded <= 1.01  OR  runner.status=WINNER
────────────────────────────────────────────────────────── */
async function tryCatalogAPI(marketId) {
  const json = await safeFetch(`${OWN_BASE}/markets/catalog2?id=${marketId}`, 8000);
  if (!json) return null;

  const catalog = (json.success && json.data) ? json.data : json;

  // catalog level status (ho sakta hai ho)
  const catStatus = (
    catalog.status || catalog.marketStatus || catalog.Status || ''
  ).toUpperCase();

  const runners = catalog.runners || catalog.Runners || [];
  if (!runners.length) return null;

  // Method 2: explicit WINNER status in catalog
  const explicitWinner = runners.find(r =>
    (r.status || r.Status || '').toUpperCase() === 'WINNER'
  );
  if (explicitWinner) {
    const selId = String(explicitWinner.selectionId || explicitWinner.selection_id || '');
    if (selId) {
      logger.info(`[AutoSettle] ✅ catalog WINNER status: market=${marketId} sel=${selId}`);
      return selId;
    }
  }

  // Method 3: lastPriceTraded = 1.0 (winner always traded at 1.0)
  // Yeh sirf CLOSED market mein hota hai
  if (catStatus === 'CLOSED' || catStatus === '') {
    const lptWinner = runners.find(r => {
      const lpt = parseFloat(r.lastPriceTraded || r.LastPriceTraded || 0);
      return lpt > 0 && lpt <= 1.01;
    });
    if (lptWinner) {
      const selId = String(lptWinner.selectionId || lptWinner.selection_id || '');
      if (selId) {
        logger.info(`[AutoSettle] ✅ catalog lastPriceTraded=1.0: market=${marketId} sel=${selId}`);
        return selId;
      }
    }

    // Method 4: SP nearPrice = 1.0
    const spWinner = runners.find(r => {
      const np = parseFloat(r?.sp?.nearPrice || r?.sp?.NearPrice || r?.SP?.nearPrice || 0);
      return np > 0 && np <= 1.01;
    });
    if (spWinner) {
      const selId = String(spWinner.selectionId || spWinner.selection_id || '');
      if (selId) {
        logger.info(`[AutoSettle] ✅ catalog sp.nearPrice=1.0: market=${marketId} sel=${selId}`);
        return selId;
      }
    }
  }

  return null;
}

/* ──────────────────────────────────────────────────────────
   processMarket — ek market check aur settle
────────────────────────────────────────────────────────── */
async function processMarket(marketId) {
  if (_busy.has(marketId) || _settled.has(marketId)) return;
  _busy.add(marketId);

  try {
    // Dono methods try karo
    const winSel = (await tryBookAPI(marketId)) || (await tryCatalogAPI(marketId));

    if (!winSel) return;

    _settled.add(marketId);
    logger.info(`[AutoSettle] Settling market=${marketId} winner=${winSel} commission=${COMMISSION_PCT}%`);

    const result = await settleEventBets(marketId, winSel, { commissionPct: COMMISSION_PCT });
    logger.info(`[AutoSettle] ✅ market=${marketId} — ${result.settled} users settled`);

  } catch (err) {
    _settled.delete(marketId); // allow retry on error
    logger.error(`[AutoSettle] processMarket error market=${marketId}: ${err.message}`);
    logger.error(err.stack);
  } finally {
    _busy.delete(marketId);
  }
}

/* ──────────────────────────────────────────────────────────
   pollAndSettle — DB se MATCHED markets lo, check karo
────────────────────────────────────────────────────────── */
async function pollAndSettle() {
  try {
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.MATCHED },
      group:      ['market_id'],
      raw:        true,
    });

    const ids = rows
      .map(r => r.market_id)
      .filter(id => id && !_settled.has(id));

    if (!ids.length) return;

    logger.debug(`[AutoSettle] Polling ${ids.length} market(s): ${ids.join(', ')}`);

    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(processMarket));
    }
  } catch (err) {
    logger.error(`[AutoSettle] pollAndSettle error: ${err.message}`);
  }
}

/* ──────────────────────────────────────────────────────────
   manualSettle — direct call for testing/admin
────────────────────────────────────────────────────────── */
async function manualSettle(marketId) {
  logger.info(`[AutoSettle] manualSettle called for market=${marketId}`);
  _settled.delete(marketId);
  _busy.delete(marketId);
  await processMarket(marketId);
}

/* ──────────────────────────────────────────────────────────
   startAutoSettlement — server.js ya app.js mein ek baar call karo
────────────────────────────────────────────────────────── */
function startAutoSettlement() {
  logger.info(`[AutoSettle] v4 STARTED — interval=${POLL_MS/1000}s commission=${COMMISSION_PCT}%`);
  logger.info(`[AutoSettle] prices9=${PRICES_BASE} | own=${OWN_BASE}`);
  setTimeout(pollAndSettle, 5000);           // 5s baad first run
  setInterval(pollAndSettle, POLL_MS);
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle };
