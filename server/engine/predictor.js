// server/engine/predictor.js  [v2.0 — multi-sport: Football + Basketball]
'use strict';

const { formulaManager }       = require('./formula');
const { orchestratePrediction } = require('../ai/orchestrator');
const { detectSport, getFormulaForSport, buildBasketballQuery, SPORTS } = require('./sport-router');
const { PrismaClient }         = require('@prisma/client');
const logger                   = require('../config/logger');
const prisma                   = new PrismaClient();

// ─── FOOTBALL QUERY BUILDER ───────────────────────────────────────────────────

function buildFootballQuery(match, formulaJson) {
  const { homeTeam, awayTeam, betType, betTarget, competition, scheduledAt } = match;
  const gameType = (() => {
    if (!competition) return 'standard';
    const c = competition.toLowerCase();
    if (c.includes('friendly')) return 'friendly';
    if (c.includes('cup') && !c.includes('league cup')) return 'cup';
    if (c.includes('champions') || c.includes('europa')) return 'european';
    return 'standard';
  })();
  const modifier = formulaJson.globalModifiers?.[`${gameType}GameDiscount`]
    || formulaJson.globalModifiers?.[`${gameType}GameBoost`] || 1.0;

  return `
FOOTBALL ORACLE — MATCH ANALYSIS

MATCH: ${homeTeam} vs ${awayTeam}
COMPETITION: ${competition || 'Unknown'}
SCHEDULED: ${scheduledAt || 'Today'}
BET TYPE: ${betType}${betTarget ? ` (Target: ${betTarget})` : ''}
GAME TYPE MODIFIER: ${modifier} (${gameType})

Search the web NOW for:
1. Latest lineups, team news for BOTH teams
2. Last 5 results + xG for both teams
3. Current injury/suspension lists
4. League standings and context
5. Head-to-head last 6 meetings
6. Weather and travel considerations

Then run all 6 formula layers and 3-simulation model.

BET: "${betType}"${betTarget ? ` on "${betTarget}"` : ''}

Return JSON ONLY. No preamble.`;
}

// ─── MAIN PREDICT MATCH ───────────────────────────────────────────────────────

async function predictMatch(match, userId, matchId) {
  const sport = detectSport(match);
  logger.info({ match: `${match.homeTeam} vs ${match.awayTeam}`, betType: match.betType, sport }, `🏀⚽ Starting ${sport} prediction`);

  const activeFormulaVersion = await getFormulaForSport(sport);
  const formulaJson          = activeFormulaVersion.formulaJson;

  const systemPrompt = activeFormulaVersion.systemPrompt || (
    sport === SPORTS.BASKETBALL
      ? require('./sports/basketball/prompt').generateBasketballSystemPrompt(formulaJson)
      : require('./formula').generateSystemPrompt(formulaJson)
  );

  const matchQuery = sport === SPORTS.BASKETBALL
    ? buildBasketballQuery(match, formulaJson)
    : buildFootballQuery(match, formulaJson);

  const { claudeOutput, gptOutput, consensusOutput, hadConflict, metadata } =
    await orchestratePrediction(systemPrompt, matchQuery, {
      consensusThreshold: formulaJson.aiConsensus?.consensusThreshold || 15,
      debateRounds:       formulaJson.aiConsensus?.debateRounds || 2,
      weights:            formulaJson.aiConsensus?.weightings || { claude: 0.60, gpt4: 0.40 },
    });

  // Apply global modifier
  const modifier = (() => {
    if (!match.competition || !formulaJson?.globalModifiers) return 1.0;
    const c  = match.competition.toLowerCase();
    const gm = formulaJson.globalModifiers;
    if (sport === SPORTS.BASKETBALL) {
      if (c.includes('preseason'))           return gm.preseasonDiscount    || 0.75;
      if (c.includes('play-in'))             return gm.playInGameBoost      || 1.12;
      if (c.includes('playoff') || c.includes('finals')) return gm.playoffBoost || 1.15;
      if (c.includes('all-star'))            return gm.allStarWeekendDiscount || 0.60;
      return gm.regularSeasonBase || 1.0;
    }
    if (c.includes('friendly'))              return gm.friendlyGameDiscount || 0.85;
    if (c.includes('cup'))                   return gm.cupGameBoost         || 1.05;
    return 1.0;
  })();

  const adjustedConfidence = Math.min(98, Math.round(consensusOutput.confidencePct * modifier));
  const adjustedTier       = adjustedConfidence >= 80 ? 'TIER1' : adjustedConfidence >= 65 ? 'TIER2' : 'TIER3';

  const scoreStr = sport === SPORTS.BASKETBALL
    ? (consensusOutput.predictedHomeScore != null ? `${consensusOutput.predictedHomeScore}-${consensusOutput.predictedAwayScore}` : null)
    : (consensusOutput.predictedScore || null);

  const prediction = await prisma.prediction.create({
    data: {
      matchId,
      userId,
      formulaVersionId:  activeFormulaVersion.id,
      sport,
      claudeOutput:      claudeOutput || {},
      gptOutput:         gptOutput || null,
      consensusOutput,
      predictedOutcome:  consensusOutput.predictedOutcome,
      predictedScore:    scoreStr,
      confidencePct:     adjustedConfidence,
      confidenceTier:    adjustedTier,
      keyDriver:         consensusOutput.keyDriver || '',
      redFlags:          consensusOutput.redFlags  || [],
      layerScores:       consensusOutput.layerScores || {},
      simulationResults: consensusOutput.simulationResults || {},
      verdict:           consensusOutput.verdict   || '',
      rationale:         consensusOutput.rationale || '',
      backToBackFlag:    consensusOutput.backToBackFlag || false,
      injuryImpact:      consensusOutput.injuryImpact  || 'NONE',
      betLine:           match.betLine || null,
    },
  });

  if (userId !== 'system') {
    await prisma.usageLog.create({
      data: {
        userId, action: 'PREDICT',
        tokensUsed: (metadata.claudeTokens?.input_tokens || 0) + (metadata.claudeTokens?.output_tokens || 0),
        model: 'claude-opus-4-5',
        cost:  Number(((metadata.claudeTokens?.input_tokens || 0) * 0.000015 + (metadata.claudeTokens?.output_tokens || 0) * 0.000075).toFixed(6)),
      },
    });
  }

  logger.info({ matchId, sport, outcome: consensusOutput.predictedOutcome, confidence: adjustedConfidence, tier: adjustedTier }, '✅ Prediction saved');

  return {
    predictionId: prediction.id, matchId, sport,
    homeTeam: match.homeTeam, awayTeam: match.awayTeam,
    betType: match.betType, betLine: match.betLine || null,
    predictedOutcome: consensusOutput.predictedOutcome,
    predictedScore: scoreStr, confidencePct: adjustedConfidence,
    confidenceTier: adjustedTier, keyDriver: consensusOutput.keyDriver,
    redFlags: consensusOutput.redFlags, layerScores: consensusOutput.layerScores,
    simulationResults: consensusOutput.simulationResults,
    verdict: consensusOutput.verdict, rationale: consensusOutput.rationale,
    hadAIConflict: hadConflict, formulaVersion: activeFormulaVersion.version,
    gameTypeModifier: modifier,
    backToBackFlag: consensusOutput.backToBackFlag || false,
    injuryImpact: consensusOutput.injuryImpact || 'NONE',
    paceAdvantage: consensusOutput.paceAdvantage || null,
  };
}

async function predictSlip(matches, userId, slipId) {
  const sports = {};
  matches.forEach(m => { const s = detectSport(m); sports[s] = (sports[s] || 0) + 1; });
  logger.info({ slipId, matchCount: matches.length, sports }, '📋 Predicting multi-sport slip');

  const results = [];
  for (const match of matches) {
    try {
      const dbMatch = await prisma.match.findFirst({ where: { slipId, homeTeam: match.homeTeam, awayTeam: match.awayTeam } });
      if (!dbMatch) continue;
      results.push(await predictMatch(match, userId, dbMatch.id));
      await new Promise(r => setTimeout(r, 600));
    } catch (err) {
      logger.error({ err: err.message, match }, 'Match prediction failed');
      results.push({ homeTeam: match.homeTeam, awayTeam: match.awayTeam, error: err.message, failed: true });
    }
  }

  await prisma.betSlip.update({ where: { id: slipId }, data: { status: results.some(r => r.failed) ? 'FAILED' : 'PREDICTED' } });
  return results;
}

module.exports = { predictMatch, predictSlip };
