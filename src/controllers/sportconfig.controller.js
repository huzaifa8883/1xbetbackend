'use strict';

const { SportConfig } = require('../models');
const { sendSuccess, sendError } = require('../utils/response');
const { listCompetitions } = require('../services/betfair.service');

// Default config for each sport
const DEFAULTS = [
  { sport_key: 'cricket',    sport_name: 'Cricket',          event_type_id: '4',    max_results: 20, market_types: 'MATCH_ODDS', hours_ahead: 24 },
  { sport_key: 'football',   sport_name: 'Football',         event_type_id: '1',    max_results: 20, market_types: 'MATCH_ODDS', hours_ahead: 24 },
  { sport_key: 'tennis',     sport_name: 'Tennis',           event_type_id: '2',    max_results: 20, market_types: 'MATCH_ODDS', hours_ahead: 24 },
  { sport_key: 'horse',      sport_name: 'Horse Racing',     event_type_id: '7',    max_results: 100, market_types: 'WIN', hours_ahead: 24 },
  { sport_key: 'greyhound',  sport_name: 'Greyhound Racing', event_type_id: '4339', max_results: 100, market_types: 'WIN', hours_ahead: 12 },
];

/* ── GET /api/v1/sport-config  ───────────────────────────── */
async function getAllConfigs(req, res) {
  let configs = await SportConfig.findAll({ order: [['id', 'ASC']] });

  // Seed defaults if DB is empty
  if (configs.length === 0) {
    await SportConfig.bulkCreate(DEFAULTS);
    configs = await SportConfig.findAll({ order: [['id', 'ASC']] });
  }

  return sendSuccess(res, { configs });
}

/* ── GET /api/v1/sport-config/:key  ──────────────────────── */
async function getConfig(req, res) {
  const cfg = await SportConfig.findOne({ where: { sport_key: req.params.key } });
  if (!cfg) return sendError(res, 'Sport config not found', 404);
  return sendSuccess(res, { config: cfg });
}

/* ── PUT /api/v1/sport-config/:key  ──────────────────────── */
async function updateConfig(req, res) {
  const {
    is_active, max_results, allowed_countries,
    allowed_competition_ids, market_types,
    inplay_only, hours_ahead,
  } = req.body;

  let cfg = await SportConfig.findOne({ where: { sport_key: req.params.key } });

  if (!cfg) {
    // Auto-create from defaults
    const def = DEFAULTS.find((d) => d.sport_key === req.params.key);
    if (!def) return sendError(res, 'Unknown sport key', 400);
    cfg = await SportConfig.create(def);
  }

  await cfg.update({
    ...(is_active !== undefined && { is_active }),
    ...(max_results !== undefined && { max_results: parseInt(max_results, 10) }),
    ...(allowed_countries !== undefined && { allowed_countries: allowed_countries || null }),
    ...(allowed_competition_ids !== undefined && { allowed_competition_ids: allowed_competition_ids || null }),
    ...(market_types !== undefined && { market_types: market_types || 'MATCH_ODDS' }),
    ...(inplay_only !== undefined && { inplay_only }),
    ...(hours_ahead !== undefined && { hours_ahead: parseInt(hours_ahead, 10) }),
  });

  return sendSuccess(res, { config: cfg }, 'Sport config updated');
}

/* ── GET /api/v1/sport-config/:key/competitions  ─────────── */
/* Fetches available competitions from Betfair for this sport  */
async function getCompetitions(req, res) {
  const cfg = await SportConfig.findOne({ where: { sport_key: req.params.key } });
  if (!cfg) return sendError(res, 'Sport config not found', 404);

  const competitions = await listCompetitions({ eventTypeIds: [cfg.event_type_id] });
  const data = competitions.map((c) => ({
    id: c.competition.id,
    name: c.competition.name,
    region: c.competitionRegion,
    marketCount: c.marketCount,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return sendSuccess(res, { competitions: data });
}

module.exports = { getAllConfigs, getConfig, updateConfig, getCompetitions };
