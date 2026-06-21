'use strict';
/*
  DEBUG ROUTE — server pe yeh temporarily add karo
  File: routes/debugSettle.js

  Test karo:
  GET  /debug/settle-status/1.259320440   → market ka Book API response dekho
  POST /debug/settle-now/1.259320440      → force settle karo
*/

const express = require('express');
const router  = express.Router();

const PRICES_BASE  = process.env.PRICES_DATA_URL || 'https://prices9.mgs11.com/api/v1';
const CATALOG_BASE = process.env.PRICES_API_URL  || process.env.OWN_API_URL || 'https://1xbetbackend.work.gd/api/v1';

// GET /debug/settle-status/:marketId
// → prices API ka raw response dekho
router.get('/settle-status/:marketId', async (req, res) => {
  const { marketId } = req.params;
  try {
    const [bookRes, catRes] = await Promise.all([
      fetch(`${PRICES_BASE}/markets/data?id=${marketId}`).then(r => r.json()).catch(e => ({ error: e.message })),
      fetch(`${CATALOG_BASE}/markets/catalog2?id=${marketId}`).then(r => r.json()).catch(e => ({ error: e.message })),
    ]);

    // Book API se market extract karo
    const bookData = (bookRes.success && bookRes.data) ? bookRes.data : bookRes;
    const books    = bookData.marketBooks || [];
    const book     = books.find(b => String(b.id) === String(marketId)) || books[0] || null;

    return res.json({
      marketId,
      bookAPI: {
        url:          `${PRICES_BASE}/markets/data?id=${marketId}`,
        marketStatus: book?.marketStatus || 'NOT FOUND',
        runners:      (book?.runners || []).map(r => ({ id: r.id, status: r.status })),
        rawBook:      book,
      },
      catalogAPI: {
        url:     `${CATALOG_BASE}/markets/catalog2?id=${marketId}`,
        status:  catRes?.data?.status || catRes?.status || 'NOT IN RESPONSE',
        runners: ((catRes?.data || catRes)?.runners || []).map(r => ({
          selectionId:     r.selectionId,
          status:          r.status,
          lastPriceTraded: r.lastPriceTraded,
        })),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /debug/settle-now/:marketId
// → force settle karo
router.post('/settle-now/:marketId', async (req, res) => {
  const { marketId } = req.params;
  try {
    const { manualSettle } = require('../services/autoSettle.service');
    await manualSettle(marketId);
    return res.json({ ok: true, message: `Settle triggered for ${marketId}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;