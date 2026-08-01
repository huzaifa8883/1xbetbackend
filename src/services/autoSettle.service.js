'use strict';

/* ═══════════════════════════════════════════════════════════════
   autoSettle.service.js  v5  — CATALOG2-FIRST SETTLEMENT

   ROOT CAUSE OF BUG:
   Previous versions relied ONLY on Betfair listMarketBook to
   detect the winner. But Greyhound/Horse Race markets disappear
   from Betfair API within minutes of closing (DSC-0018 error),
   so winner was never found → bets never settled.

   THE FIX — 3-layer winner detection (fastest to slowest):
   ─────────────────────────────────────────────────────────
   Layer 1: Catalog2 API (OUR backend) — runners[].status=WINNER
            Fastest. Always works. Market close ke saath hi
            catalog2 update ho jaata hai winner ke saath.

   Layer 2: Betfair listMarketBook — backup if catalog2 slow
            Works while market is still on Betfair exchange.

   Layer 3: Betfair listMarketProfitAndLoss — last resort
            Works even after market is removed from Betfair.

   FLOW:
   ─────
   Every POLL_INTERVAL: find all markets with MATCHED bets
   → For each: try Layer1 → Layer2 → Layer3
   → Winner mila? → settleEventBets() atomically
   → Duplicate protection: _settled cache + DB status check
═══════════════════════════════════════════════════════════════ */

const axios           = require('axios');
const { Op }          = require('sequelize');
const { Order }       = require('../models');
const { ORDER_STATUS }    = require('../config/constants');
const { settleEventBets } = require('./order.service');
const logger              = require('../utils/logger');

// ── Betfair service safe import ──────────────────────────────
let listMarketBook, listMarketProfitAndLoss;
try {
  const bf = require('./betfair.service');
  listMarketBook          = bf.listMarketBook;
  listMarketProfitAndLoss = bf.listMarketProfitAndLoss;
  if (typeof listMarketBook          !== 'function') throw new Error('listMarketBook not fn');
  if (typeof listMarketProfitAndLoss !== 'function') throw new Error('listMarketProfitAndLoss not fn');
  logger.info('[AutoSettle v5] betfair.service loaded OK');
} catch (e) {
  logger.warn('[AutoSettle v5] betfair.service unavailable: ' + e.message + ' — will use Catalog2 only');
  listMarketBook          = async () => [];
  listMarketProfitAndLoss = async () => null;
}

// ── Config ───────────────────────────────────────────────────
const POLL_INTERVAL  = parseInt(process.env.AUTO_SETTLE_INTERVAL_MS     || '15000', 10);
const COMMISSION_PCT = parseFloat(process.env.AUTO_SETTLE_COMMISSION_PCT || '0');
const BATCH_SIZE     = parseInt(process.env.AUTO_SETTLE_BATCH_SIZE       || '40',   10);

// Catalog2 API base URL — same server, internal call
const CATALOG2_BASE  = process.env.CATALOG2_BASE_URL
  || process.env.API_BASE_URL
  || 'https://1xbetbackend.work.gd/api/v1';

// ── Error patterns ───────────────────────────────────────────
const DSC_0018_RE = /DSC-0018/i;
const TMR_RE      = /TOO_MANY_REQUESTS|ANGX-0008/i;

// ── In-memory caches ─────────────────────────────────────────
const _settled     = new Set();   // fully settled markets
const _inProgress  = new Set();   // currently settling (race guard)
const _betfairGone = new Set();   // DSC-0018 markets — skip Betfair book

// ✅ NEW: stuck-market visibility — pehle agar teeno layers har poll pe
// fail hoti thi to sirf logger.debug hota tha (jo practically kabhi nahi
// dikhta), koi warning ya alert nahi — is liye "kuch bets settle nahi
// hotay" wale cases silently forever chhupe rehte the. Ab har market ke
// consecutive-fail count track karte hain aur ek threshold ke baad LOUD
// warning dete hain + admin endpoint se list dekhi ja sakti hai.
const _failCount        = new Map();  // marketId → consecutive fail count
const _firstSeenFailing = new Map();  // marketId → jab pehli baar fail hua
const STUCK_THRESHOLD    = parseInt(process.env.AUTO_SETTLE_STUCK_THRESHOLD || '20', 10); // ~5 min @ 15s interval

/* ═══════════════════════════════════════════════════════════════
   rebuildSettledCache — startup mein already-settled markets load
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
    logger.info(`[AutoSettle v5] Startup: ${_settled.size} already-settled markets in cache`);
  } catch (e) {
    logger.warn('[AutoSettle v5] rebuildSettledCache error: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════
   LAYER 1: detectWinnerFromCatalog2
   ─────────────────────────────────
   Tumhara apna /markets/catalog2?id=xxx API call karo.
   Response mein runners[].status === 'WINNER' ya
   runners[].isWinner === true hota hai jab market close hoti hai.

   Yeh SABSE RELIABLE hai kyunki:
   - Betfair pe depend nahi
   - Market close hone ke saath hi update hota hai
   - Greyhound, Horse Race, Cricket — sab ke liye kaam karta hai
═══════════════════════════════════════════════════════════════ */
async function detectWinnerFromCatalog2(marketId) {
  try {
    const url = `${CATALOG2_BASE}/markets/catalog2?id=${encodeURIComponent(marketId)}`;
    const res  = await axios.get(url, { timeout: 8000 });

    const catalog = (res.data?.success && res.data?.data) ? res.data.data : res.data;
    if (!catalog) return null;

    const mktStatus = (catalog.status || '').toUpperCase();

    // ── METHOD A: Runner status === WINNER (Betfair book still available) ──
    const runners = catalog.runners || [];
    const byStatus = runners.find(r =>
      (r.status || '').toUpperCase() === 'WINNER' ||
      r.isWinner === true ||
      r.won === true
    );
    if (byStatus) {
      const winSel      = String(byStatus.selectionId || byStatus.selection_id || byStatus.id || '');
      const runnerName  = byStatus.runnerName || byStatus.name || null;
      const marketName  = catalog.marketName || catalog.market_name || catalog.name || null;
      if (winSel) {
        logger.info(`[AutoSettle v5] ✅ Catalog2 winner (status): market=${marketId} sel=${winSel} runner="${runnerName}"`);
        return { selectionId: winSel, runnerName, marketName };
      }
    }

    // ── If market not CLOSED yet, skip ──
    if (mktStatus !== 'CLOSED') {
      logger.debug(`[AutoSettle v5] Catalog2: market=${marketId} status=${mktStatus} — not closed yet`);
      return null;
    }

    // Market CLOSED hai lekin runner.status=WINNER nahi mila
    // (Betfair ne book remove kar di — book null tha, sab ACTIVE dikh rahe hain)
    // ── METHOD B: prices9 /markets/Data API se winner nikalo ──
    // prices9 ke MarketData mein WINNER runner hota hai even after Betfair closes
    logger.debug(`[AutoSettle v5] Catalog2: market=${marketId} CLOSED but no WINNER status — trying prices9 Data API`);

    try {
      const PRICES_BASE = process.env.PRICES_DATA_URL || 'https://prices9.mgs11.com/api/v1';
      const dataRes = await axios.get(`${PRICES_BASE}/markets/data?id=${encodeURIComponent(marketId)}`, { timeout: 6000 });
      const data    = (dataRes.data?.success && dataRes.data?.data) ? dataRes.data.data : dataRes.data;
      const books   = data?.marketBooks || (Array.isArray(data) ? data : []);
      const book    = books.find(b => String(b.id || b.marketId) === String(marketId)) || books[0];

      if (book) {
        const bookStatus = (book.marketStatus || book.status || '').toUpperCase();
        if (bookStatus === 'CLOSED') {
          // id field (prices9) ya selectionId (standard)
          const marketNameFromBook = book.marketName || book.market_name || catalog.marketName || catalog.market_name || catalog.name || null;

          const winner = (book.runners || []).find(r => (r.status || '').toUpperCase() === 'WINNER');
          if (winner) {
            const winSel = String(winner.id || winner.selectionId || '');
            if (winSel) {
              const runnerName = winner.runnerName || winner.name || null;
              logger.info(`[AutoSettle v5] ✅ prices9 Data API winner: market=${marketId} sel=${winSel} runner="${runnerName}"`);
              return { selectionId: winSel, runnerName, marketName: marketNameFromBook };
            }
          }

          // lastPriceTraded ≤ 1.01 fallback
          const byLPT = (book.runners || []).find(r => {
            const lpt = parseFloat(r.lastPriceTraded || 0);
            return lpt > 0 && lpt <= 1.01;
          });
          if (byLPT) {
            const winSel = String(byLPT.id || byLPT.selectionId || '');
            if (winSel) {
              const runnerName = byLPT.runnerName || byLPT.name || null;
              logger.info(`[AutoSettle v5] ✅ prices9 Data API winner (LPT): market=${marketId} sel=${winSel} runner="${runnerName}"`);
              return { selectionId: winSel, runnerName, marketName: marketNameFromBook };
            }
          }
        }
      }
    } catch (pricesErr) {
      logger.debug(`[AutoSettle v5] prices9 Data API failed [${marketId}]: ${pricesErr.message}`);
    }

    // ── METHOD C: winners count > 0 → sortPriority=1 fallback ──
    if (catalog.winners > 0) {
      const bySort = runners.find(r =>
        r.sortPriority === 1 || r.position === 1 || r.finishingPosition === 1
      );
      if (bySort) {
        const winSel     = String(bySort.selectionId || bySort.selection_id || bySort.id || '');
        const runnerName = bySort.runnerName || bySort.name || null;
        const marketName = catalog.marketName || catalog.market_name || catalog.name || null;
        if (winSel) {
          logger.info(`[AutoSettle v5] ✅ Catalog2 winner (sortPriority): market=${marketId} sel=${winSel} runner="${runnerName}"`);
          return { selectionId: winSel, runnerName, marketName };
        }
      }
    }

    logger.debug(`[AutoSettle v5] Catalog2+prices9: market=${marketId} CLOSED — winner still undetermined`);
    return null;

  } catch (e) {
    logger.warn(`[AutoSettle v5] Catalog2 fetch failed [${marketId}]: ${e.message}`);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   LAYER 2: detectWinnerFromBook (Betfair listMarketBook)
═══════════════════════════════════════════════════════════════ */
function detectWinnerFromBook(book) {
  if (!book) return null;
  if ((book.status || '').toUpperCase() !== 'CLOSED') return null;

  const runners    = book.runners || [];
  const marketName = book.marketName || book.market_name || null;

  // status === 'WINNER'
  const byStatus = runners.find(r => (r.status || '').toUpperCase() === 'WINNER');
  if (byStatus) {
    return {
      selectionId: String(byStatus.selectionId),
      // NOTE: Betfair listMarketBook usually does NOT include runner names
      // (only listMarketCatalogue does) — so this will often be null.
      // marketName/winnerRunnerName fall back to Catalog2/prices9 data
      // already captured earlier in processOneMarket, or stay null and
      // settleEventBets() will fall back to an Order's own runner_name.
      runnerName: byStatus.runnerName || byStatus.name || null,
      marketName,
    };
  }

  // lastPriceTraded ≤ 1.01
  const byPrice = runners.find(r => {
    const lpt = parseFloat(r.lastPriceTraded || 0);
    return lpt > 0 && lpt <= 1.01;
  });
  if (byPrice) {
    return {
      selectionId: String(byPrice.selectionId),
      runnerName:  byPrice.runnerName || byPrice.name || null,
      marketName,
    };
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════
   LAYER 3: detectWinnerFromPnL (Betfair listMarketProfitAndLoss)
═══════════════════════════════════════════════════════════════ */
async function detectWinnerFromPnL(marketId) {
  try {
    const results = await listMarketProfitAndLoss([marketId]);
    const market  = results?.[0];
    if (!market) return null;
    const winner = (market.profitAndLosses || []).find(p => Number(p.ifWin) > 0);
    if (!winner) return null;
    logger.info(`[AutoSettle v5] Winner via PnL: market=${marketId} sel=${winner.selectionId}`);
    // Betfair PnL endpoint has no runner/market names — settleEventBets()
    // will fall back to an Order's own runner_name if one exists.
    return { selectionId: String(winner.selectionId), runnerName: null, marketName: null };
  } catch (e) {
    if (TMR_RE.test(e.message)) logger.warn(`[AutoSettle v5] PnL rate-limited [${marketId}]`);
    else logger.warn(`[AutoSettle v5] PnL failed [${marketId}]: ${e.message}`);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   doSettle — duplicate-safe settlement trigger
═══════════════════════════════════════════════════════════════ */
async function doSettle(marketId, winInfo) {
  if (_settled.has(marketId)) return; // in-memory cache hit

  // Backward-compat: allow a plain selectionId string too
  const winSel      = typeof winInfo === 'string' ? winInfo : winInfo?.selectionId;
  const runnerName  = typeof winInfo === 'string' ? null    : winInfo?.runnerName || null;
  const marketName  = typeof winInfo === 'string' ? null    : winInfo?.marketName || null;

  // DB-level check: koi order already SETTLED hai to skip
  const alreadySettled = await Order.count({
    where: { market_id: marketId, status: ORDER_STATUS.SETTLED },
  });
  if (alreadySettled > 0) {
    _settled.add(marketId); // cache mein daal do
    logger.debug(`[AutoSettle v5] market=${marketId} already settled in DB — skipping`);
    return;
  }

  _settled.add(marketId); // optimistic lock
  _failCount.delete(marketId);          // ✅ settle ho gaya — fail-tracking clear
  _firstSeenFailing.delete(marketId);
  try {
    // ✅ BUG FIX: pehle winnerRunnerName/marketName pass hi nahi hote the —
    // Catalog2/prices9 se mile huye naam yahan tak aate aate discard ho jaate
    // the, is liye Order.winner_runner_name / market_name hamesha null rehte
    // the (Result page pe winner blank + Market Name == Match Name bug).
    const result = await settleEventBets(marketId, winSel, {
      commissionPct: COMMISSION_PCT,
      winnerRunnerName: runnerName,
      marketName,
    });
    logger.info(`[AutoSettle v5] ✅ Settled market=${marketId} winner=${winSel} runner="${runnerName}" users=${result.settled}`);
    return result;
  } catch (err) {
    _settled.delete(marketId); // rollback on error so retry happens next poll
    logger.error(`[AutoSettle v5] ❌ settleEventBets error [${marketId}]: ${err.message}`);
    throw err;
  }
}

/* ═══════════════════════════════════════════════════════════════
   processOneMarket — 3-layer winner detection for one market
═══════════════════════════════════════════════════════════════ */
async function processOneMarket(marketId) {
  if (_settled.has(marketId) || _inProgress.has(marketId)) return;
  _inProgress.add(marketId);

  try {
    let winSel = null;

    // ── LAYER 1: Catalog2 (our own API — always try first) ───
    winSel = await detectWinnerFromCatalog2(marketId);
    if (winSel) {
      await doSettle(marketId, winSel);
      return;
    }

    // ── LAYER 2: Betfair listMarketBook ──────────────────────
    if (!_betfairGone.has(marketId)) {
      try {
        const books = await listMarketBook([marketId], {
          priceData:  ['LAST_PRICE_TRADED'],
          virtualise: false,
        });
        const book = books?.[0];

        if (!book) {
          _betfairGone.add(marketId);
        } else {
          const bookStatus = (book.status || '').toUpperCase();
          if (bookStatus === 'CLOSED') {
            winSel = detectWinnerFromBook(book);
          } else {
            // Market still open on Betfair — not ready
            return;
          }
        }
      } catch (e) {
        if (DSC_0018_RE.test(e.message)) {
          _betfairGone.add(marketId);
          logger.debug(`[AutoSettle v5] market=${marketId} DSC-0018 — marked gone`);
        } else if (TMR_RE.test(e.message)) {
          logger.warn(`[AutoSettle v5] Rate-limited for ${marketId} — skip this cycle`);
          return;
        } else {
          logger.warn(`[AutoSettle v5] listMarketBook error [${marketId}]: ${e.message}`);
        }
      }
    }

    if (winSel) {
      await doSettle(marketId, winSel);
      return;
    }

    // ── LAYER 3: PnL endpoint ────────────────────────────────
    winSel = await detectWinnerFromPnL(marketId);
    if (winSel) {
      await doSettle(marketId, winSel);
      if (_betfairGone.has(marketId)) _betfairGone.delete(marketId);
    } else {
      // ✅ NEW: teeno layers fail ho gayi is poll cycle mein — count badhao
      // aur agar bohot der se stuck hai to LOUD warning do (pehle ye sirf
      // debug log tha jo kabhi kisi ko nazar nahi aata tha).
      const fails = (_failCount.get(marketId) || 0) + 1;
      _failCount.set(marketId, fails);
      if (!_firstSeenFailing.has(marketId)) _firstSeenFailing.set(marketId, Date.now());

      if (fails === STUCK_THRESHOLD) {
        const stuckMins = Math.round((Date.now() - _firstSeenFailing.get(marketId)) / 60000);
        logger.warn(
          `[AutoSettle v5] ⚠️ STUCK MARKET: ${marketId} — ${fails} consecutive poll(s) ` +
          `(~${stuckMins} min) mein koi bhi layer (Catalog2/Betfair-book/Betfair-PnL) winner nahi ` +
          `dhoondh saki. Manually check karo — ho sakta hai ye ek custom/non-Betfair submarket ` +
          `(Fancy/Bookmaker/Toss) ho jiska Catalog2 status kabhi CLOSED nahi hota, ya market ` +
          `abhi bhi sahi mein open hai. Manual settle ke liye: manualSettle('${marketId}', <winningSelectionId>)`
        );
      } else {
        logger.debug(`[AutoSettle v5] market=${marketId}: winner not determinable yet (fail #${fails}) — will retry next poll`);
      }
    }

  } finally {
    _inProgress.delete(marketId);
  }
}

/* ═══════════════════════════════════════════════════════════════
   pollAndSettle — main loop
   Har POLL_INTERVAL ms mein:
   1. DB se MATCHED bets wale sab market IDs nikalo
   2. Already settled / in-progress skip karo
   3. Har market ke liye 3-layer winner detection karo
═══════════════════════════════════════════════════════════════ */
let _pollRunning = false;

async function pollAndSettle() {
  if (_pollRunning) {
    logger.debug('[AutoSettle v5] Previous poll still running — skipping');
    return;
  }
  _pollRunning = true;

  try {
    // Find all markets with unsettled MATCHED bets
    const rows = await Order.findAll({
      attributes: ['market_id'],
      where:      { status: ORDER_STATUS.MATCHED },
      group:      ['market_id'],
      raw:        true,
    });

    if (!rows.length) return;

    const pending = rows
      .map(r => r.market_id)
      .filter(mid => !_settled.has(mid) && !_inProgress.has(mid));

    if (!pending.length) return;

    logger.debug(`[AutoSettle v5] Poll: checking ${pending.length} markets with MATCHED bets`);

    // Process all markets in parallel (limited concurrency)
    // Catalog2 calls are internal — no rate limit concern
    const CONCURRENCY = 10;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      const chunk = pending.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(mid =>
        processOneMarket(mid).catch(e =>
          logger.error(`[AutoSettle v5] processOneMarket error [${mid}]: ${e.message}`)
        )
      ));
    }

  } catch (err) {
    logger.error(`[AutoSettle v5] pollAndSettle error: ${err.message}`);
  } finally {
    _pollRunning = false;
  }
}

/* ═══════════════════════════════════════════════════════════════
   manualSettle — admin/fallback, can pass winner directly
═══════════════════════════════════════════════════════════════ */
async function manualSettle(marketId, winningSelectionId = null) {
  _settled.delete(marketId);
  _inProgress.delete(marketId);
  _betfairGone.delete(marketId);

  let winSel = winningSelectionId;

  if (!winSel) {
    // Try all 3 layers
    winSel = await detectWinnerFromCatalog2(marketId);
  }
  if (!winSel) {
    try {
      const books = await listMarketBook([marketId], { priceData: ['LAST_PRICE_TRADED'], virtualise: false });
      winSel = detectWinnerFromBook(books?.[0]);
    } catch (e) {
      if (!DSC_0018_RE.test(e.message)) logger.warn(`[AutoSettle v5] manualSettle book error: ${e.message}`);
    }
  }
  if (!winSel) winSel = await detectWinnerFromPnL(marketId);

  if (!winSel) {
    logger.warn(`[AutoSettle v5] manualSettle: winner not found for market=${marketId}`);
    return { settled: 0, reason: 'winner_not_found' };
  }

  return doSettle(marketId, winSel);
}

/* ═══════════════════════════════════════════════════════════════
   startAutoSettlement
   IDEMPOTENT: safe to call multiple times (e.g. once from server.js
   AND once as a safety-net from ordercontroller.js) — agar poller
   already chal raha hai to dobara interval nahi banayega. Isi wajah
   se pehle bug tha: agar server.js mein ye call miss/comment ho jaye
   (deploy ke baad, refactor ke baad, waghera), to poora auto-settle
   background loop kabhi start hi nahi hota tha — koi error bhi nahi
   aati thi, bas silently kuch settle nahi hota tha.
═══════════════════════════════════════════════════════════════ */
let _pollingStarted = false;

function startAutoSettlement() {
  if (_pollingStarted) {
    logger.debug('[AutoSettle v5] startAutoSettlement() called again — already running, skipping duplicate start');
    return;
  }
  _pollingStarted = true;

  logger.info(
    `[AutoSettle v5] Starting — interval=${POLL_INTERVAL/1000}s ` +
    `commission=${COMMISSION_PCT}% catalog2_base=${CATALOG2_BASE}`
  );
  rebuildSettledCache().then(() => {
    setTimeout(pollAndSettle, 5_000);      // first poll after 5s
    setInterval(pollAndSettle, POLL_INTERVAL);
    logger.info(`[AutoSettle v5] ✅ Running — first poll in 5s, then every ${POLL_INTERVAL/1000}s`);
  });
}

/* ═══════════════════════════════════════════════════════════════
   getStuckMarkets — admin endpoint ke liye: jo markets STUCK_THRESHOLD
   se zyada dafa fail ho chuke hain unki list (marketId + kitni der se
   + kitni baar fail hua), taake admin manually check/settle kar sake.
═══════════════════════════════════════════════════════════════ */
function getStuckMarkets() {
  const result = [];
  for (const [marketId, fails] of _failCount.entries()) {
    if (fails >= STUCK_THRESHOLD) {
      result.push({
        marketId,
        failCount:      fails,
        stuckSinceMs:   _firstSeenFailing.get(marketId) || null,
        stuckSinceMins: _firstSeenFailing.has(marketId)
          ? Math.round((Date.now() - _firstSeenFailing.get(marketId)) / 60000)
          : null,
      });
    }
  }
  return result;
}

module.exports = { startAutoSettlement, pollAndSettle, manualSettle, getStuckMarkets };
