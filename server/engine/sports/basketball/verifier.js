// server/engine/sports/basketball/verifier.js
// Basketball-specific outcome evaluator and layer failure identifier

'use strict';

// ─── OUTCOME EVALUATOR ────────────────────────────────────────────────────────

function evaluateBasketballPrediction(prediction, result) {
  const { predictedOutcome, betLine, confidencePct } = prediction;
  const { homeScore, awayScore } = result;

  const totalPoints  = homeScore + awayScore;
  const pointDiff    = homeScore - awayScore;
  const actualWinner = homeScore > awayScore ? 'HOME' : 'AWAY';

  let wasCorrect  = false;
  let failureType = null;
  let predictedValue = predictedOutcome;
  let actualValue;

  switch (predictedOutcome) {
    case 'MONEYLINE':
    case 'HOME':
      wasCorrect  = actualWinner === 'HOME';
      actualValue = actualWinner;
      if (!wasCorrect) failureType = 'WRONG_WINNER';
      break;

    case 'AWAY':
      wasCorrect  = actualWinner === 'AWAY';
      actualValue = actualWinner;
      if (!wasCorrect) failureType = 'WRONG_WINNER';
      break;

    case 'SPREAD': {
      // Favourite covers spread
      const line = betLine || 0;
      // Negative line = home favoured
      wasCorrect  = line < 0
        ? pointDiff + Math.abs(line) > 0    // Home covers
        : awayScore - homeScore + Math.abs(line) > 0; // Away covers
      actualValue = `${homeScore}-${awayScore} (diff: ${pointDiff > 0 ? '+' : ''}${pointDiff})`;
      predictedValue = `Spread ${line > 0 ? '+' : ''}${line}`;
      if (!wasCorrect) failureType = 'WRONG_SPREAD';
      break;
    }

    case 'OVER_TOTAL': {
      const line = betLine || 220;
      wasCorrect  = totalPoints > line;
      actualValue = `${totalPoints} total points`;
      predictedValue = `Over ${line}`;
      if (!wasCorrect) failureType = 'WRONG_TOTAL';
      break;
    }

    case 'UNDER_TOTAL': {
      const line = betLine || 220;
      wasCorrect  = totalPoints < line;
      actualValue = `${totalPoints} total points`;
      predictedValue = `Under ${line}`;
      if (!wasCorrect) failureType = 'WRONG_TOTAL';
      break;
    }

    case 'FIRST_HALF_OVER':
    case 'FIRST_HALF_UNDER':
    case 'FIRST_QUARTER_WINNER':
    case 'HOME_OVER':
    case 'HOME_UNDER':
    case 'AWAY_OVER':
    case 'AWAY_UNDER': {
      // These require quarter/half splits in the result
      if (!result.homeFirstHalf && !result.firstQuarter) {
        wasCorrect  = null; // Cannot verify without split data
        actualValue = 'Split data unavailable';
        failureType = 'INSUFFICIENT_DATA';
        break;
      }
      const hH = result.homeFirstHalf || 0;
      const aH = result.awayFirstHalf || 0;
      const halfTotal = hH + aH;
      const line = betLine || 110;

      if (predictedOutcome === 'FIRST_HALF_OVER') {
        wasCorrect  = halfTotal > line;
        actualValue = `${halfTotal} first half points`;
      } else if (predictedOutcome === 'FIRST_HALF_UNDER') {
        wasCorrect  = halfTotal < line;
        actualValue = `${halfTotal} first half points`;
      } else if (predictedOutcome === 'FIRST_QUARTER_WINNER') {
        const q1 = result.firstQuarter || {};
        wasCorrect  = q1.home > q1.away;
        actualValue = `Q1: ${q1.home}-${q1.away}`;
      } else if (predictedOutcome === 'HOME_OVER') {
        wasCorrect  = homeScore > line;
        actualValue = `Home scored ${homeScore}`;
      } else if (predictedOutcome === 'HOME_UNDER') {
        wasCorrect  = homeScore < line;
        actualValue = `Home scored ${homeScore}`;
      } else if (predictedOutcome === 'AWAY_OVER') {
        wasCorrect  = awayScore > line;
        actualValue = `Away scored ${awayScore}`;
      } else if (predictedOutcome === 'AWAY_UNDER') {
        wasCorrect  = awayScore < line;
        actualValue = `Away scored ${awayScore}`;
      }
      if (!wasCorrect) failureType = 'WRONG_TOTAL';
      break;
    }

    case 'BOTH_OVER_100':
      wasCorrect  = homeScore > 100 && awayScore > 100;
      actualValue = `${homeScore}-${awayScore}`;
      if (!wasCorrect) failureType = 'WRONG_TOTAL';
      break;

    default:
      wasCorrect  = false;
      failureType = 'UNKNOWN_BET_TYPE';
      actualValue = `${homeScore}-${awayScore}`;
  }

  return { wasCorrect, failureType, predictedValue, actualValue };
}

// ─── BASKETBALL LAYER FAILURE IDENTIFIER ─────────────────────────────────────

function identifyBasketballFailedLayer(prediction, result, failureType) {
  const { homeScore, awayScore, backToBackOccurred } = result;
  const totalPoints = homeScore + awayScore;
  const pointDiff   = Math.abs(homeScore - awayScore);

  // High confidence but wrong winner → simulation aggregation was off
  if (prediction.confidencePct > 80 && failureType === 'WRONG_WINNER') {
    return 'L6_SIMULATION';
  }

  // Total points wildly off AND back-to-back was a factor → environment missed
  if (failureType === 'WRONG_TOTAL' && backToBackOccurred) {
    return 'L5_ENVIRONMENT';
  }

  // Total points way under expected (defensive game) → pace/tactical misjudged
  if (failureType === 'WRONG_TOTAL' && totalPoints < 195) {
    return 'L3_TACTICAL'; // Slow pace / defensive dominance not spotted
  }

  // Total points way over expected (scoring explosion) → form engine underestimated
  if (failureType === 'WRONG_TOTAL' && totalPoints > 255) {
    return 'L1_FORM';
  }

  // Spread missed badly (10+ points off) → roster impact wrong
  if (failureType === 'WRONG_SPREAD' && pointDiff > 15) {
    return 'L2_ROSTER';
  }

  // Narrow spread miss → psychology/clutch factor
  if (failureType === 'WRONG_SPREAD' && pointDiff < 5) {
    return 'L4_PSYCHOLOGY';
  }

  // Wrong winner despite good form stats → back-to-back or travel missed
  if (failureType === 'WRONG_WINNER' && prediction.backToBackFlag) {
    return 'L5_ENVIRONMENT';
  }

  // Wrong winner in a close game → clutch/psychology layer
  if (failureType === 'WRONG_WINNER' && pointDiff < 6) {
    return 'L4_PSYCHOLOGY';
  }

  // Default catch-all
  return 'L6_SIMULATION';
}

module.exports = { evaluateBasketballPrediction, identifyBasketballFailedLayer };
