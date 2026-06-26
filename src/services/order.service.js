'use strict';

const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { User, Order, Transaction } = require('../models');
const { getRunnerBook } = require('./betfair.service');
const { evaluateMatch, calculateLiability, computeTotalLiability } = require('./matching.service');
const { ORDER_STATUS, TRANSACTION_TYPE, BET_SIDE } = require('../config/constants');
const logger = require('../utils/logger');

/* ═══════════════════════════════════════════════════════════════
   recalculateLiability

   Invariant: totalFunds = wallet_balance + liable (constant)
   Naya wallet = totalFunds - newLiability
   Naya liable = newLiability
═══════════════════════════════════════════════════════════════ */
async function recalculateLiability(userId) {
  const user = await User.findByPk(userId);
  if (!user) return null;

  const allOrders = await Order.findAll({
    where: {
      user_id: userId,
      status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    },
    raw: true,
  });

  const matched = allOrders.filter(o => o.status === ORDER_STATUS.MATCHED);
  const pending = allOrders.filter(o => o.status === ORDER_STATUS.PENDING);

  const currentWallet = parseFloat(user.wallet_balance) || 0;
  const currentLiable = parseFloat(user.liable) || 0;
  const totalFunds    = currentWallet + currentLiable;

  let totalLiability      = 0;
  const combinedRunnerPnL = {};

  // ── MATCHED: Green-book market-wise ─────────────────────────
  const marketIds = [...new Set(matched.map(o => o.market_id))];
  for (const marketId of marketIds) {
    const marketOrders = matched.filter(o => o.market_id === marketId);
    let globalPnL = 0;
    const runnerAdj = {};

    for (const bet of marketOrders) {
      const sel   = String(bet.selection_id);
      const price = Number(bet.price);
      const size  = Number(bet.matched || bet.size);

      if (bet.side === BET_SIDE.BACK) {
        globalPnL -= size;
        runnerAdj[sel] = (runnerAdj[sel] || 0) + price * size;
      } else {
        globalPnL += size;
        runnerAdj[sel] = (runnerAdj[sel] || 0) - price * size;
      }
    }

    const potentials = [globalPnL];
    for (const [sel, adj] of Object.entries(runnerAdj)) {
      const runnerFinal = globalPnL + adj;
      potentials.push(runnerFinal);
      combinedRunnerPnL[sel] = (combinedRunnerPnL[sel] || 0) + runnerFinal;
    }

    const worstCase  = Math.min(...potentials);
    totalLiability  += worstCase < 0 ? Math.abs(worstCase) : 0;
  }

  // ── PENDING: simple per-bet liability ───────────────────────
  for (const bet of pending) {
    const price = parseFloat(bet.price);
    const size  = parseFloat(bet.size);
    totalLiability += bet.side === BET_SIDE.BACK ? size : (price - 1) * size;
  }

  const newWallet = Math.max(0, totalFunds - totalLiability);

  await user.update({
    wallet_balance: newWallet,
    liable:         totalLiability,
    runner_pnl:     combinedRunnerPnL,
  });

  const freshData = {
    wallet_balance: newWallet,
    liable:         totalLiability,
    runner_pnl:     combinedRunnerPnL,
  };

  if (global.io) {
    global.io.to(`user_${userId}`).emit('userUpdated', freshData);
  }

  logger.info(`Recalculated userId=${userId}: wallet=${newWallet.toFixed(2)}, liable=${totalLiability.toFixed(2)}`);
  return freshData;
}

/* ═══════════════════════════════════════════════════════════════
   autoMatchPendingBets
═══════════════════════════════════════════════════════════════ */
async function autoMatchPendingBets(marketId, selectionId) {
  try {
    const runner = await getRunnerBook(marketId, selectionId);
    if (!runner) return;

    const pendingOrders = await Order.findAll({
      where: {
        market_id:    marketId,
        selection_id: selectionId,
        status:       ORDER_STATUS.PENDING,
      },
    });

    for (const order of pendingOrders) {
      const { matchedSize, status, executedPrice } = evaluateMatch(order.toJSON(), runner);

      if (status === ORDER_STATUS.MATCHED) {
        await order.update({ matched: matchedSize, status, price: executedPrice });
        await recalculateLiability(order.user_id);

        if (global.io) {
          global.io.to(`match_${marketId}`).emit('ordersUpdated', {
            userId: order.user_id,
            newOrders: [{
              ...order.toJSON(),
              runnerName: order.runner_name || '',
            }],
          });
          global.io.to(`user_${order.user_id}`).emit('orderMatched', {
            order: { ...order.toJSON(), runnerName: order.runner_name || '' },
          });
        }

        logger.info(`Auto-matched order ${order.request_id} for user ${order.user_id} at price ${executedPrice}`);
      }
    }
  } catch (err) {
    logger.error(`autoMatchPendingBets error [market=${marketId}, sel=${selectionId}]: ${err.message}`);
  }
}

/* ═══════════════════════════════════════════════════════════════
   calculateRunnerPnL  (per-user, per-market)
═══════════════════════════════════════════════════════════════ */
function calculateRunnerPnL(marketOrders) {
  const runners = [...new Set(marketOrders.map(o => String(o.selection_id)))];
  const result  = {};

  for (const runnerId of runners) {
    let profitIfWin = 0;
    let lossIfWin   = 0;

    for (const bet of marketOrders) {
      const price = Number(bet.price);
      const size  = Number(bet.matched > 0 ? bet.matched : bet.size);
      const sel   = String(bet.selection_id);

      if (sel === runnerId) {
        if (bet.side === BET_SIDE.BACK) profitIfWin += (price - 1) * size;
        else                            lossIfWin   += (price - 1) * size;
      } else {
        if (bet.side === BET_SIDE.BACK) lossIfWin   += size;
        else                            profitIfWin += size;
      }
    }

    const net = profitIfWin - lossIfWin;
    result[runnerId] = {
      profit:    parseFloat(profitIfWin.toFixed(2)),
      liability: parseFloat(lossIfWin.toFixed(2)),
      net:       parseFloat(net.toFixed(2)),
    };
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════
   settleEventBets  ← CORE SETTLEMENT FUNCTION

   winningSelectionId = jo runner jeet gaya

   SETTLEMENT RULES (Exchange):
   ┌──────────────┬────────────┬──────────────────────────────┐
   │ Bet Type     │ Result     │ Outcome                      │
   ├──────────────┼────────────┼──────────────────────────────┤
   │ BACK winner  │ Win        │ credit = stake + profit      │
   │ BACK loser   │ Loss       │ stake already deducted       │
   │ LAY winner   │ Loss       │ liability already deducted   │
   │ LAY loser    │ Win        │ credit = stake (liability)   │
   └──────────────┴────────────┴──────────────────────────────┘

   ALL DB changes wrapped in a single Sequelize transaction →
   atomic: ya poora settle hoga ya kuch nahi.

   Duplicate protection: MATCHED orders hi process honge.
   Ek baar SETTLED ho gaye to dobara settle nahi honge.
═══════════════════════════════════════════════════════════════ */
async function settleEventBets(marketId, winningSelectionId, { commissionPct = 0 } = {}) {
  // ── Step 1: Check karo — koi MATCHED order hai bhi? ─────────
  const matchedOrders = await Order.findAll({
    where: { market_id: marketId, status: ORDER_STATUS.MATCHED },
  });

  // Dangling PENDING orders bhi cancel karo (unmatched at close)
  const danglingPending = await Order.findAll({
    where: { market_id: marketId, status: ORDER_STATUS.PENDING },
  });

  if (!matchedOrders.length && !danglingPending.length) {
    logger.warn(`[Settlement] No active orders for market ${marketId} — nothing to settle`);
    return { settled: 0, details: [] };
  }

  // ── Step 2: Users group karo ─────────────────────────────────
  const byUser = {};
  for (const o of matchedOrders) {
    const uid = String(o.user_id);
    (byUser[uid] = byUser[uid] || []).push(o);
  }

  let totalSettled = 0;
  const details    = [];
  const nowDate    = new Date();

  // ── Step 3: DB Transaction — atomic settlement ───────────────
  await sequelize.transaction(async (t) => {

    // 3a. Dangling PENDING → CANCELLED (market band ho gayi)
    if (danglingPending.length) {
      const pendingUserIds = [...new Set(danglingPending.map(o => String(o.user_id)))];
      await Order.update(
        { status: ORDER_STATUS.CANCELLED },
        {
          where: { market_id: marketId, status: ORDER_STATUS.PENDING },
          transaction: t,
        },
      );

      for (const uid of pendingUserIds) {
        const pendingBetsForUser = danglingPending.filter(o => String(o.user_id) === uid);
        await Transaction.create({
          user_id:      uid,
          type:         TRANSACTION_TYPE.BET_CANCELLED,
          amount:       0,
          description:  `Market closed — ${pendingBetsForUser.length} unmatched bet(s) auto-cancelled for market: ${pendingBetsForUser[0]?.event_name || marketId}`,
          status:       'completed',
          reference_id: String(marketId),
        }, { transaction: t });
      }

      logger.info(`[Settlement] market=${marketId}: ${danglingPending.length} dangling PENDING order(s) cancelled`);
    }

    if (!matchedOrders.length) {
      logger.warn(`[Settlement] market=${marketId}: only PENDING orders found, all cancelled. No matched bets to settle.`);
      return;
    }

    // 3b. Per-user settlement ────────────────────────────────────
    for (const [userId, bets] of Object.entries(byUser)) {
      const user = await User.findByPk(userId, { transaction: t, lock: t.LOCK.UPDATE });
      if (!user) {
        logger.error(`[Settlement] user ${userId} not found — skipping`);
        continue;
      }

      let totalWinCredit       = 0;
      let totalLoss            = 0;
      let totalLiableHeld      = 0;
      let totalLiabilityRelease = 0;  // ✅ poori liability jo wallet mein wapis aani chahiye
      let totalNetPnL           = 0;  // ✅ sirf extra profit/loss, liability ke upar

      // ── Calculate each bet result ──────────────────────────
      // BUG FIX (v6): Pehle "totalWinCredit"/"totalLoss" ko mix kar ke seedha
      // wallet credit banaya ja raha tha — lekin "LAY on loser" (jab tumhari
      // LAY jeet jati hai) ke case mein, hold ki gayi liability sirf 'liable'
      // field se minus ho rahi thi, wallet mein wapis credit nahi ho rahi thi.
      //
      // Ab har bet ke liye DO alag cheezen explicitly track karte hain:
      //   1) liabilityRelease — jo amount match hone par wallet se nikal kar
      //      'liable' mein hold ki gayi thi, woh HAMESHA wallet mein wapis
      //      aati hai jab bet settle hoti hai (chahe bet jeeti ho ya haari).
      //   2) netPnL — sirf EXTRA profit (agar koi mila) ya EXTRA loss
      //      (jo liability se upar ka loss ho, BACK ke case mein nahi hota
      //      kyunki BACK ka max loss = liability = stake hi hota hai).
      //
      // Final wallet credit (per bet) = liabilityRelease + netPnL
      //
      // ┌──────────────┬────────┬──────────────────┬───────────────────────┐
      // │ Bet Type     │ Result │ liabilityRelease │ netPnL                │
      // ├──────────────┼────────┼──────────────────┼───────────────────────┤
      // │ BACK winner  │ Win    │ +stake           │ +(price-1)*stake      │
      // │ BACK loser   │ Loss   │ +stake           │ -stake  (poora khona) │
      // │ LAY winner   │ Loss   │ +(price-1)*stake │ -(price-1)*stake      │
      // │ LAY loser    │ Win    │ +(price-1)*stake │ +stake                │
      // └──────────────┴────────┴──────────────────┴───────────────────────┘
      // BACK loser: liabilityRelease (+stake) aur netPnL (-stake) cancel ho
      // kar net = 0 hote hain (jo sahi hai — poora stake gaya, wallet credit 0).
      // LAY winner: liabilityRelease (+(price-1)*stake) aur netPnL
      // (-(price-1)*stake) cancel ho kar net = 0 hote hain (poori liability gayi).
      for (const bet of bets) {
        const price         = Number(bet.price);
        const effectiveSize = Number(bet.matched) > 0 ? Number(bet.matched) : Number(bet.size);
        const isWinner      = String(bet.selection_id) === String(winningSelectionId);
        const isBack        = bet.side === BET_SIDE.BACK;

        // Liability held for this bet (already locked out of wallet earlier)
        const liableHeld = isBack ? effectiveSize : (price - 1) * effectiveSize;
        totalLiableHeld  += liableHeld;

        let netPnL; // sirf extra profit (+) ya extra loss (-), liability ke upar
        if (isWinner) {
          if (isBack) {
            // Back on winner: stake wapis + profit
            netPnL = (price - 1) * effectiveSize;
            totalWinCredit += liableHeld + netPnL; // record-keeping ke liye (gross display)
          } else {
            // Lay on winner: poori liability ka loss
            netPnL = -liableHeld;
            totalLoss += liableHeld;
          }
        } else {
          if (isBack) {
            // Back on loser: poora stake gaya
            netPnL = -liableHeld;
            totalLoss += liableHeld;
          } else {
            // Lay on loser: stake jitna profit
            netPnL = effectiveSize;
            totalWinCredit += liableHeld + netPnL; // record-keeping ke liye (gross display)
          }
        }

        // ✅ Asal wallet credit: liability hamesha release hoti hai + net P&L
        totalLiabilityRelease += liableHeld;
        totalNetPnL           += netPnL;
      }

      // ── Commission on net profit only ──────────────────────
      const grossProfit = totalWinCredit - totalLiableHeld;
      const commission  = grossProfit > 0
        ? parseFloat((grossProfit * commissionPct / 100).toFixed(2))
        : 0;
      const netCredit   = totalWinCredit - commission;

      // ── Wallet update ───────────────────────────────────────
      const walletBefore = parseFloat(user.wallet_balance) || 0;
      const liableBefore = parseFloat(user.liable) || 0;

      // ✅ BUG FIX: ab liability hamesha poori release hoti hai wallet mein,
      // aur uske upar sirf net P&L (commission minus) add/subtract hota hai.
      // Pehle sirf "netCredit" (jo LAY-loser case mein liability include
      // nahi karta tha) add ho raha tha, jiski wajah se LAY jeetne par bhi
      // hold ki gayi liability wallet mein wapis nahi aati thi.
      const netCreditAfterCommission = totalNetPnL - commission;
      const newWallet = Math.max(0, walletBefore + totalLiabilityRelease + netCreditAfterCommission);
      const newLiable = Math.max(0, liableBefore - totalLiableHeld);

      await user.update(
        { wallet_balance: newWallet, liable: newLiable },
        { transaction: t },
      );

      // ── Mark orders as SETTLED ──────────────────────────────
      await Order.update(
        {
          status:               ORDER_STATUS.SETTLED,
          settled_at:           nowDate,
          winning_selection_id: String(winningSelectionId),
        },
        {
          where: {
            user_id:   userId,
            market_id: marketId,
            status:    ORDER_STATUS.MATCHED,
          },
          transaction: t,
        },
      );

      // ── Transaction record — Statement mein dikhega ─────────
      // ✅ BUG FIX: txnAmount ab sirf NET P&L hai (jo asal mein wallet mein
      // change aaya, liability ki temporary hold ko chhod kar) — pehle yahan
      // "netCredit - totalLiableHeld" tha jo LAY-jeetne ke case mein galat
      // negative number deta tha (statement mein loss jaisa dikhता, jabke
      // asal mein profit hua tha).
      const txnAmount = parseFloat(netCreditAfterCommission.toFixed(2));
      const matchName = bets[0]?.event_name || `Market ${marketId}`;
      const betSummary = bets.map(b => {
        const isW    = String(b.selection_id) === String(winningSelectionId);
        const sz     = Number(b.matched) > 0 ? Number(b.matched) : Number(b.size);
        const pnl    = b.side === BET_SIDE.BACK
          ? (isW ? +((Number(b.price) - 1) * sz).toFixed(2) : -(sz.toFixed(2)))
          : (isW ? -((Number(b.price) - 1) * sz).toFixed(2) : +(sz.toFixed(2)));
        const rName  = b.runner_name || `Sel-${b.selection_id}`;
        return `${b.side} ${rName}@${b.price} Stake:${sz} P&L:${pnl >= 0 ? '+' : ''}${pnl}`;
      }).join(' | ');

      await Transaction.create({
        user_id:      userId,
        type:         TRANSACTION_TYPE.BET_SETTLEMENT,
        amount:       txnAmount,
        description:  `SETTLED | Match: ${matchName} | WinnerId: ${winningSelectionId} | ${betSummary} | GrossP&L: ${grossProfit >= 0 ? '+' : ''}${grossProfit.toFixed(2)} | Commission: -${commission.toFixed(2)} | NetCredit: ${netCredit.toFixed(2)}`,
        status:       'completed',
        reference_id: String(marketId),
      }, { transaction: t });

      // ── Note: Order.settlement_pnl column abhi confirm nahi hai (migration
      // risk se bachne ke liye yahan nahi likh rahe) — statement.html apna
      // fallback calcPnL() formula use karega, jo ab sahi currentWallet ke
      // sath khud-ba-khud sahi result dega (asal bug wallet calculation mein
      // tha, woh upar fix ho gaya hai).

      // ── Collect details for response + socket ───────────────
      const runnerPnLMap = calculateRunnerPnL(bets.map(b => b.toJSON ? b.toJSON() : b));
      details.push({
        userId,
        grossProfit:    parseFloat(grossProfit.toFixed(2)),
        commission,
        netCredit:      parseFloat(netCredit.toFixed(2)),
        totalLoss:      parseFloat(totalLoss.toFixed(2)),
        liableReleased: parseFloat(totalLiableHeld.toFixed(2)),
        walletBefore,
        walletAfter:    newWallet,
        runnerPnL:      runnerPnLMap,
      });

      totalSettled++;
      logger.info(
        `[Settlement] userId=${userId} market=${marketId}: ` +
        `gross=${grossProfit.toFixed(2)} commission=${commission.toFixed(2)} ` +
        `net=${netCredit.toFixed(2)} loss=${totalLoss.toFixed(2)} ` +
        `liableReleased=${totalLiableHeld.toFixed(2)} ` +
        `walletBefore=${walletBefore.toFixed(2)} walletAfter=${newWallet.toFixed(2)}`
      );
    }
  }); // ← sequelize transaction ends here — all or nothing

  // ── Step 4: Liability recalculate (remaining active orders) ──
  // Transaction ke bahar — pure DB writes ho gaye hain
  const allAffectedUsers = [
    ...Object.keys(byUser),
    ...danglingPending.map(o => String(o.user_id)).filter(uid => !byUser[uid]),
  ];
  const uniqueUsers = [...new Set(allAffectedUsers)];

  for (const userId of uniqueUsers) {
    try {
      await recalculateLiability(userId);
    } catch (e) {
      logger.warn(`[Settlement] recalcLiability failed for userId=${userId}: ${e.message}`);
    }
  }

  // ── Step 5: Socket notifications ─────────────────────────────
  if (global.io) {
    // Per-user settlement notification
    for (const d of details) {
      global.io.to(`user_${d.userId}`).emit('userUpdated', {
        wallet_balance: d.walletAfter,
        liable:         Math.max(0, (parseFloat((await User.findByPk(d.userId, { raw: true }))?.liable) || 0)),
        event:          'settlement',
        marketId,
        winningSelectionId,
        settlement: {
          grossProfit:    d.grossProfit,
          commission:     d.commission,
          netCredit:      d.netCredit,
          totalLoss:      d.totalLoss,
          liableReleased: d.liableReleased,
          walletBefore:   d.walletBefore,
          walletAfter:    d.walletAfter,
        },
        runnerPnL: d.runnerPnL,
      });

      // Tell client to remove settled bets from Matched Bets section
      global.io.to(`user_${d.userId}`).emit('betsSettled', {
        marketId,
        winningSelectionId,
      });
    }

    // Broadcast to match room
    global.io.to(`match_${marketId}`).emit('marketSettled', {
      marketId,
      winningSelectionId,
      settledUsers: totalSettled,
    });
  }

  logger.info(`[Settlement] ✅ Complete for market=${marketId}: ${totalSettled} users settled, ${danglingPending.length} pending cancelled`);
  return { settled: totalSettled, details };
}

/* ═══════════════════════════════════════════════════════════════
   voidMarketBets  — Market VOID / Cancel karo
═══════════════════════════════════════════════════════════════ */
async function voidMarketBets(marketId) {
  const affectedOrders = await Order.findAll({
    where: {
      market_id: marketId,
      status: { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
    },
  });

  if (!affectedOrders.length) {
    logger.warn(`voidMarketBets: No active orders for market ${marketId}`);
    return { voided: 0 };
  }

  const byUser = {};
  for (const o of affectedOrders) {
    const uid = String(o.user_id);
    (byUser[uid] = byUser[uid] || []).push(o);
  }

  let totalVoided = 0;

  await sequelize.transaction(async (t) => {
    for (const [userId, bets] of Object.entries(byUser)) {
      const user = await User.findByPk(userId, { transaction: t });
      if (!user) continue;

      await Order.update(
        { status: ORDER_STATUS.CANCELLED },
        {
          where: {
            user_id:   userId,
            market_id: marketId,
            status:    { [Op.in]: [ORDER_STATUS.PENDING, ORDER_STATUS.MATCHED] },
          },
          transaction: t,
        },
      );

      await Transaction.create({
        user_id:      userId,
        type:         TRANSACTION_TYPE.BET_CANCELLED,
        amount:       0,
        description:  `VOID | Market: ${bets[0]?.event_name || marketId} — ${bets.length} bet(s) voided and stake returned`,
        status:       'completed',
        reference_id: String(marketId),
      }, { transaction: t });

      totalVoided++;
    }
  });

  for (const userId of Object.keys(byUser)) {
    const freshData = await recalculateLiability(userId);
    if (global.io && freshData) {
      global.io.to(`user_${userId}`).emit('userUpdated', {
        ...freshData,
        event: 'void',
        marketId,
      });
    }
  }

  if (global.io) {
    global.io.to(`match_${marketId}`).emit('marketVoided', { marketId, voidedUsers: totalVoided });
  }

  logger.info(`Void complete for market ${marketId}: ${totalVoided} users affected`);
  return { voided: totalVoided };
}

/* ═══════════════════════════════════════════════════════════════
   getMarketPnLSummary
═══════════════════════════════════════════════════════════════ */
async function getMarketPnLSummary(marketId, userId) {
  const orders = await Order.findAll({
    where: {
      market_id: marketId,
      user_id:   userId,
      status:    ORDER_STATUS.MATCHED,
    },
    raw: true,
  });

  if (!orders.length) return {};
  return calculateRunnerPnL(orders);
}

module.exports = {
  recalculateLiability,
  autoMatchPendingBets,
  settleEventBets,
  voidMarketBets,
  calculateRunnerPnL,
  getMarketPnLSummary,
};
