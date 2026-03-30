// server/engine/verifier.js
// Self-healing result verifier
// Compares predicted vs actual, identifies the failing layer, patches ONLY that layer

'use strict';

const { PrismaClient } = require('@prisma/client');
const { formulaManager } = require('./formula');
const { callClaude } = require('../ai/orchestrator');
const logger = require('../config/logger');

const prisma = new PrismaClient();

// ─── OUTCOME EVALUATOR ────────────────────────────────────────────────────────

function evaluatePrediction(prediction, result) {
  const { predictedOutcome, confidenceTier } = prediction;
  const { homeScore, awayScore, actualOutcome, totalGoals } = result;

  let wasCorrect = false;
  let failureType = null;
  let predictedValue = predictedOutcome;
  let actualValue = actualOutcome;

  // ── Evaluate based on bet type ──────────────────────────────────────────
  if (predictedOutcome === 'HOME') {
    wasCorrect = actualOutcome === 'HOME';
    actualValue = actualOutcome;
  } else if (predictedOutcome === 'AWAY') {
    wasCorrect = actualOutcome === 'AWAY';
    actualValue = actualOutcome;
  } else if (predictedOutcome === 'DRAW') {
    wasCorrect = actualOutcome === 'DRAW';
    actualValue = actualOutcome;
  } else if (predictedOutcome.startsWith('OVER_')) {
    const threshold = parseFloat(predictedOutcome.replace('OVER_', ''));
    wasCorrect = totalGoals > threshold;
    actualValue = `${totalGoals} goals`;
    predictedValue = `Over ${threshold}`;
    if (!wasCorrect) failureType = 'WRONG_GOALS';
  } else if (predictedOutcome.startsWith('UNDER_')) {
    const threshold = parseFloat(predictedOutcome.replace('UNDER_', ''));
    wasCorrect = totalGoals < threshold;
    actualValue = `${totalGoals} goals`;
    predictedValue = `Under ${threshold}`;
    if (!wasCorrect) failureType = 'WRONG_GOALS';
  } else if (predictedOutcome === 'BTTS_YES') {
    wasCorrect = homeScore > 0 && awayScore > 0;
    actualValue = (homeScore > 0 && awayScore > 0) ? 'BTTS YES' : 'BTTS NO';
    predictedValue = 'BTTS YES';
  } else if (predictedOutcome === 'BTTS_NO') {
    wasCorrect = homeScore === 0 || awayScore === 0;
    actualValue = (homeScore === 0 || awayScore === 0) ? 'BTTS NO' : 'BTTS YES';
    predictedValue = 'BTTS NO';
  }

  if (!wasCorrect && !failureType) {
    failureType = 'WRONG_OUTCOME';
  }

  return { wasCorrect, failureType, predictedValue, actualValue };
}

// ─── LAYER FAILURE ANALYSER ──────────────────────────────────────────────────

function identifyMostLikelyFailedLayer(prediction, result, failureType) {
  const layerScores = prediction.layerScores || {};
  const simResults = prediction.simulationResults || {};
  const { homeScore, awayScore, totalGoals } = result;

  // Heuristic rules based on failure pattern:

  // If confidence was very high but still failed → simulation was wrong
  if (prediction.confidencePct > 80 && failureType === 'WRONG_OUTCOME') {
    return 'L6_SIMULATION';
  }

  // If a goals bet failed but the match was a low-scoring defensive game → form data was off
  if (failureType === 'WRONG_GOALS' && totalGoals < 1) {
    return 'L1_FORM';
  }

  // If home team lost but was predicted to win strongly → psychology/motivation was wrong
  if (failureType === 'WRONG_OUTCOME' && prediction.predictedOutcome === 'HOME') {
    const redFlags = prediction.redFlags || [];
    const hadMotivationFlag = redFlags.some(f => f.toLowerCase().includes('motivation') || f.toLowerCase().includes('cup') || f.toLowerCase().includes('friendly'));
    if (hadMotivationFlag) return 'L4_PSYCHOLOGY';
  }

  // If an away team won against prediction → away form was underweighted
  if (failureType === 'WRONG_OUTCOME' && prediction.predictedOutcome === 'HOME' && result.actualOutcome === 'AWAY') {
    return 'L1_FORM'; // Away form wasn't weighted correctly
  }

  // If total goals were wildly off → environment/weather or squad factors
  if (failureType === 'WRONG_GOALS') {
    const totalGoalsDiff = Math.abs(totalGoals - 2.5); // vs typical expected
    if (totalGoalsDiff > 2) return 'L5_ENVIRONMENT';
    return 'L2_SQUAD';
  }

  // If draw was not predicted → simulation draw cap too aggressive
  if (failureType === 'WRONG_OUTCOME' && result.actualOutcome === 'DRAW') {
    return 'L6_SIMULATION';
  }

  // Default: simulation layer is responsible for final aggregation errors
  return 'L6_SIMULATION';
}

// ─── AI ROOT CAUSE ANALYSIS ───────────────────────────────────────────────────

async function runRootCauseAnalysis(prediction, result, failedLayer) {
  const systemPrompt = `You are a football prediction forensics expert. Your job is to identify precisely WHY a prediction failed and recommend the MINIMUM surgical change to the formula's ${failedLayer} layer to prevent this specific failure in future.

CRITICAL RULES:
- Suggest changes ONLY to the ${failedLayer} layer
- Suggest ADDITIONS only — never deletions
- The modifier must be a small, specific JSON object that can be merged into the layer config
- Do not change layer weights globally — only add a new contextual modifier
- Return a JSON object ONLY`;

  const analysisQuery = `
PREDICTION FAILURE ANALYSIS

Match: ${prediction.match?.homeTeam || 'Home'} vs ${prediction.match?.awayTeam || 'Away'}
Competition: ${prediction.match?.competition || 'Unknown'}
Bet Type: ${prediction.match?.betType || 'Unknown'}

PREDICTION:
- Predicted Outcome: ${prediction.predictedOutcome}
- Confidence: ${prediction.confidencePct}%
- Key Driver: ${prediction.keyDriver}
- Red Flags (IGNORED): ${JSON.stringify(prediction.redFlags)}
- Layer Scores: ${JSON.stringify(prediction.layerScores)}
- Simulation Results: ${JSON.stringify(prediction.simulationResults)}
- Verdict: ${prediction.verdict}

ACTUAL RESULT:
- Score: ${result.homeScore}-${result.awayScore}
- Outcome: ${result.actualOutcome}
- Total Goals: ${result.totalGoals}

IDENTIFIED FAILING LAYER: ${failedLayer}

TASK: Analyse why ${failedLayer} produced incorrect weighting. Provide:
{
  "failureAnalysis": "Precise explanation of why this layer failed in 2-3 sentences",
  "rootCause": "The single most important factor this layer missed",
  "modifierToAdd": {
    "description": "Name of the modifier",
    "trigger": "When this modifier should activate (specific condition)",
    "adjustment": number,
    "adjustmentType": "multiplier" | "additive",
    "appliesTo": "confidence" | "xg" | "probability"
  },
  "patchDescription": "One sentence describing what this patch does",
  "aiReasoning": "Why this specific fix addresses the root cause without breaking other predictions"
}`;

  try {
    const result2 = await callClaude(systemPrompt, analysisQuery, { maxTokens: 800 });
    const text = result2.raw;

    // Parse the JSON
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(text.slice(start, end + 1));
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Root cause analysis failed');
  }

  // Fallback patch
  return {
    failureAnalysis: `${failedLayer} produced incorrect weighting for this specific match context`,
    rootCause: 'Context-specific factor not adequately captured by current formula',
    modifierToAdd: {
      description: 'auto_patch_modifier',
      trigger: 'formula_failure_correction',
      adjustment: -0.05,
      adjustmentType: 'additive',
      appliesTo: 'confidence',
    },
    patchDescription: `Auto-correction patch for ${failedLayer} failure`,
    aiReasoning: 'Conservative patch to reduce overconfidence in similar scenarios',
  };
}

// ─── MAIN VERIFY & PATCH FUNCTION ────────────────────────────────────────────

/**
 * Verify a match result and trigger self-healing if prediction was wrong
 * @param {string} matchId
 * @param {Object} resultData - { homeScore, awayScore, source }
 */
async function verifyAndPatch(matchId, resultData) {
  logger.info({ matchId }, '🔍 Verifying match result');

  // 1. Load match + prediction
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    include: { prediction: true, slip: true },
  });

  if (!match) throw new Error(`Match ${matchId} not found`);
  if (!match.prediction) {
    logger.warn({ matchId }, 'No prediction found for match — skipping verification');
    return null;
  }

  const { homeScore, awayScore, source = 'MANUAL' } = resultData;

  // 2. Determine actual outcome
  let actualOutcome;
  if (homeScore > awayScore) actualOutcome = 'HOME';
  else if (awayScore > homeScore) actualOutcome = 'AWAY';
  else actualOutcome = 'DRAW';

  const totalGoals = homeScore + awayScore;

  // 3. Save the result
  const matchResult = await prisma.matchResult.create({
    data: {
      matchId,
      homeScore,
      awayScore,
      actualOutcome,
      totalGoals,
      source,
    },
  });

  // 4. Evaluate prediction
  const { wasCorrect, failureType, predictedValue, actualValue } = evaluatePrediction(
    match.prediction,
    { homeScore, awayScore, actualOutcome, totalGoals }
  );

  // 5. Update prediction record
  await prisma.prediction.update({
    where: { id: match.prediction.id },
    data: {
      isVerified: true,
      wasCorrect,
    },
  });

  // 6. Update formula version accuracy stats
  const activeFormula = await formulaManager.getActiveFormula();
  await prisma.formulaVersion.update({
    where: { id: activeFormula.id },
    data: {
      totalPredictions: { increment: 1 },
      correctPredictions: wasCorrect ? { increment: 1 } : undefined,
    },
  });

  logger.info({ matchId, wasCorrect, failureType, predictedValue, actualValue }, '📊 Prediction verified');

  // 7. ── SELF-HEALING TRIGGER ────────────────────────────────────────────────
  if (!wasCorrect) {
    logger.info({ matchId, failureType }, '🔧 Prediction failed — triggering formula patch');

    // Identify which layer failed
    const failedLayer = identifyMostLikelyFailedLayer(
      match.prediction,
      { homeScore, awayScore, actualOutcome, totalGoals },
      failureType
    );

    // Load full prediction with match for context
    const fullPrediction = {
      ...match.prediction,
      match: {
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        competition: match.competition,
        betType: match.betType,
      },
    };

    // Run AI root cause analysis
    const rootCause = await runRootCauseAnalysis(
      fullPrediction,
      { homeScore, awayScore, actualOutcome, totalGoals },
      failedLayer
    );

    // Build the patch diff (only the modifier, added to patches array)
    const patchDiff = {};  // No structural changes — only modifier appended via patches[]
    const modifierAdded = rootCause.modifierToAdd;

    // Apply the patch — creates new formula version
    const { newFormulaVersion, formulaPatch } = await formulaManager.applyPatch({
      fromVersionId: activeFormula.id,
      resultId: matchResult.id,
      failedLayer,
      patchDiff,
      modifierAdded,
      patchDescription: rootCause.patchDescription,
      aiReasoning: rootCause.aiReasoning,
      failureAnalysis: rootCause.failureAnalysis,
      failureType,
      predictedValue,
      actualValue,
    });

    // Mark prediction as patched
    await prisma.prediction.update({
      where: { id: match.prediction.id },
      data: { formulaPatchApplied: true },
    });

    logger.info({
      failedLayer,
      newVersion: newFormulaVersion.version,
      patchDescription: rootCause.patchDescription,
    }, '✅ Formula self-healed — new version active');

    return {
      verified: true,
      wasCorrect: false,
      failureType,
      predictedValue,
      actualValue,
      selfHealed: true,
      failedLayer,
      newFormulaVersion: newFormulaVersion.version,
      patchApplied: rootCause.patchDescription,
      rootCause: rootCause.failureAnalysis,
    };
  }

  return {
    verified: true,
    wasCorrect: true,
    actualOutcome,
    score: `${homeScore}-${awayScore}`,
    selfHealed: false,
  };
}

// ─── BATCH RESULT VERIFICATION ────────────────────────────────────────────────

/**
 * Verify multiple results at once
 * @param {Array} results - [{ matchId, homeScore, awayScore, source }]
 */
async function verifyBatch(results) {
  logger.info({ count: results.length }, '📦 Starting batch verification');

  const outcomes = [];
  for (const r of results) {
    try {
      const outcome = await verifyAndPatch(r.matchId, {
        homeScore: r.homeScore,
        awayScore: r.awayScore,
        source: r.source || 'MANUAL',
      });
      outcomes.push({ matchId: r.matchId, ...outcome });
    } catch (err) {
      logger.error({ matchId: r.matchId, err: err.message }, 'Batch verification error');
      outcomes.push({ matchId: r.matchId, error: err.message });
    }
  }

  const correct = outcomes.filter(o => o.wasCorrect).length;
  const patched = outcomes.filter(o => o.selfHealed).length;

  logger.info({ total: results.length, correct, patched }, '✅ Batch verification complete');

  return {
    total: results.length,
    correct,
    incorrect: results.length - correct,
    patchesApplied: patched,
    accuracy: Math.round((correct / results.length) * 100),
    outcomes,
  };
}

module.exports = { verifyAndPatch, verifyBatch, evaluatePrediction };
