'use strict';

/* ═══════════════════════════════════════════════════════════════════
   autoSettle.service.js  v4

   V4 FIX — DSC-0018 error handle karo:
   Betfair DSC-0018 = "Invalid marketId" — market Betfair ke system
   se completely hata di gayi. In markets ko listMarketProfitAndLoss
   se settle karo ya VOID karo agar winner nahi milta.

   FLOW per market:
   1. listMarketBook — agar 200 OK aur CLOSED: winner from book
   2. Agar DSC-0018 (market gone from Betfair): listMarketProfitAndLoss
   3. Agar PnL bhi nahi deta: skip (admin manually settle karega)
═══════════════════════════════════════════════════════════════════ */

const { Op }              = require('sequelize');
const { Order }           = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

// ── Safe betfair import ───────────────────────────────────────────
let listMarketBook, listMarketProfitAndLoss;
try {
  const bf = require('./betfair.service');
  listMarketBook          = bf.listMarketBook;
  listMarketProfitAndLoss = bf.listMarketProfitAndLoss;
  if (typeof listMarketBook          !== 'function') throw new Error('listMarketBook not fn');
  if (typeof listMarketProfitAndLoss !== 'function') throw new Error('listMarketProfitAndLoss not fn');
  logger.info('[AutoSettle v4] betfair.service loaded OK');
} catch (e) {
  logger.error('[AutoSettle v4] betfair.service import failed: ' + e.message);
  listMarketBook          = async () => [];
  listMarketProfitAndLoss = async () => null;
}

// ── Config ────────────────────────────────────────────────────────
const POLL_INTERVAL  = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS     || '20000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');
// Betfair DSC-0018 = invalid marketId — gone from exchange
const DSC_0018_RE    = /DSC-0018/;
// TOO_MANY_REQUESTS
const TMR_RE         = /TOO_MANY_REQUESTS|ANGX-0008/;

// Race + settled cache
const _inProgress = new Set();
const _settled    = new Set();
// Markets that Betfair no longer knows about — try PnL only
const _betfairGone = new Set();

/* ─────────────────────────────────────────────────────────────────
   rebuildSettledCache
──────────────────────────────────────────────────────────────────*/
async function rebuildSettledCache() {
  try {
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.SETTLED },
      group:      ['market_id'],
      raw:        true,
    });
    rows.forEach(r => _settled.add(r.market_id));
    logger.info(`[AutoSettle v4] Cache: ${_settled.size} already settled`);
  } catch (e) {
    logger.warn('[AutoSettle v4] rebuildSettledCache error: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────
   detectWinnerFromBook
──────────────────────────────────────────────────────────────────*/
function detectWinnerFromBook(book) {
  if (!book || (book.status || '').toUpperCase() !== 'CLOSED') return null;
  const runners = book.runners || [];

  const w1 = runners.find(r => (r.status || '').toUpperCase() === 'WINNER');
  if (w1) return String(w1.selectionId);

  const w2 = runners.find(r => {
    const lpt = parseFloat(r.lastPriceTraded || 0);
    return lpt > 0 && lpt <= 1.01;
  });
  if (w2) return String(w2.selectionId);

  return null;
}

/* ─────────────────────────────────────────────────────────────────
   detectWinnerFromPnL
──────────────────────────────────────────────────────────────────*/
async function detectWinnerFromPnL(marketId) {
  try {
    const results = await listMarketProfitAndLoss([marketId]);
    const market  = results?.[0];
    if (!market) return null;
    const winner = (market.profitAndLosses || []).find(p => Number(p.ifWin) > 0);
    if (!winner) return null;
    logger.info(`[AutoSettle v4] Winner via PnL: market=${marketId} sel=${winner.selectionId}`);
    return String(winner.selectionId);
  } catch (e) {
    if (TMR_RE.test(e.message)) {
      logger.debug(`[AutoSettle v4] PnL rate limited for ${marketId}`);
    } else {
      logger.warn(`[AutoSettle v4] PnL failed ${marketId}: ${e.message}`);
    }
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   settleMarket — winner milne ke baad settle karo
──────────────────────────────────────────────────────────────────*/
async function settleMarket(marketId, winSel) {
  _settled.add(marketId);
  try {
    const result = await settleEventBets(marketId, winSel, { commissionPct: COMMISSION_PCT });
    logger.info(`[AutoSettle v4] ✅ market=${marketId} winner=${winSel} users=${result.settled}`);
    return result;
  } catch (err) {
    _settled.delete(marketId);
    logger.error(`[AutoSettle v4] settleEventBets error [${marketId}]: ${err.message}`);
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────────
   processBatchViaBook — listMarketBook se batch check
   DSC-0018 aaye to un markets ko _betfairGone mein daal do
──────────────────────────────────────────────────────────────────*/
async function processBatchViaBook(marketIds) {
  let books = [];
  try {
    books = await listMarketBook(marketIds, {
      priceData:  ['LAST_PRICE_TRADED'],
      virtualise: false,
    });
  } catch (e) {
    if (DSC_0018_RE.test(e.message)) {
      // Ek ya zyada markets invalid — sab ko individually try karo
      logger.debug(`[AutoSettle v4] DSC-0018 in batch of ${marketIds.length} — splitting to individual`);
      for (const mid of marketIds) {
        await processOneViaBook(mid);
      }
      return;
    }
    if (TMR_RE.test(e.message)) {
      logger.warn('[AutoSettle v4] listMarketBook rate limited — skip batch');
      return;
    }
    logger.error(`[AutoSettle v4] listMarketBook batch error: ${e.message}`);
    return;
  }

  // Books mein aaye markets process karo
  const returnedIds = new Set(books.map(b => b.marketId));

  for (const book of books) {
    if (_settled.has(book.marketId) || _inProgress.has(book.marketId)) continue;
    const bookStatus = (book.status || '').toUpperCase();
    if (bookStatus !== 'CLOSED') continue;

    _inProgress.add(book.marketId);
    try {
      const winSel = detectWinnerFromBook(book);
      if (winSel) {
        await settleMarket(book.marketId, winSel);
      } else {
        // CLOSED but no winner in book — try PnL
        const winSelPnL = await detectWinnerFromPnL(book.marketId);
        if (winSelPnL) await settleMarket(book.marketId, winSelPnL);
      }
    } finally {
      _inProgress.delete(book.marketId);
    }
  }

  // Markets jo Betfair ne return hi nahi kiye — _betfairGone mein daal do
  for (const mid of marketIds) {
    if (!returnedIds.has(mid) && !_settled.has(mid)) {
      _betfairGone.add(mid);
      logger.debug(`[AutoSettle v4] Market ${mid} not returned by Betfair — will try PnL`);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   processOneViaBook — single market individually try karo
──────────────────────────────────────────────────────────────────*/
async function processOneViaBook(marketId) {
  if (_settled.has(marketId) || _inProgress.has(marketId)) return;
  _inProgress.add(marketId);
  try {
    let books = [];
    try {
      books = await listMarketBook([marketId], {
        priceData:  ['LAST_PRICE_TRADED'],
        virtualise: false,
      });
    } catch (e) {
      if (DSC_0018_RE.test(e.message)) {
        // Market Betfair se completely gone
        _betfairGone.add(marketId);
        logger.debug(`[AutoSettle v4] Market ${marketId} DSC-0018 — marking as gone, will try PnL`);
        return;
      }
      if (TMR_RE.test(e.message)) return;
      logger.warn(`[AutoSettle v4] listMarketBook single ${marketId}: ${e.message}`);
      return;
    }

    const book = books?.[0];
    if (!book) {
      _betfairGone.add(marketId);
      return;
    }

    const bookStatus = (book.status || '').toUpperCase();
    if (bookStatus !== 'CLOSED') return;

    const winSel = detectWinnerFromBook(book) || await detectWinnerFromPnL(marketId);
    if (winSel) await settleMarket(marketId, winSel);

  } finally {
    _inProgress.delete(marketId);
  }
}

/* ─────────────────────────────────────────────────────────────────
   processGoneMarkets — Betfair se hata di gayi markets ko
   PnL se settle karne ki koshish karo
   Ye markets batched hain aur slow poll pe chalti hain
──────────────────────────────────────────────────────────────────*/
let _goneProcessing = false;
async function processGoneMarkets() {
  if (_goneProcessing) return;
  const gone = [..._betfairGone].filter(id => !_settled.has(id) && !_inProgress.has(id));
  if (!gone.length) return;

  _goneProcessing = true;
  logger.debug(`[AutoSettle v4] Processing ${gone.length} "gone" markets via PnL...`);

  // Max 5 parallel PnL calls — Betfair rate limit se bachne ke liye
  for (let i = 0; i < gone.length; i += 5) {
    const chunk = gone.slice(i, i + 5);
    await Promise.all(chunk.map(async (marketId) => {
      if (_settled.has(marketId)) return;
      _inProgress.add(marketId);
      try {
        const winSel = await detectWinnerFromPnL(marketId);
        if (winSel) {
          await settleMarket(marketId, winSel);
          _betfairGone.delete(marketId); // settled — gone list se hata do
        }
      } finally {
        _inProgress.delete(marketId);
      }
    }));
    if (i + 5 < gone.length) await new Promise(r => setTimeout(r, 2000));
  }
  _goneProcessing = false;
}

/* ─────────────────────────────────────────────────────────────────
   pollAndSettle — main poll loop
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

    // Split: known-gone markets alag, active markets alag
    const activeMarkets = [];
    for (const r of rows) {
      const mid = r.market_id;
      if (_settled.has(mid) || _inProgress.has(mid)) continue;
      if (_betfairGone.has(mid)) continue; // processGoneMarkets handle karega
      activeMarkets.push(mid);
    }

    if (activeMarkets.length) {
      logger.debug(`[AutoSettle v4] Polling ${activeMarkets.length} active markets via Betfair...`);
      // Chunk size 40 — conservative for rate limit
      for (let i = 0; i < activeMarkets.length; i += 40) {
        await processBatchViaBook(activeMarkets.slice(i, i + 40));
        if (i + 40 < activeMarkets.length) await new Promise(r => setTimeout(r, 1500));
      }
    }

    // Gone markets via PnL (every other poll)
    await processGoneMarkets();

  } catch (err) {
    logger.error(`[AutoSettle v4] poll error: ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────────
   manualSettle
──────────────────────────────────────────────────────────────────*/
async function manualSettle(marketId) {
  _settled.delete(marketId);
  _inProgress.delete(marketId);
  _betfairGone.delete(marketId);

  // Book try karo
  let winSel = null;
  try {
    const books = await listMarketBook([marketId], { priceData: ['LAST_PRICE_TRADED'], virtualise: false });
    winSel = detectWinnerFromBook(books?.[0]);
  } catch (e) {
    if (DSC_0018_RE.test(e.message)) {
      logger.info(`[AutoSettle v4] manualSettle: market ${marketId} gone from Betfair, trying PnL`);
    }
  }

  if (!winSel) winSel = await detectWinnerFromPnL(marketId);
  if (!winSel) {
    logger.warn(`[AutoSettle v4] manualSettle: no winner found for ${marketId}`);
    return { settled: 0, reason: 'no_winner' };
  }

  return settleMarket(marketId, winSel);
}

/* ─────────────────────────────────────────────────────────────────
   startAutoSettlement
──────────────────────────────────────────────────────────────────*/
function startAutoSettlement() {
  logger.info(`[AutoSettle v4] Starting — interval=${POLL_INTERVAL/1000}s, commission=${COMMISSION_PCT}%`);
  rebuildSettledCache().then(() => {
    setTimeout(pollAndSettle, 10000);
    setInterval(pollAndSettle, POLL_INTERVAL);
  });
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle };
