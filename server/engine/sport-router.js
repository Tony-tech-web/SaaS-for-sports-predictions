// server/engine/sport-router.js
// Central sport dispatcher — routes all prediction/verification requests
// to the correct sport-specific engine based on the 'sport' field
// Supports: FOOTBALL, BASKETBALL (extensible to TENNIS, CRICKET, etc.)

'use strict';

const { formulaManager }                                      = require('./formula');
const { BASE_BASKETBALL_FORMULA }                             = require('./sports/basketball/formula');
const { generateBasketballSystemPrompt }                      = require('./sports/basketball/prompt');
const { evaluateBasketballPrediction, identifyBasketballFailedLayer } = require('./sports/basketball/verifier');
const { generateSystemPrompt }                                = require('./formula');
const { PrismaClient }                                        = require('@prisma/client');
const logger                                                  = require('../config/logger');

const prisma = new PrismaClient();

// ─── SPORT CONSTANTS ──────────────────────────────────────────────────────────

const SPORTS = {
  FOOTBALL:   'FOOTBALL',
  BASKETBALL: 'BASKETBALL',
};

const SPORT_COMPETITIONS = {
  FOOTBALL: [
    'Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1',
    'Champions League', 'Europa League', 'MLS', 'Eredivisie',
    'Liga MX', 'Liga BetPlay', 'Liga Nacional Guatemala', 'Scottish Premiership',
    'League One', 'Championship', 'International Friendly', 'World Cup Qualifying',
  ],
  BASKETBALL: [
    'NBA', 'EuroLeague', 'FIBA World Cup', 'FIBA EuroBasket',
    'NBL', 'Liga ACB', 'Turkish BSL', 'VTB United League',
    'NCAA Basketball', 'G-League', 'NBA Summer League',
    'NBA Playoffs', 'NBA Play-In', 'NBA Preseason',
  ],
};

// ─── SPORT DETECTOR ───────────────────────────────────────────────────────────

function detectSport(input) {
  if (input.sport) return input.sport.toUpperCase();

  const comp = (input.competition || '').toLowerCase();
  const home = (input.homeTeam || '').toLowerCase();
  const away = (input.awayTeam || '').toLowerCase();
  const text = `${comp} ${home} ${away}`;

  // Basketball keywords
  const basketballKeywords = [
    'nba', 'euroleague', 'fiba', 'nbl', 'liga acb', 'basketball',
    'celtics', 'lakers', 'warriors', 'heat', 'nets', 'bulls', 'knicks',
    'bucks', 'nuggets', 'suns', 'clippers', 'spurs', 'raptors', 'thunder',
    'mavericks', 'rockets', 'sixers', '76ers', 'wizards', 'hornets',
    'real madrid basket', 'barcelona basket', 'fenerbahce', 'anadolu efes',
  ];

  if (basketballKeywords.some(k => text.includes(k))) {
    return SPORTS.BASKETBALL;
  }

  return SPORTS.FOOTBALL; // Default
}

// ─── FORMULA LOADER ───────────────────────────────────────────────────────────

async function getFormulaForSport(sport) {
  if (sport === SPORTS.BASKETBALL) {
    // Load basketball formula from DB or use base
    try {
      const dbFormula = await prisma.formulaVersion.findFirst({
        where: { isActive: true, sport: 'BASKETBALL' },
        orderBy: { createdAt: 'desc' },
      });
      if (dbFormula) return dbFormula;
    } catch {
      // DB may not have sport column yet — use base
    }

    return {
      id: 'basketball-base',
      version: BASE_BASKETBALL_FORMULA.version,
      formulaJson: BASE_BASKETBALL_FORMULA,
      systemPrompt: generateBasketballSystemPrompt(BASE_BASKETBALL_FORMULA),
    };
  }

  // Football — use existing formula manager
  return formulaManager.getActiveFormula();
}

// ─── MATCH QUERY BUILDER ──────────────────────────────────────────────────────

function buildBasketballQuery(match, formulaJson) {
  const { homeTeam, awayTeam, betType, betLine, competition, scheduledAt } = match;

  const gamePhase = detectGamePhase(competition);
  const modifier  = formulaJson.globalModifiers[`${gamePhase}Boost`]
    || formulaJson.globalModifiers[`${gamePhase}Discount`]
    || 1.0;

  return `
SPORTS ORACLE — BASKETBALL MATCH ANALYSIS

MATCH: ${homeTeam} vs ${awayTeam}
COMPETITION: ${competition || 'Unknown'}
SCHEDULED: ${scheduledAt || 'Today'}
BET TYPE: ${betType}${betLine != null ? ` (Line: ${betLine})` : ''}
GAME PHASE: ${gamePhase} (modifier: ×${modifier})

TASK: Using all 6 layers of the basketball formula, search the web NOW for:

1. Official NBA injury report / team availability for BOTH ${homeTeam} AND ${awayTeam}
2. Back-to-back schedule — did either team play last night?
3. Last 5 game results with offensive/defensive ratings
4. Current standings, playoff seed positioning
5. Head-to-head record this season and last 3 seasons
6. Starting lineup announcements (check team social media)
7. Pace statistics (fast vs slow: possessions per game)
8. Any load management, rest day, or coach statements
9. Arena atmosphere notes (sell-out? rivalry?)
10. Travel schedule — time zones crossed for away team

After searching, run all 6 layers sequentially, then 3-simulation weighted model.

BET TO EVALUATE: "${betType}"${betLine != null ? ` at ${betLine}` : ''}

Return your prediction in the mandatory JSON format ONLY. No preamble. No markdown.
`;
}

function detectGamePhase(competition) {
  if (!competition) return 'regularSeason';
  const c = competition.toLowerCase();
  if (c.includes('preseason')) return 'preseason';
  if (c.includes('play-in') || c.includes('playin')) return 'playIn';
  if (c.includes('playoff') || c.includes('finals')) return 'playoff';
  if (c.includes('all-star') || c.includes('allstar')) return 'allStarWeekend';
  if (c.includes('summer')) return 'summerLeague';
  return 'regularSeason';
}

// ─── OUTCOME EVALUATOR ROUTER ────────────────────────────────────────────────

function evaluatePrediction(sport, prediction, result) {
  if (sport === SPORTS.BASKETBALL) {
    return evaluateBasketballPrediction(prediction, result);
  }
  // Football — use existing evaluator
  const { evaluatePrediction: footEval } = require('./verifier');
  return footEval(prediction, result);
}

function identifyFailedLayer(sport, prediction, result, failureType) {
  if (sport === SPORTS.BASKETBALL) {
    return identifyBasketballFailedLayer(prediction, result, failureType);
  }
  const { identifyMostLikelyFailedLayer } = require('./verifier');
  return identifyMostLikelyFailedLayer(prediction, result, failureType);
}

// ─── SLIP SPORT SUMMARY ───────────────────────────────────────────────────────

function getSlipSportBreakdown(matches) {
  const breakdown = { FOOTBALL: 0, BASKETBALL: 0, UNKNOWN: 0 };
  for (const m of matches) {
    const sport = detectSport(m);
    breakdown[sport] = (breakdown[sport] || 0) + 1;
  }
  return breakdown;
}

module.exports = {
  detectSport,
  getFormulaForSport,
  buildBasketballQuery,
  detectGamePhase,
  evaluatePrediction,
  identifyFailedLayer,
  getSlipSportBreakdown,
  SPORTS,
  SPORT_COMPETITIONS,
};
