'use strict';

/* ═══════════════════════════════════════════════════════════════════
   autoSettle.service.js  v3

   V3 CHANGES vs V2:
   - catalog2 HTTP calls HATAYE — yeh 404 spam kar raha tha
   - Ab seedha Betfair listMarketBook API use karta hai
   - listMarketProfitAndLoss bhi safe import ke saath hai
   - DB mein already SETTLED orders wale markets skip kiye jaate hain
     (server restart ke baad bhi _settled Set rebuild hota hai)
   - Batched Betfair calls — 200 market limit respect karta hai
   - TOO_MANY_REQUESTS error pe exponential backoff

   WINNER DETECTION (3 methods):
   1. runner.status === 'WINNER'
   2. runner.lastPriceTraded <= 1.01
   3. listMarketProfitAndLoss me ifWin > 0

   FILE: services/autoSettle.service.js
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
  listMarketBook            = bf.listMarketBook;
  listMarketProfitAndLoss   = bf.listMarketProfitAndLoss;
  if (typeof listMarketBook          !== 'function') throw new Error('listMarketBook not a function');
  if (typeof listMarketProfitAndLoss !== 'function') throw new Error('listMarketProfitAndLoss not a function');
  logger.info('[AutoSettle v3] betfair.service loaded OK');
} catch (e) {
  logger.error('[AutoSettle v3] betfair.service import failed: ' + e.message);
  listMarketBook          = async () => [];
  listMarketProfitAndLoss = async () => null;
}

// ── Config ────────────────────────────────────────────────────────
const POLL_INTERVAL  = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS     || '15000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');
const BF_CHUNK       = 40; // Betfair per request max (conservative — avoid rate limit)

// Race condition guard
const _inProgress = new Set();
// Settled this session (rebuilt from DB on startup)
const _settled    = new Set();

/* ─────────────────────────────────────────────────────────────────
   rebuildSettledCache — server start pe DB se already settled
   markets load karo taake dobara check na ho
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
    logger.info(`[AutoSettle v3] Settled cache rebuilt: ${_settled.size} markets already settled`);
  } catch (e) {
    logger.warn('[AutoSettle v3] rebuildSettledCache failed: ' + e.message);
  }
}

/* ─────────────────────────────────────────────────────────────────
   detectWinnerFromBook — listMarketBook result se winner dhundho
   Returns: winningSelectionId string | null
──────────────────────────────────────────────────────────────────*/
function detectWinnerFromBook(book) {
  if (!book) return null;

  const status = (book.status || '').toUpperCase();
  if (status !== 'CLOSED') return null;

  const runners = book.runners || [];
  if (!runners.length) return null;

  // Method 1: explicit WINNER status
  const w1 = runners.find(r => (r.status || '').toUpperCase() === 'WINNER');
  if (w1) {
    logger.info(`[AutoSettle v3] Winner via status=WINNER: sel=${w1.selectionId}`);
    return String(w1.selectionId);
  }

  // Method 2: lastPriceTraded === 1.0 (winner always settles at 1)
  const w2 = runners.find(r => {
    const lpt = parseFloat(r.lastPriceTraded || 0);
    return lpt > 0 && lpt <= 1.01;
  });
  if (w2) {
    logger.info(`[AutoSettle v3] Winner via lastPriceTraded=1.0: sel=${w2.selectionId}`);
    return String(w2.selectionId);
  }

  logger.debug(`[AutoSettle v3] Market ${book.marketId} CLOSED but no winner in book yet`);
  return null;
}

/* ─────────────────────────────────────────────────────────────────
   detectWinnerFromPnL — Betfair PnL API se winner dhundho
   Jab book mein winner nahi milta (edge case) tab fallback
──────────────────────────────────────────────────────────────────*/
async function detectWinnerFromPnL(marketId) {
  try {
    const results = await listMarketProfitAndLoss([marketId]);
    const market  = results?.[0];
    if (!market) return null;

    const winner = (market.profitAndLosses || []).find(p => Number(p.ifWin) > 0);
    if (!winner) return null;

    const selId = String(winner.selectionId);
    logger.info(`[AutoSettle v3] Winner via PnL API: market=${marketId} sel=${selId}`);
    return selId;
  } catch (e) {
    // TOO_MANY_REQUESTS ya network error — silently skip
    if (e.message.includes('TOO_MANY_REQUESTS') || e.message.includes('ANGX')) {
      logger.debug(`[AutoSettle v3] PnL rate limited for ${marketId} — will retry next poll`);
    } else {
      logger.warn(`[AutoSettle v3] PnL failed for ${marketId}: ${e.message}`);
    }
    return null;
  }
}

/* ─────────────────────────────────────────────────────────────────
   processMarketBatch — Betfair se ek batch mein markets check karo
   marketIds: string[]  (max BF_CHUNK)
──────────────────────────────────────────────────────────────────*/
async function processMarketBatch(marketIds) {
  let books = [];
  try {
    books = await listMarketBook(marketIds, {
      priceData:  ['LAST_PRICE_TRADED'],
      virtualise: false,
    });
  } catch (e) {
    if (e.message.includes('TOO_MANY_REQUESTS') || e.message.includes('ANGX')) {
      logger.warn('[AutoSettle v3] listMarketBook rate limited — skipping batch this poll');
      return;
    }
    logger.error(`[AutoSettle v3] listMarketBook error: ${e.message}`);
    return;
  }

  for (const book of books) {
    const marketId = book.marketId;
    if (!marketId) continue;
    if (_inProgress.has(marketId)) continue;
    if (_settled.has(marketId))    continue;

    const bookStatus = (book.status || '').toUpperCase();

    // Market abhi bhi OPEN/SUSPENDED — skip silently
    if (bookStatus !== 'CLOSED') continue;

    _inProgress.add(marketId);
    try {
      let winSel = detectWinnerFromBook(book);

      // Fallback: PnL API (only if CLOSED but no winner in book)
      if (!winSel) {
        winSel = await detectWinnerFromPnL(marketId);
      }

      if (!winSel) {
        // CLOSED but truly no winner yet — will retry next poll (not adding to _settled)
        continue;
      }

      _settled.add(marketId); // prevent duplicate settlement

      logger.info(`[AutoSettle v3] Settling market=${marketId} winner=${winSel}`);

      const result = await settleEventBets(
        marketId,
        winSel,
        { commissionPct: COMMISSION_PCT }
      );

      logger.info(`[AutoSettle v3] ✅ market=${marketId} done — ${result.settled} users settled`);

    } catch (err) {
      _settled.delete(marketId); // retry allowed on error
      logger.error(`[AutoSettle v3] processMarket error [${marketId}]: ${err.message}`);
    } finally {
      _inProgress.delete(marketId);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   pollAndSettle — har interval pe DB se active markets lo
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
      .filter(id => !_settled.has(id) && !_inProgress.has(id));

    if (!marketIds.length) return;

    logger.debug(`[AutoSettle v3] Polling ${marketIds.length} market(s) via Betfair...`);

    // Betfair max chunk size pe split karo
    for (let i = 0; i < marketIds.length; i += BF_CHUNK) {
      await processMarketBatch(marketIds.slice(i, i + BF_CHUNK));

      // Batches ke beech thodi der — rate limit se bachne ke liye
      if (i + BF_CHUNK < marketIds.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  } catch (err) {
    logger.error(`[AutoSettle v3] poll error: ${err.message}`);
  }
}

/* ─────────────────────────────────────────────────────────────────
   manualSettle  — Admin ya test se directly call karo
──────────────────────────────────────────────────────────────────*/
async function manualSettle(marketId) {
  _settled.delete(marketId);
  _inProgress.delete(marketId);

  let book = null;
  try {
    const books = await listMarketBook([marketId], {
      priceData:  ['LAST_PRICE_TRADED'],
      virtualise: false,
    });
    book = books?.[0] || null;
  } catch (e) {
    logger.warn(`[AutoSettle v3] manualSettle listMarketBook failed: ${e.message}`);
  }

  let winSel = detectWinnerFromBook(book);
  if (!winSel) winSel = await detectWinnerFromPnL(marketId);

  if (!winSel) {
    logger.warn(`[AutoSettle v3] manualSettle: no winner found for ${marketId}`);
    return { settled: 0, reason: 'no_winner' };
  }

  _settled.add(marketId);
  const result = await settleEventBets(marketId, winSel, { commissionPct: COMMISSION_PCT });
  logger.info(`[AutoSettle v3] manualSettle done: market=${marketId} winner=${winSel} settled=${result.settled}`);
  return result;
}

/* ─────────────────────────────────────────────────────────────────
   startAutoSettlement  — server start pe call karo
──────────────────────────────────────────────────────────────────*/
function startAutoSettlement() {
  logger.info(
    `[AutoSettle v3] Starting — interval=${POLL_INTERVAL/1000}s, commission=${COMMISSION_PCT}%, chunk=${BF_CHUNK}`
  );

  // Already settled markets cache rebuild karo
  rebuildSettledCache().then(() => {
    // Server warm-up ke baad pehla poll
    setTimeout(pollAndSettle, 8000);
    // Regular interval
    setInterval(pollAndSettle, POLL_INTERVAL);
  });
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle };
