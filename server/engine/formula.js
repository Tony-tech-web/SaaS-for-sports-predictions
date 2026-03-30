// server/engine/formula.js
// The Master Formula — versioned, self-healing, layer-isolated
// Each layer has its own weight, modifiers array, and patch history

'use strict';

const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');

const prisma = new PrismaClient();

// ─── DEFAULT FORMULA (Base v3.1.0) ───────────────────────────────────────────

const BASE_FORMULA = {
  version: '3.1.0',
  meta: {
    description: 'Six-layer probabilistic prediction formula with multi-AI consensus',
    created: '2026-03-28',
    totalWeight: 100,
  },

  // ─── LAYER WEIGHTS (must sum to 100) ────────────────────────────────────
  layerWeights: {
    L1_FORM: 22,
    L2_SQUAD: 20,
    L3_TACTICAL: 16,
    L4_PSYCHOLOGY: 14,
    L5_ENVIRONMENT: 10,
    L6_SIMULATION: 18,
  },

  // ─── SIMULATION WEIGHTS ─────────────────────────────────────────────────
  simulationWeights: {
    SIM_A_BEST_CASE: 0.25,
    SIM_B_NEUTRAL: 0.50,
    SIM_C_WORST_CASE: 0.25,
  },

  // ─── LAYER 1: FORM ENGINE ───────────────────────────────────────────────
  L1_FORM: {
    description: 'Recent form, xG, momentum, points per game trajectory',
    metrics: {
      lastFiveWeight: 0.40,
      lastThreeWeight: 0.35,
      seasonAvgWeight: 0.25,
      xgMultiplier: 1.2,
      cleanSheetBonus: 0.08,
      goalDiffTrend: true,
    },
    thresholds: {
      strongForm: 10,     // pts from last 5 games
      weakForm: 4,
      volatileFormDetection: true,
    },
    patches: [],          // ← Self-healing patches are appended HERE
  },

  // ─── LAYER 2: SQUAD INTELLIGENCE ────────────────────────────────────────
  L2_SQUAD: {
    description: 'Lineup quality, injuries, suspensions, key player coefficients',
    metrics: {
      keyPlayerImpact: {
        striker: 0.18,      // xG reduction if top scorer missing
        midfielder: 0.12,
        defender: 0.10,
        goalkeeper: 0.08,
      },
      injuryReturnPenalty: 0.15,   // -15% for first game back
      suspensionPenalty: 0.12,
      depthQualityFactor: 0.10,
    },
    thresholds: {
      criticalPlayerMissing: 2,    // if 2+ key players out = critical flag
      squadDepthMinimum: 18,
    },
    patches: [],
  },

  // ─── LAYER 3: TACTICAL MATRIX ───────────────────────────────────────────
  L3_TACTICAL: {
    description: 'Formation, pressing, set pieces, transition speed, coach adaptability',
    metrics: {
      formationMatchupWeight: 0.35,
      pressingIntensityWeight: 0.20,
      setPieceWeight: 0.15,
      transitionSpeedWeight: 0.15,
      coachAdaptabilityWeight: 0.15,
    },
    formationEdges: {
      // Maps which formations have edges vs others
      '4-3-3_vs_4-4-2': 0.08,
      '3-5-2_vs_4-3-3': 0.05,
      '4-2-3-1_vs_4-4-2': 0.06,
    },
    pressingTriggers: ['high_line', 'mid_block', 'low_block', 'hybrid'],
    patches: [],
  },

  // ─── LAYER 4: PSYCHOLOGY ────────────────────────────────────────────────
  L4_PSYCHOLOGY: {
    description: 'Motivation, H2H dominance, pressure, morale, coach influence',
    metrics: {
      mustWinPressure: 0.12,          // boost if mathematically critical game
      nothingToLoseFreedom: 0.08,     // boost for underdog with no pressure
      h2hDominance: 0.20,             // weight of last 6 H2H records
      homeAdvantageBase: 0.10,
      crowdEffect: 0.05,
      rivalryMultiplier: 1.15,        // applied for derbies/rivalry games
      streakMomentum: {
        winStreak3Plus: 0.12,
        loseStreak3Plus: -0.10,
        unbeatableStreak5Plus: 0.15,
      },
    },
    patches: [],
  },

  // ─── LAYER 5: ENVIRONMENT ────────────────────────────────────────────────
  L5_ENVIRONMENT: {
    description: 'Weather, travel, altitude, schedule congestion, referee tendencies',
    metrics: {
      weather: {
        heavyRain: -0.15,            // goals per game reduction
        strongWind: -0.10,
        extremeHeat: -0.08,
        snowOrFrost: -0.20,
        ideal: 0.0,
      },
      travel: {
        over500km: -0.08,
        over1000km: -0.14,
        longHaul: -0.20,
      },
      schedule: {
        gamesIn7Days3Plus: -0.10,
        gamesIn7Days2: -0.05,
        restDaysBonus: 0.04,         // per extra rest day above 4
      },
      altitude: {
        above2000m: -0.12,           // for visiting team
        above3000m: -0.22,
      },
      referee: {
        cardsPerGameHigh: 0.03,      // >5 cards/game = more disruption
        penaltyRateHigh: 0.04,
      },
    },
    patches: [],
  },

  // ─── LAYER 6: PROBABILISTIC SIMULATION ──────────────────────────────────
  L6_SIMULATION: {
    description: '3-simulation weighted model → final probability distribution',
    simulations: {
      SIM_A: {
        name: 'BEST_CASE_FAVOURITE',
        description: 'Favoured team performs at ceiling, underdog at floor',
        weight: 0.25,
      },
      SIM_B: {
        name: 'TRUE_NEUTRAL',
        description: 'All factors at mean probability, no bias adjustment',
        weight: 0.50,
      },
      SIM_C: {
        name: 'WORST_CASE_DISRUPTION',
        description: 'Murphy\'s law — injuries, red cards, weather disruption',
        weight: 0.25,
      },
    },
    confidenceTiers: {
      TIER1: { min: 80, max: 100, label: 'HIGH CONFIDENCE' },
      TIER2: { min: 65, max: 79,  label: 'MODERATE CONFIDENCE' },
      TIER3: { min: 0,  max: 64,  label: 'LOW CONFIDENCE — FLAG' },
    },
    drawCapRule: {
      enabled: true,
      maxDrawProbability: 28,         // Draw never > 28% unless xG delta < 0.3
      xgDeltaThreshold: 0.3,
    },
    antibiasRules: {
      noReputationInflation: true,
      noNarrativeBias: true,
      noSympathyAdjustment: true,
      awayFormParityWithHome: true,
      recentFormOverSeasonAvg: true,  // last 3 > season when volatile
    },
    patches: [],
  },

  // ─── GLOBAL MODIFIERS (Applied cross-layer) ──────────────────────────────
  globalModifiers: {
    friendlyGameDiscount: 0.85,       // Prediction confidence × 0.85 for friendlies
    cupGameBoost: 1.05,               // Slight boost for knockout urgency
    relegationFearBoost: 1.10,        // Underdog fighting relegation
    titleDeciderBoost: 1.08,          // Both teams fighting for title
  },

  // ─── CONSENSUS PROTOCOL ──────────────────────────────────────────────────
  aiConsensus: {
    primaryModel: 'claude-opus-4-5',
    validatorModel: 'gpt-4o',
    consensusThreshold: 15,           // % confidence gap that triggers debate
    debateRounds: 2,                  // How many back-and-forth rounds
    tieBreaker: 'claude',             // Primary wins ties
    weightings: {
      claude: 0.60,
      gpt4: 0.40,
    },
  },
};

// ─── FORMULA MANAGER CLASS ────────────────────────────────────────────────────

class FormulaManager {
  constructor() {
    this._activeFormula = null;
    this._cache = new Map();
  }

  /**
   * Get the currently active formula from DB (with caching)
   */
  async getActiveFormula() {
    if (this._activeFormula && this._cacheAge < 60000) {
      return this._activeFormula;
    }

    try {
      const formula = await prisma.formulaVersion.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (!formula) {
        logger.warn('No active formula found in DB — using base formula');
        return { formulaJson: BASE_FORMULA, version: BASE_FORMULA.version, id: 'base' };
      }

      this._activeFormula = formula;
      this._cacheAge = Date.now();
      return formula;
    } catch (err) {
      logger.error({ err }, 'Failed to load formula from DB');
      return { formulaJson: BASE_FORMULA, version: BASE_FORMULA.version, id: 'base' };
    }
  }

  /**
   * Seed the base formula into DB if not exists
   */
  async seedBaseFormula() {
    const existing = await prisma.formulaVersion.findUnique({
      where: { version: BASE_FORMULA.version },
    });

    if (existing) {
      logger.info(`Formula v${BASE_FORMULA.version} already exists in DB`);
      return existing;
    }

    const created = await prisma.formulaVersion.create({
      data: {
        version: BASE_FORMULA.version,
        majorVersion: 3,
        minorVersion: 1,
        patchVersion: 0,
        isActive: true,
        formulaJson: BASE_FORMULA,
        systemPrompt: generateSystemPrompt(BASE_FORMULA),
        changelog: 'Initial production formula — 6-layer analysis stack with multi-AI consensus',
      },
    });

    logger.info({ version: created.version }, 'Base formula seeded to DB');
    return created;
  }

  /**
   * Apply a patch to a specific layer ONLY
   * Creates a new patch version — never modifies the old one
   */
  async applyPatch({ fromVersionId, resultId, failedLayer, patchDiff, modifierAdded, patchDescription, aiReasoning, failureAnalysis, failureType, predictedValue, actualValue }) {
    const fromVersion = await prisma.formulaVersion.findUnique({
      where: { id: fromVersionId },
    });

    if (!fromVersion) throw new Error(`Formula version ${fromVersionId} not found`);

    const currentFormula = fromVersion.formulaJson;

    // Parse current version
    const [major, minor, patch] = fromVersion.version.split('.').map(Number);
    const newVersion = `${major}.${minor}.${patch + 1}`;

    // CRITICAL: Only patch the specific layer — clone everything else untouched
    const patchedFormula = JSON.parse(JSON.stringify(currentFormula));
    const targetLayerData = patchedFormula[failedLayer];

    if (!targetLayerData) {
      throw new Error(`Layer ${failedLayer} not found in formula`);
    }

    // Append modifier to the patches array of ONLY that layer
    if (!targetLayerData.patches) targetLayerData.patches = [];
    targetLayerData.patches.push({
      patchId: `patch_${Date.now()}`,
      appliedAt: new Date().toISOString(),
      description: patchDescription,
      modifier: modifierAdded,
      reason: aiReasoning,
    });

    // Merge the specific diff into the layer
    Object.assign(targetLayerData, patchDiff);

    // Deactivate old version
    await prisma.formulaVersion.update({
      where: { id: fromVersionId },
      data: { isActive: false },
    });

    // Create new version
    const newFormulaVersion = await prisma.formulaVersion.create({
      data: {
        version: newVersion,
        majorVersion: major,
        minorVersion: minor,
        patchVersion: patch + 1,
        isActive: true,
        formulaJson: patchedFormula,
        systemPrompt: generateSystemPrompt(patchedFormula),
        changelog: `Auto-patch v${newVersion}: ${patchDescription} [Layer: ${failedLayer}]`,
      },
    });

    // Record the patch
    const formulaPatch = await prisma.formulaPatch.create({
      data: {
        fromVersionId,
        resultId,
        failedLayer,
        failureAnalysis,
        failureType,
        predictedValue,
        actualValue,
        patchDescription,
        patchDiff,
        targetLayer: failedLayer,
        modifierAdded,
        newVersionId: newFormulaVersion.id,
        aiReasoning,
      },
    });

    // Invalidate cache
    this._activeFormula = null;

    logger.info({
      fromVersion: fromVersion.version,
      newVersion,
      failedLayer,
      failureType,
    }, '🔧 Formula patch applied');

    return { newFormulaVersion, formulaPatch };
  }

  /**
   * Build the system prompt from the current formula config
   */
  getSystemPrompt(formulaJson) {
    return generateSystemPrompt(formulaJson);
  }
}

// ─── SYSTEM PROMPT GENERATOR ──────────────────────────────────────────────────

function generateSystemPrompt(formula) {
  const f = formula;
  const lw = f.layerWeights;
  const sw = f.simulationWeights;

  // Build active patches string for each layer
  const getPatchSummary = (layer) => {
    const patches = f[layer]?.patches || [];
    if (!patches.length) return '';
    return `\n  ACTIVE PATCHES (${patches.length}):\n` + patches.map(p =>
      `  • [${p.patchId}] ${p.description}: ${JSON.stringify(p.modifier)}`
    ).join('\n');
  };

  return `You are the FOOTBALL ORACLE — an elite prediction system with 50 years of combined expert knowledge spanning tactics, sports psychology, biomechanics, and statistical modelling. You operate with ZERO emotional bias and ZERO sympathy.

## ACTIVE FORMULA VERSION: ${f.version || 'UNKNOWN'}

## LAYER WEIGHTS (Total = 100%)
- L1 FORM ENGINE: ${lw.L1_FORM}%
- L2 SQUAD INTELLIGENCE: ${lw.L2_SQUAD}%
- L3 TACTICAL MATRIX: ${lw.L3_TACTICAL}%
- L4 PSYCHOLOGY: ${lw.L4_PSYCHOLOGY}%
- L5 ENVIRONMENT: ${lw.L5_ENVIRONMENT}%
- L6 SIMULATION: ${lw.L6_SIMULATION}%

## SIMULATION WEIGHTS
- SIM A (Best Case Favourite): ${(sw.SIM_A_BEST_CASE * 100).toFixed(0)}%
- SIM B (True Neutral): ${(sw.SIM_B_NEUTRAL * 100).toFixed(0)}%
- SIM C (Worst Case Disruption): ${(sw.SIM_C_WORST_CASE * 100).toFixed(0)}%

## MANDATORY ANALYSIS LAYERS

### LAYER 1 — FORM ENGINE [Weight: ${lw.L1_FORM}%]
- Last 5 results: home and away split separately
- xG (expected goals) for & against in last 5 matches (multiplier: ${f.L1_FORM.metrics.xgMultiplier}x)
- Goal difference trajectory: improving, stable, or declining
- Points per game over last 10 vs season average (momentum signal)
- Clean sheet frequency and defensive stability index (bonus: +${(f.L1_FORM.metrics.cleanSheetBonus * 100).toFixed(0)}% per clean sheet trend)
- Use last 3 matches weight: ${(f.L1_FORM.metrics.lastThreeWeight * 100).toFixed(0)}% when form is volatile
${getPatchSummary('L1_FORM')}

### LAYER 2 — SQUAD INTELLIGENCE [Weight: ${lw.L2_SQUAD}%]
- Confirmed starting XI vs probable lineup
- Injury report: striker missing = -${(f.L2_SQUAD.metrics.keyPlayerImpact.striker * 100).toFixed(0)}% xG, midfielder = -${(f.L2_SQUAD.metrics.keyPlayerImpact.midfielder * 100).toFixed(0)}%, defender = -${(f.L2_SQUAD.metrics.keyPlayerImpact.defender * 100).toFixed(0)}%, goalkeeper = -${(f.L2_SQUAD.metrics.keyPlayerImpact.goalkeeper * 100).toFixed(0)}%
- Return-from-injury penalty: -${(f.L2_SQUAD.metrics.injuryReturnPenalty * 100).toFixed(0)}% for first game back
- Suspension penalty: -${(f.L2_SQUAD.metrics.suspensionPenalty * 100).toFixed(0)}%
- CRITICAL FLAG if ${f.L2_SQUAD.thresholds.criticalPlayerMissing}+ key players absent
${getPatchSummary('L2_SQUAD')}

### LAYER 3 — TACTICAL MATRIX [Weight: ${lw.L3_TACTICAL}%]
- Formation matchup analysis (weight: ${(f.L3_TACTICAL.metrics.formationMatchupWeight * 100).toFixed(0)}%)
- Pressing intensity and triggers (weight: ${(f.L3_TACTICAL.metrics.pressingIntensityWeight * 100).toFixed(0)}%)
- Set piece threat: goals scored/conceded from set pieces (weight: ${(f.L3_TACTICAL.metrics.setPieceWeight * 100).toFixed(0)}%)
- Transition speed and directness (weight: ${(f.L3_TACTICAL.metrics.transitionSpeedWeight * 100).toFixed(0)}%)
- Coach adaptability — history of in-game tactical changes (weight: ${(f.L3_TACTICAL.metrics.coachAdaptabilityWeight * 100).toFixed(0)}%)
${getPatchSummary('L3_TACTICAL')}

### LAYER 4 — PSYCHOLOGY [Weight: ${lw.L4_PSYCHOLOGY}%]
- H2H dominance: last 6 meetings (weight: ${(f.L4_PSYCHOLOGY.metrics.h2hDominance * 100).toFixed(0)}%)
- Home advantage base: +${(f.L4_PSYCHOLOGY.metrics.homeAdvantageBase * 100).toFixed(0)}%
- Win streak 3+: +${(f.L4_PSYCHOLOGY.metrics.streakMomentum.winStreak3Plus * 100).toFixed(0)}% | Lose streak 3+: ${(f.L4_PSYCHOLOGY.metrics.streakMomentum.loseStreak3Plus * 100).toFixed(0)}%
- Must-win pressure: +${(f.L4_PSYCHOLOGY.metrics.mustWinPressure * 100).toFixed(0)}% | Nothing-to-lose freedom: +${(f.L4_PSYCHOLOGY.metrics.nothingToLoseFreedom * 100).toFixed(0)}%
- Derby/rivalry multiplier: ${f.L4_PSYCHOLOGY.metrics.rivalryMultiplier}x
${getPatchSummary('L4_PSYCHOLOGY')}

### LAYER 5 — ENVIRONMENT [Weight: ${lw.L5_ENVIRONMENT}%]
- Heavy rain: ${f.L5_ENVIRONMENT.metrics.weather.heavyRain * 100}% goals/game | Strong wind: ${f.L5_ENVIRONMENT.metrics.weather.strongWind * 100}% | Snow: ${f.L5_ENVIRONMENT.metrics.weather.snowOrFrost * 100}%
- Travel >500km: ${f.L5_ENVIRONMENT.metrics.travel.over500km * 100}% | >1000km: ${f.L5_ENVIRONMENT.metrics.travel.over1000km * 100}%
- 3+ games in 7 days: ${f.L5_ENVIRONMENT.metrics.schedule.gamesIn7Days3Plus * 100}% fatigue penalty
- Altitude >2000m: ${f.L5_ENVIRONMENT.metrics.altitude.above2000m * 100}% for away team
${getPatchSummary('L5_ENVIRONMENT')}

### LAYER 6 — SIMULATION [Weight: ${lw.L6_SIMULATION}%]
Run THREE independent simulations:
- SIM A (${(sw.SIM_A_BEST_CASE * 100).toFixed(0)}%): Best-case for statistical favourite
- SIM B (${(sw.SIM_B_NEUTRAL * 100).toFixed(0)}%): True neutral probability
- SIM C (${(sw.SIM_C_WORST_CASE * 100).toFixed(0)}%): Worst-case disruption scenario
Final = SIM_A×${sw.SIM_A_BEST_CASE} + SIM_B×${sw.SIM_B_NEUTRAL} + SIM_C×${sw.SIM_C_WORST_CASE}
Draw cap: ${f.L6_SIMULATION.drawCapRule.maxDrawProbability}% maximum unless xG delta < ${f.L6_SIMULATION.drawCapRule.xgDeltaThreshold}
${getPatchSummary('L6_SIMULATION')}

## GLOBAL MODIFIERS
- Friendly game: confidence × ${f.globalModifiers.friendlyGameDiscount}
- Cup knockout: confidence × ${f.globalModifiers.cupGameBoost}
- Relegation battle: confidence × ${f.globalModifiers.relegationFearBoost}
- Title decider: confidence × ${f.globalModifiers.titleDeciderBoost}

## ANTI-BIAS RULES (NON-NEGOTIABLE)
❌ NEVER favour the "bigger" club by reputation
❌ NEVER let media narrative override statistical evidence
❌ NEVER predict draws as safe default — only when probability genuinely supports it
❌ NEVER adjust for what the user "wants to hear"
✅ ALWAYS prioritise last 3 matches over season averages when form is volatile
✅ ALWAYS flag when prediction confidence < 60%
✅ ALWAYS account for squad depth when rotation is likely

## MANDATORY OUTPUT FORMAT (JSON — NO MARKDOWN, NO DEVIATION)
Respond ONLY with a valid JSON object matching this schema:
{
  "homeTeam": string,
  "awayTeam": string,
  "betType": string,
  "predictedOutcome": "HOME" | "AWAY" | "DRAW" | "OVER_X" | "UNDER_X",
  "predictedScore": "X-X",
  "confidencePct": number (0-100),
  "confidenceTier": "TIER1" | "TIER2" | "TIER3",
  "keyDriver": string (1 sentence max),
  "redFlags": string[],
  "layerScores": { "L1": number, "L2": number, "L3": number, "L4": number, "L5": number, "L6": number },
  "simulationResults": { "SIM_A": number, "SIM_B": number, "SIM_C": number, "weighted": number },
  "verdict": string (2-3 sentences, no hedging, pure probability),
  "rationale": string (detailed reasoning, layer by layer),
  "isGameTypeModifier": string | null,
  "confidenceAdjustedForGameType": number
}`;
}

const formulaManager = new FormulaManager();
module.exports = { formulaManager, BASE_FORMULA, generateSystemPrompt };
