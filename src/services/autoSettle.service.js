'use strict';

/*
  autoSettle.service.js  v3 — ROOT CAUSE FIX

  PROBLEM:
    catalog2 API mein `status` field NAHI hota.
    CLOSED status aur WINNER runner sirf prices/markets/data se milta hai.

  HOW IT WORKS:
    Har 10s: DB se MATCHED orders wale market IDs lo
    → prices/markets/data?id= hit karo
    → Book.marketStatus === 'CLOSED' + Book.runners[].status === 'WINNER' check karo
    → Winner mila? settleEventBets() call karo
*/

const { Order }           = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

const POLL_MS        = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS      || '10000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');
const PRICES_BASE    = process.env.PRICES_DATA_URL || 'https://prices9.mgs11.com/api/v1';
const CATALOG_BASE   = process.env.PRICES_API_URL  || process.env.OWN_API_URL || 'https://1xbetbackend.work.gd/api/v1';

const _busy    = new Set();   // race condition guard
const _settled = new Set();   // session-level settled

/* ── safe fetch ── */
async function safeFetch(url, ms = 7000) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) { logger.debug(`[AutoSettle] fetch ${url} → ${r.status}`); return null; }
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    logger.debug(`[AutoSettle] fetch error ${url}: ${e.message}`);
    return null;
  }
}

/* ── Step 1: prices/markets/data (Book API) — main method ── */
async function winnerFromBookAPI(marketId) {
  const json = await safeFetch(`${PRICES_BASE}/markets/data?id=${marketId}`);
  if (!json) return null;

  const data  = (json.success && json.data) ? json.data : json;
  const books = data.marketBooks || [];
  // apna market dhundo
  const book  = books.find(b => String(b.id) === String(marketId)) || books[0];
  if (!book) return null;

  const status = (book.marketStatus || '').toUpperCase();
  logger.debug(`[AutoSettle] Book API market=${marketId} status=${status}`);

  if (status !== 'CLOSED') return null;

  // WINNER runner dhundo — Book API mein id field hota hai (selectionId nahi)
  const winner = (book.runners || []).find(r => (r.status || '').toUpperCase() === 'WINNER');
  if (!winner) {
    logger.info(`[AutoSettle] market=${marketId} CLOSED but no WINNER runner in Book yet`);
    return null;
  }

  const selId = String(winner.id || winner.selectionId || '');
  if (!selId) return null;

  logger.info(`[AutoSettle] ✅ BookAPI winner: market=${marketId} sel=${selId}`);
  return selId;
}

/* ── Step 2: catalog2 fallback (lastPriceTraded=1) ── */
async function winnerFromCatalog(marketId) {
  const json = await safeFetch(`${CATALOG_BASE}/markets/catalog2?id=${marketId}`);
  if (!json) return null;

  const catalog = (json.success && json.data) ? json.data : json;
  const runners = catalog.runners || [];

  const winner = runners.find(r => {
    const lpt = parseFloat(r.lastPriceTraded || r.LastPriceTraded || 0);
    return lpt > 0 && lpt <= 1.01;
  });
  if (!winner) return null;

  const selId = String(winner.selectionId || winner.selection_id || '');
  if (!selId) return null;

  logger.info(`[AutoSettle] ✅ Catalog fallback winner: market=${marketId} sel=${selId}`);
  return selId;
}

/* ── Process one market ── */
async function processMarket(marketId) {
  if (_busy.has(marketId) || _settled.has(marketId)) return;
  _busy.add(marketId);
  try {
    // Try Book API first, then catalog fallback
    const winSel = (await winnerFromBookAPI(marketId)) || (await winnerFromCatalog(marketId));
    if (!winSel) return;

    _settled.add(marketId);
    logger.info(`[AutoSettle] Settling market=${marketId} winner=${winSel}`);
    const result = await settleEventBets(marketId, winSel, { commissionPct: COMMISSION_PCT });
    logger.info(`[AutoSettle] ✅ Done market=${marketId} — ${result.settled} users settled`);
  } catch (err) {
    _settled.delete(marketId);
    logger.error(`[AutoSettle] ERROR market=${marketId}: ${err.message}`);
  } finally {
    _busy.delete(marketId);
  }
}

/* ── Poll DB every interval ── */
async function pollAndSettle() {
  try {
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.MATCHED },
      group:      ['market_id'],
      raw:        true,
    });

    const ids = rows.map(r => r.market_id).filter(id => !_settled.has(id));
    if (!ids.length) return;

    logger.debug(`[AutoSettle] Checking ${ids.length} market(s): ${ids.join(', ')}`);
    for (let i = 0; i < ids.length; i += 5) {
      await Promise.all(ids.slice(i, i + 5).map(processMarket));
    }
  } catch (err) {
    logger.error(`[AutoSettle] poll error: ${err.message}`);
  }
}

/* ── Manual trigger (for testing / admin) ── */
async function manualSettle(marketId) {
  _settled.delete(marketId);
  await processMarket(marketId);
}

/* ── Start (call once in server.js) ── */
function startAutoSettlement() {
  logger.info(`[AutoSettle] v3 START — poll every ${POLL_MS/1000}s`);
  logger.info(`[AutoSettle] BookAPI=${PRICES_BASE}  CatalogAPI=${CATALOG_BASE}`);
  setTimeout(pollAndSettle, 3000);
  setInterval(pollAndSettle, POLL_MS);
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle };
