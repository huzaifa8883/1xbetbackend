'use strict';

/* ═══════════════════════════════════════════════════════════════
   autoSettle.service.js  v5

   COMPLETE REWRITE — Reliable, near-real-time settlement

   HOW IT WORKS:
   ─────────────
   1. Every POLL_INTERVAL ms: find all markets with MATCHED bets
   2. For each market: ask Betfair if it's CLOSED + who won
   3. If CLOSED + winner found → settleEventBets() atomically
   4. Duplicate protection: _settled Set + DB SETTLED status check
   5. Error handling per-market: one market failure won't block others

   BETFAIR ERRORS HANDLED:
   ─────────────────────────
   • DSC-0018 (market removed) → try listMarketProfitAndLoss
   • TOO_MANY_REQUESTS         → skip this cycle, retry next poll
   • Network errors            → log + skip, retry next poll

   ENV CONFIG:
   ─────────────
   AUTO_SETTLE_INTERVAL_MS       = 15000   (default 15 sec)
   AUTO_SETTLE_COMMISSION_PCT    = 0       (default 0%)
   AUTO_SETTLE_BATCH_SIZE        = 40      (Betfair API limit)
═══════════════════════════════════════════════════════════════ */

const { Op }              = require('sequelize');
const { Order }           = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

// ── Betfair service safe import ──────────────────────────────
let listMarketBook, listMarketProfitAndLoss;
try {
  const bf = require('./betfair.service');
  listMarketBook          = bf.listMarketBook;
  listMarketProfitAndLoss = bf.listMarketProfitAndLoss;
  if (typeof listMarketBook          !== 'function') throw new Error('listMarketBook not a function');
  if (typeof listMarketProfitAndLoss !== 'function') throw new Error('listMarketProfitAndLoss not a function');
  logger.info('[AutoSettle v5] betfair.service loaded OK');
} catch (e) {
  logger.error('[AutoSettle v5] betfair.service import failed: ' + e.message);
  listMarketBook          = async () => [];
  listMarketProfitAndLoss = async () => null;
}

// ── Config ───────────────────────────────────────────────────
const POLL_INTERVAL  = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS     || '15000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');
const BATCH_SIZE     = parseInt(process.env.AUTO_SETTLE_BATCH_SIZE       || '40',   10);

// ── Error patterns ───────────────────────────────────────────
const DSC_0018_RE = /DSC-0018/i;
const TMR_RE      = /TOO_MANY_REQUESTS|ANGX-0008/i;

// ── In-memory caches ─────────────────────────────────────────
// _settled: markets already fully settled — don't re-process
// _inProgress: currently being settled — prevent race condition
// _betfairGone: DSC-0018 markets — use PnL endpoint only
const _settled    = new Set();
const _inProgress = new Set();
const _betfairGone = new Set();

/* ═══════════════════════════════════════════════════════════════
   rebuildSettledCache
   On startup: pre-load already settled markets into _settled
   so we don't waste API calls on them.
═══════════════════════════════════════════════════════════════ */
async function rebuildSettledCache() {
  try {
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.SETTLED },
      group:      ['market_id'],
      raw:        true,
    });
    rows.forEach(r => _settled.add(r.market_id));
    logger.info(`[AutoSettle v5] Startup cache: ${_settled.size} already-settled markets loaded`);
  } catch (e) {
    logger.warn('[AutoSettle v5] rebuildSettledCache error: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   detectWinnerFromBook
   Betfair CLOSED book se winner selectionId nikalo.
   Returns: string selectionId | null
═══════════════════════════════════════════════════════════════ */
function detectWinnerFromBook(book) {
  if (!book) return null;
  const status = (book.status || '').toUpperCase();
  if (status !== 'CLOSED') return null;

  const runners = book.runners || [];

  // Method 1: status === 'WINNER'
  const byStatus = runners.find(r => (r.status || '').toUpperCase() === 'WINNER');
  if (byStatus) {
    logger.debug(`[AutoSettle v5] Winner by status: sel=${byStatus.selectionId}`);
    return String(byStatus.selectionId);
  }

  // Method 2: lastPriceTraded ≤ 1.01 (settled at near-evens = winner)
  const byPrice = runners.find(r => {
    const lpt = parseFloat(r.lastPriceTraded || 0);
    return lpt > 0 && lpt <= 1.01;
  });
  if (byPrice) {
    logger.debug(`[AutoSettle v5] Winner by lastPriceTraded: sel=${byPrice.selectionId}`);
    return String(byPrice.selectionId);
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════
   detectWinnerFromPnL
   Betfair listMarketProfitAndLoss se winner detect karo.
   Used when: (a) DSC-0018 or (b) book has no winner signal.
═══════════════════════════════════════════════════════════════ */
async function detectWinnerFromPnL(marketId) {
  try {
    const results = await listMarketProfitAndLoss([marketId]);
    const market  = results?.[0];
    if (!market) return null;

    // Runner with positive ifWin = winner
    const winner = (market.profitAndLosses || []).find(p => Number(p.ifWin) > 0);
    if (!winner) return null;

    logger.info(`[AutoSettle v5] Winner via PnL endpoint: market=${marketId} sel=${winner.selectionId}`);
    return String(winner.selectionId);
  } catch (e) {
    if (TMR_RE.test(e.message)) {
      logger.warn(`[AutoSettle v5] PnL rate-limited for ${marketId} — will retry next poll`);
    } else {
      logger.warn(`[AutoSettle v5] detectWinnerFromPnL failed [${marketId}]: ${e.message}`);
    }
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   doSettle — actually settle a market (with duplicate guard)
═══════════════════════════════════════════════════════════════ */
async function doSettle(marketId, winSel) {
  if (_settled.has(marketId)) {
    logger.debug(`[AutoSettle v5] market=${marketId} already in settled cache — skip`);
    return;
  }

  // DB-level duplicate check — in case cache was rebuilt without this entry
  const alreadySettled = await Order.count({
    where: { market_id: marketId, status: ORDER_STATUS.SETTLED },
  });
  if (alreadySettled > 0) {
    logger.debug(`[AutoSettle v5] market=${marketId} already settled in DB — adding to cache and skipping`);
    _settled.add(marketId);
    return;
  }

  _settled.add(marketId); // optimistic lock
  try {
    const result = await settleEventBets(marketId, winSel, { commissionPct: COMMISSION_PCT });
    logger.info(`[AutoSettle v5] ✅ Settled market=${marketId} winner=${winSel} users=${result.settled}`);
    return result;
  } catch (err) {
    _settled.delete(marketId); // rollback optimistic lock on error
    logger.error(`[AutoSettle v5] ❌ settleEventBets error [${marketId}]: ${err.message}`);
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════
   processOneMarket — single market settle karne ki koshish
═══════════════════════════════════════════════════════════════ */
async function processOneMarket(marketId) {
  if (_settled.has(marketId) || _inProgress.has(marketId)) return;
  _inProgress.add(marketId);

  try {
    let winSel = null;

    if (_betfairGone.has(marketId)) {
      // Betfair ne already DSC-0018 diya — sirf PnL try karo
      winSel = await detectWinnerFromPnL(marketId);
      if (winSel) _betfairGone.delete(marketId);
    } else {
      // Normal path: listMarketBook
      try {
        const books = await listMarketBook([marketId], {
          priceData:  ['LAST_PRICE_TRADED'],
          virtualise: false,
        });
        const book = books?.[0];

        if (!book) {
          // Betfair ne return nahi kiya — treat as gone
          _betfairGone.add(marketId);
          logger.debug(`[AutoSettle v5] market=${marketId} not returned by Betfair — marked gone`);
          return;
        }

        const bookStatus = (book.status || '').toUpperCase();
        if (bookStatus === 'CLOSED') {
          winSel = detectWinnerFromBook(book);
          if (!winSel) {
            // CLOSED but no clear winner in book — try PnL as fallback
            logger.debug(`[AutoSettle v5] market=${marketId} CLOSED but no winner in book — trying PnL`);
            winSel = await detectWinnerFromPnL(marketId);
          }
        } else {
          // Market still open/suspended — not ready yet
          logger.debug(`[AutoSettle v5] market=${marketId} status=${bookStatus} — not closed yet`);
          return;
        }
      } catch (e) {
        if (DSC_0018_RE.test(e.message)) {
          _betfairGone.add(marketId);
          logger.info(`[AutoSettle v5] DSC-0018 for ${marketId} — marking gone, trying PnL`);
          winSel = await detectWinnerFromPnL(marketId);
          if (winSel) _betfairGone.delete(marketId);
        } else if (TMR_RE.test(e.message)) {
          logger.warn(`[AutoSettle v5] Rate limited for ${marketId} — skipping this cycle`);
          return;
        } else {
          logger.error(`[AutoSettle v5] listMarketBook error [${marketId}]: ${e.message}`);
          return;
        }
      }
    }

    // Winner mil gaya — settle karo!
    if (winSel) {
      await doSettle(marketId, winSel);
    } else {
      logger.debug(`[AutoSettle v5] market=${marketId}: CLOSED but winner not determinable yet`);
    }

  } finally {
    _inProgress.delete(marketId);
  }
}

/* ═══════════════════════════════════════════════════════════════
   pollAndSettle — main loop (runs every POLL_INTERVAL ms)

   1. DB se MATCHED bets wale sab unique market IDs lo
   2. Already settled / in-progress skip karo
   3. Betfair API mein batch mein bhejo (BATCH_SIZE at a time)
   4. Per-market result check + settle if CLOSED
═══════════════════════════════════════════════════════════════ */
let _pollRunning = false;

async function pollAndSettle() {
  // Prevent overlapping poll runs
  if (_pollRunning) {
    logger.debug('[AutoSettle v5] Previous poll still running — skipping this cycle');
    return;
  }
  _pollRunning = true;

  try {
    // Get all markets with unsettled MATCHED bets
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.MATCHED },
      group:      ['market_id'],
      raw:        true,
    });

    if (!rows.length) return;

    const pendingMarkets = rows
      .map(r => r.market_id)
      .filter(mid => !_settled.has(mid) && !_inProgress.has(mid));

    if (!pendingMarkets.length) return;

    logger.debug(`[AutoSettle v5] Poll: ${pendingMarkets.length} markets with MATCHED bets to check`);

    // Batch process (Betfair limit = 40 per call)
    for (let i = 0; i < pendingMarkets.length; i += BATCH_SIZE) {
      const batch = pendingMarkets.slice(i, i + BATCH_SIZE);

      // Split: gone markets (PnL only) vs active markets (Betfair book)
      const goneBatch   = batch.filter(mid => _betfairGone.has(mid));
      const activeBatch = batch.filter(mid => !_betfairGone.has(mid));

      // Active markets: try batch listMarketBook first (faster, 1 API call)
      if (activeBatch.length) {
        try {
          const books = await listMarketBook(activeBatch, {
            priceData:  ['LAST_PRICE_TRADED'],
            virtualise: false,
          });

          const returnedIds = new Set(books.map(b => b.marketId));

          // Markets Betfair ne return nahi kiye → gone
          for (const mid of activeBatch) {
            if (!returnedIds.has(mid)) {
              _betfairGone.add(mid);
              logger.debug(`[AutoSettle v5] market=${mid} not in batch response — marked gone`);
            }
          }

          // Process returned books
          for (const book of books) {
            const mid = book.marketId;
            if (_settled.has(mid) || _inProgress.has(mid)) continue;

            const bookStatus = (book.status || '').toUpperCase();
            if (bookStatus !== 'CLOSED') continue;

            // Process asynchronously so one slow settle doesn't block others
            processOneMarket(mid).catch(e =>
              logger.error(`[AutoSettle v5] processOneMarket error [${mid}]: ${e.message}`)
            );
          }
        } catch (e) {
          if (DSC_0018_RE.test(e.message)) {
            // Batch had a bad marketId — fall back to individual processing
            logger.warn(`[AutoSettle v5] DSC-0018 in batch — processing ${activeBatch.length} markets individually`);
            for (const mid of activeBatch) {
              processOneMarket(mid).catch(err =>
                logger.error(`[AutoSettle v5] Individual processOneMarket error [${mid}]: ${err.message}`)
              );
            }
          } else if (TMR_RE.test(e.message)) {
            logger.warn('[AutoSettle v5] Rate-limited on batch listMarketBook — skipping this cycle');
          } else {
            logger.error(`[AutoSettle v5] Batch listMarketBook error: ${e.message}`);
          }
        }
      }

      // Gone markets: PnL endpoint (batched, 5 at a time to respect rate limits)
      if (goneBatch.length) {
        for (let j = 0; j < goneBatch.length; j += 5) {
          const chunk = goneBatch.slice(j, j + 5);
          await Promise.all(chunk.map(mid =>
            processOneMarket(mid).catch(e =>
              logger.error(`[AutoSettle v5] processOneMarket(gone) error [${mid}]: ${e.message}`)
            )
          ));
          if (j + 5 < goneBatch.length) await _sleep(2000);
        }
      }

      // Brief pause between batches to respect Betfair rate limits
      if (i + BATCH_SIZE < pendingMarkets.length) await _sleep(1500);
    }
  } catch (err) {
    logger.error(`[AutoSettle v5] pollAndSettle error: ${err.message}`);
  } finally {
    _pollRunning = false;
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ═══════════════════════════════════════════════════════════════
   manualSettle — Admin / fallback trigger
   Force-settle a specific market (clears cache first)
═══════════════════════════════════════════════════════════════ */
async function manualSettle(marketId, winningSelectionId = null) {
  // Clear caches for fresh attempt
  _settled.delete(marketId);
  _inProgress.delete(marketId);
  _betfairGone.delete(marketId);

  let winSel = winningSelectionId;

  if (!winSel) {
    // Try Betfair book
    try {
      const books = await listMarketBook([marketId], {
        priceData:  ['LAST_PRICE_TRADED'],
        virtualise: false,
      });
      winSel = detectWinnerFromBook(books?.[0]);
    } catch (e) {
      if (DSC_0018_RE.test(e.message)) {
        logger.info(`[AutoSettle v5] manualSettle: DSC-0018 for ${marketId} — trying PnL`);
      } else {
        logger.warn(`[AutoSettle v5] manualSettle: listMarketBook failed: ${e.message}`);
      }
    }

    // Fallback to PnL if book didn't give winner
    if (!winSel) {
      winSel = await detectWinnerFromPnL(marketId);
    }
  }

  if (!winSel) {
    logger.warn(`[AutoSettle v5] manualSettle: could not determine winner for market=${marketId}`);
    return { settled: 0, reason: 'winner_not_found' };
  }

  return doSettle(marketId, winSel);
}

/* ═══════════════════════════════════════════════════════════════
   startAutoSettlement — called from server.js on startup
═══════════════════════════════════════════════════════════════ */
function startAutoSettlement() {
  logger.info(`[AutoSettle v5] Starting — poll_interval=${POLL_INTERVAL/1000}s, commission=${COMMISSION_PCT}%, batch_size=${BATCH_SIZE}`);

  rebuildSettledCache().then(() => {
    // First poll after 10 seconds (let server fully boot)
    setTimeout(pollAndSettle, 10_000);
    // Then every POLL_INTERVAL
    setInterval(pollAndSettle, POLL_INTERVAL);
    logger.info(`[AutoSettle v5] ✅ Running — next poll in 10s, then every ${POLL_INTERVAL/1000}s`);
  });
}

module.exports = {
  startAutoSettlement,
  pollAndSettle,
  manualSettle,
};
