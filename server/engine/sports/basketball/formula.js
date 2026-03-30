// server/engine/sports/basketball/formula.js
// Basketball Formula — 6-Layer prediction system
// Adapted from football formula but with basketball-specific weights and metrics
// Covers: NBA, EuroLeague, FIBA World Cup, NBL, Liga ACB

'use strict';

const BASE_BASKETBALL_FORMULA = {
  version: '1.0.0',
  sport: 'BASKETBALL',
  meta: {
    description: 'Six-layer basketball prediction formula — NBA/EuroLeague/FIBA optimised',
    created: '2026-03-30',
    totalWeight: 100,
  },

  // ─── LAYER WEIGHTS ────────────────────────────────────────────────────────
  // Basketball differs from football: pace/efficiency stats are more predictive
  // Back-to-back fatigue is massive in NBA — heavier environment weight
  layerWeights: {
    L1_FORM:        20,  // Recent results, offensive/defensive ratings
    L2_ROSTER:      22,  // Player availability — NBA injuries hugely volatile
    L3_TACTICAL:    15,  // Coaching matchups, pace, scheme
    L4_PSYCHOLOGY:  12,  // Motivation, rivalry, clutch history
    L5_ENVIRONMENT: 16,  // Back-to-back, travel, altitude, home crowd (louder impact in NBA)
    L6_SIMULATION:  15,  // 3-simulation model
  },

  simulationWeights: {
    SIM_A_BEST_CASE:   0.25,
    SIM_B_NEUTRAL:     0.50,
    SIM_C_WORST_CASE:  0.25,
  },

  // ─── LAYER 1: FORM ENGINE ─────────────────────────────────────────────────
  L1_FORM: {
    description: 'Recent form using basketball-specific efficiency metrics',
    metrics: {
      lastFiveWeight:         0.35,
      lastThreeWeight:        0.40,   // Basketball streaks are shorter — recency matters more
      seasonAvgWeight:        0.25,
      netRatingMultiplier:    1.3,    // Offensive Rating − Defensive Rating
      paceAdjustment:         true,   // Adjust all stats to per-100-possession basis
      clutchPerformance:      0.12,   // Last 5 minutes of close games (within 5 pts)
      streakBonus: {
        win3Plus:             0.10,
        win5Plus:             0.15,
        lose3Plus:           -0.08,
      },
      homeOffensiveRating:    true,   // Track home vs away O-rating split
      reboundDifferential:    0.08,   // Rebounding margin bonus
    },
    thresholds: {
      eliteNetRating:   8.0,   // +8.0 or better = elite
      poorNetRating:   -5.0,
      volatileFormGap:  12,    // Point differential variance triggers volatile flag
    },
    patches: [],
  },

  // ─── LAYER 2: ROSTER INTELLIGENCE ────────────────────────────────────────
  // NBA rotation is 8-10 players deep — star players have outsized impact
  L2_ROSTER: {
    description: 'Player availability, load management, rotation depth, matchup quality',
    metrics: {
      starPlayerImpact: {
        // VORP-style impact (wins above replacement)
        tier1Star:  0.22,   // MVP-calibre (LeBron, Curry, Giannis etc.) missing
        tier2Star:  0.16,   // All-Star starter missing
        tier3Star:  0.10,   // All-Star reserve missing
        rotation:   0.05,   // Key rotation player missing
      },
      loadManagementFlag:     0.15,   // Probability boost to rest if back-to-back
      injuryReturnPenalty:    0.12,   // First game back from injury
      doubleDoublePlayer:     0.08,   // Missing primary rebounder/playmaker
      benchDepthFactor:       0.10,
      foulTroubleRisk:        0.06,   // Historical foul rate for key players
    },
    thresholds: {
      criticalRosterMissing:  2,      // 2+ rotation players missing = critical
      loadMgmtB2BThreshold:   2,      // Back-to-back days → load management risk
    },
    patches: [],
  },

  // ─── LAYER 3: TACTICAL ANALYSIS ──────────────────────────────────────────
  L3_TACTICAL: {
    description: 'Coaching matchup, pace, offensive scheme, defensive identity',
    metrics: {
      coachMatchupWeight:      0.25,
      paceMatchup: {
        fastVsSlow:            0.10,  // Fast-paced team vs slow = advantage to fast
        matchedPace:           0.0,
      },
      defensiveScheme: {
        zoneVsManToMan:        0.08,
        switchingDefense:      0.06,
        helpDefenseRating:     0.08,
      },
      threePointDependency:    0.10,  // High 3PT% teams volatile
      paintDominance:          0.08,
      transitionOffense:       0.06,
      timeoutsUsagePattern:    0.05,  // Coach tendencies in crunch time
      setPlaySuccessRate:      0.04,
    },
    schemeEdges: {
      'fast_vs_slow':          0.08,
      'switching_vs_iso':      0.06,
      'zone_vs_3pt_heavy':    -0.06, // Zone disrupts 3PT teams
    },
    patches: [],
  },

  // ─── LAYER 4: PSYCHOLOGY ─────────────────────────────────────────────────
  L4_PSYCHOLOGY: {
    description: 'Motivation, rivalry, playoff positioning, clutch history, revenge games',
    metrics: {
      playoffRace:             0.14,  // % games remaining × urgency multiplier
      playInPressure:          0.12,
      revengeGame:             0.10,  // Playing team that eliminated them last year
      h2hDominance:            0.18,  // Last 6 H2H meetings
      homeAdvantageBase:       0.08,  // NBA home: slightly lower than football
      crowdNoise:              0.04,
      rivalryMultiplier:       1.12,
      superstarMotivation:     0.08,  // Star player milestone (point record, etc.)
      backToBackFatiguePsych: -0.06,
    },
    patches: [],
  },

  // ─── LAYER 5: ENVIRONMENT ────────────────────────────────────────────────
  // CRITICAL for NBA — travel schedule and back-to-backs are massive factors
  L5_ENVIRONMENT: {
    description: 'Travel, back-to-back games, rest days, altitude, schedule congestion',
    metrics: {
      backToBack: {
        firstGame:             0.0,   // First game of B2B — minimal effect
        secondGame:           -0.14,  // Second game of B2B — significant fatigue
        secondGameAway:       -0.20,  // Second B2B AND away = severe penalty
      },
      restAdvantage: {
        extraDayBonus:         0.04,  // Per extra rest day vs opponent
        threeDayRest:          0.08,
        fourPlusDayRest:       0.10,
      },
      travel: {
        crossCountryFlight:   -0.08,  // 3+ time zone difference
        redEyeFlight:         -0.12,
        threeGamesIn4Days:    -0.10,
      },
      altitude: {
        denver:               -0.06,  // Altitude adjustment for visiting team (Mile High)
        utah:                 -0.04,
      },
      arenaAtmosphere: {
        selloutCrowd:          0.04,
        silentArena:          -0.02,
        playoffsAtmosphere:    0.08,
      },
    },
    patches: [],
  },

  // ─── LAYER 6: SIMULATION ─────────────────────────────────────────────────
  L6_SIMULATION: {
    description: '3-simulation weighted model producing final probability',
    simulations: {
      SIM_A: { name: 'BEST_CASE_FAVOURITE',   weight: 0.25 },
      SIM_B: { name: 'TRUE_NEUTRAL',           weight: 0.50 },
      SIM_C: { name: 'WORST_CASE_DISRUPTION', weight: 0.25 },
    },
    confidenceTiers: {
      TIER1: { min: 80, max: 100 },
      TIER2: { min: 65, max: 79 },
      TIER3: { min: 0,  max: 64 },
    },
    // Basketball-specific: don't cap spread bets — NBA point differentials are volatile
    spreadVariance:           8.5,   // Average standard deviation for NBA spreads
    totalVariance:            12.0,  // Average std dev for NBA totals (O/U)
    antibiasRules: {
      noMarketFavouritism:    true,
      noStarPlayerBias:       true,  // Stars don't automatically = wins
      recencyOverSeason:      true,
      awayFormParity:         true,
    },
    patches: [],
  },

  // ─── GLOBAL MODIFIERS ────────────────────────────────────────────────────
  globalModifiers: {
    preseasonDiscount:         0.75,  // Preseason results near-meaningless
    regularSeasonBase:         1.00,
    playInGameBoost:           1.12,
    playoffBoost:              1.15,  // Playoff games — stars perform
    allStarWeekendDiscount:    0.60,  // All-Star game = exhibition
    summerLeagueDiscount:      0.50,
  },

  // ─── BASKETBALL BET TYPES ─────────────────────────────────────────────────
  supportedBetTypes: [
    'MONEYLINE',          // Team to win outright
    'SPREAD',             // Handicap (e.g. -5.5 / +5.5)
    'OVER_TOTAL',         // Match total points over threshold
    'UNDER_TOTAL',        // Match total points under threshold
    'FIRST_QUARTER_WINNER',
    'FIRST_HALF_WINNER',
    'FIRST_HALF_OVER',
    'FIRST_HALF_UNDER',
    'HOME_OVER',          // Home team to score over X
    'HOME_UNDER',
    'AWAY_OVER',          // Away team to score over X
    'AWAY_UNDER',
    'BOTH_OVER_100',      // Both teams over 100 pts
    'DOUBLE_CHANCE',
    'WINNING_MARGIN',
  ],

  // ─── AI CONSENSUS ────────────────────────────────────────────────────────
  aiConsensus: {
    primaryModel:         'claude-opus-4-5',
    validatorModel:       'gpt-4o',
    consensusThreshold:   12,    // Basketball is tighter — 12% gap triggers debate
    debateRounds:         2,
    tieBreaker:           'claude',
    weightings:           { claude: 0.60, gpt4: 0.40 },
  },
};

module.exports = { BASE_BASKETBALL_FORMULA };
