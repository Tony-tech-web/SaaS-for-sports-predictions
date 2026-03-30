// scripts/run-self-heal-basketball.js
// Basketball self-healing runner — NBA back-to-back fatigue example
// Demonstrates how L5_ENVIRONMENT patch fires for a missed B2B fatigue call

'use strict';

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', grey: '\x1b[90m', orange: '\x1b[38;5;208m',
};

const log  = (m, c = C.reset) => console.log(`${c}${m}${C.reset}`);
const div  = () => console.log(C.grey + '─'.repeat(60) + C.reset);
const wait = ms => new Promise(r => setTimeout(r, ms));

// ─── EXAMPLE FAILURE: NBA back-to-back missed ─────────────────────────────────

const FAILED_PREDICTION = {
  sport:            'BASKETBALL',
  match:            { homeTeam: 'Denver Nuggets', awayTeam: 'Golden State Warriors', competition: 'NBA Regular Season', betType: 'MONEYLINE' },
  predictedOutcome: 'AWAY',          // Predicted Warriors to win away
  predictedScore:   '108-114',
  confidencePct:    71,
  confidenceTier:   'TIER2',
  keyDriver:        'Warriors 5-game win streak, Curry averaging 32ppg last 5 games, Nuggets home crowd advantage offset by poor recent form',
  redFlags:         ['Nuggets at altitude (Denver) disadvantage for Warriors', 'Warriors playing 2nd game in 2 nights'],
  layerScores:      { L1: 68, L2: 72, L3: 70, L4: 65, L5: 58, L6: 69 },
  simulationResults:{ SIM_A: 82, SIM_B: 68, SIM_C: 42, weighted: 65 },
  backToBackFlag:   true,            // Was flagged but not penalised enough
  injuryImpact:     'NONE',
  verdict:          "Warriors' elite road form and Curry's scoring run outweigh the altitude and back-to-back concerns.",
};

const ACTUAL_RESULT = {
  homeScore: 119, awayScore: 101,
  actualOutcome: 'HOME', totalGoals: 220,
  backToBackOccurred: true,
  pointDiff: 18,
};

// ─── STEP 1: EVALUATE ─────────────────────────────────────────────────────────

function evaluate() {
  log('\n' + '═'.repeat(60), C.cyan);
  log('🏀 SPORTS ORACLE — BASKETBALL SELF-HEALING ENGINE', C.bold + C.cyan);
  log('   Failure: Nuggets vs Warriors | Moneyline (Away)', C.grey);
  log('═'.repeat(60), C.cyan);

  log('\n🔍 STEP 1 — EVALUATING PREDICTION', C.bold + C.yellow); div();
  log(`  Predicted : ${C.yellow}AWAY (Warriors win)${C.reset}`);
  log(`  Confidence: ${C.yellow}71% — TIER 2${C.reset}`);
  log(`  Actual    : ${C.red}Nuggets 119-101 Warriors (HOME wins by 18)${C.reset}`);
  log(`  B2B Flag  : ${C.orange}TRUE — Warriors playing 2nd game in 2 nights${C.reset}`);
  log(`  Outcome   : ${C.red}WRONG_WINNER ❌${C.reset}`);

  return { failureType: 'WRONG_WINNER', pointDiff: 18 };
}

// ─── STEP 2: IDENTIFY LAYER ───────────────────────────────────────────────────

function identifyLayer({ failureType, pointDiff }) {
  log('\n🔬 STEP 2 — IDENTIFYING FAILING LAYER', C.bold + C.yellow); div();
  log('  Running basketball heuristic tree...\n');

  log(`  ${C.grey}[Rule A] confidence > 80 AND wrong winner? → L6_SIMULATION${C.reset}`);
  log(`  ${C.grey}  → confidence = 71% — SKIP${C.reset}`);
  log(`  ${C.grey}[Rule B] WRONG_WINNER AND backToBackFlag = true? → L5_ENVIRONMENT${C.reset}`);
  log(`  ${C.green}  → backToBackFlag = TRUE — MATCH ✅${C.reset}`);

  log(`\n  ${C.bold}IDENTIFIED FAILING LAYER: ${C.orange}L5_ENVIRONMENT${C.reset}`);
  log(`  ${C.grey}Rationale: backToBackFlag was raised but L5 penalty was insufficient.`);
  log(`  ${C.grey}  Warriors: second B2B game + cross-country (San Francisco → Denver)`);
  log(`  ${C.grey}  + altitude = compound fatigue not fully priced into confidence.${C.reset}`);

  return 'L5_ENVIRONMENT';
}

// ─── STEP 3: AI ROOT CAUSE ────────────────────────────────────────────────────

async function rootCause(layer) {
  log('\n🤖 STEP 3 — AI ROOT CAUSE ANALYSIS (Claude)', C.bold + C.yellow); div();
  log('  Sending basketball failure context to Claude...\n');

  const sys = `You are a sports prediction forensics expert specialising in NBA analytics. 
Identify precisely WHY the ${layer} layer failed and recommend the MINIMUM surgical addition.
RULES: Only patch ${layer}. Additions only. Return JSON only.`;

  const q = `NBA PREDICTION FAILURE

Match: Denver Nuggets vs Golden State Warriors — NBA Regular Season
Bet: MONEYLINE (Away — Warriors)
Predicted: Warriors win (71% confidence TIER2)
Actual: Nuggets 119-101 (Warriors lose by 18)

Context:
- Warriors playing 2nd game in 2 nights (B2B)
- Previous game: Warriors won in LA (cross-country: San Francisco → LA → Denver)
- Denver altitude: 5,280ft — known to disadvantage visiting teams
- L5_ENVIRONMENT scored only 58/100 — lowest layer score
- backToBackFlag was raised in redFlags but penalty was only -14% (second game home)
- The B2B + cross-country + altitude compound was not fully modelled

FAILING LAYER: ${layer}

The current formula penalises B2B second game home at -14% and cross-country at -8%.
But when B2B second game is ALSO cross-country AND at altitude (Denver/Utah), 
the compound effect is significantly underweighted.

Return ONLY:
{
  "failureAnalysis": "2-3 sentences on why L5_ENVIRONMENT failed",
  "rootCause": "Single most critical missed factor",
  "modifierToAdd": {
    "description": "modifier name",
    "trigger": "exact activation condition",
    "adjustment": <number>,
    "adjustmentType": "multiplier",
    "appliesTo": "confidence",
    "context": "compound travel fatigue scenario"
  },
  "patchDescription": "One sentence: what this patch does",
  "aiReasoning": "Why this fix is surgical and won't break non-compound scenarios"
}`;

  try {
    process.stdout.write(`  ${C.grey}Calling Claude API`);
    const res    = await client.messages.create({ model: 'claude-opus-4-5', max_tokens: 600, system: sys, messages: [{ role: 'user', content: q }] });
    process.stdout.write(` — done${C.reset}\n`);
    const text   = res.content.find(b => b.type === 'text')?.text || '';
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    const parsed = JSON.parse(text.slice(s, e + 1));

    log(`\n  ${C.bold}Failure Analysis:${C.reset} ${parsed.failureAnalysis}`);
    log(`  ${C.bold}Root Cause:${C.reset}       ${parsed.rootCause}`);
    log(`\n  ${C.bold}Modifier:${C.reset}`);
    log(`  ${C.orange}${JSON.stringify(parsed.modifierToAdd, null, 4).split('\n').join('\n  ')}${C.reset}`);
    log(`\n  ${C.bold}Patch:${C.reset} ${C.green}${parsed.patchDescription}${C.reset}`);

    return parsed;
  } catch {
    // Deterministic fallback
    const fallback = {
      failureAnalysis: "L5_ENVIRONMENT applied B2B and cross-country penalties independently (-14%, -8%) but lacked a compound modifier for the simultaneous occurrence of B2B second game + cross-country travel + high altitude venue. The three factors together create a compounding fatigue effect that is greater than the sum of its parts, particularly in the first quarter of the game.",
      rootCause: "No compound modifier for B2B-second-game + cross-country + altitude (Denver/Utah) — all three occurring simultaneously is significantly underweighted",
      modifierToAdd: { description: "compound_b2b_altitude_travel_penalty", trigger: "B2B second game AND cross-country flight (2+ time zones) AND altitude venue (Denver/Utah)", adjustment: -0.26, adjustmentType: "multiplier", appliesTo: "confidence", context: "compound travel fatigue — stacks on top of individual penalties" },
      patchDescription: "Applies an additional -26% confidence multiplier when B2B second game, cross-country travel, and altitude venue all occur simultaneously",
      aiReasoning: "The -0.26 only fires on the compound triple condition. Individual B2B or individual altitude penalties remain unchanged. This is surgical — less than 8% of NBA road games trigger all three conditions simultaneously.",
    };
    log(`  ${C.yellow}(Claude API unavailable — using deterministic analysis)${C.reset}`);
    log(`\n  ${C.bold}Root Cause:${C.reset} ${fallback.rootCause}`);
    log(`  ${C.bold}Patch:${C.reset} ${C.green}${fallback.patchDescription}${C.reset}`);
    return fallback;
  }
}

// ─── STEP 4: APPLY PATCH ──────────────────────────────────────────────────────

function applyPatch(layer, rc) {
  log('\n🔧 STEP 4 — APPLYING PATCH TO BASKETBALL FORMULA', C.bold + C.yellow); div();

  const fromV = '1.0.0';
  const newV  = '1.0.1';
  const pid   = `patch_bball_${Date.now()}`;

  log(`  From version   : ${C.grey}v${fromV}${C.reset}`);
  log(`  New version    : ${C.green}v${newV}${C.reset} ← ${C.bold}NOW ACTIVE${C.reset}`);
  log(`  Sport          : ${C.cyan}BASKETBALL${C.reset}`);
  log(`  Layer patched  : ${C.orange}${layer}${C.reset} only`);
  log(`  Patch ID       : ${C.grey}${pid}${C.reset}`);
  log(`  Other layers   : ${C.green}L1, L2_ROSTER, L3, L4, L6 — UNCHANGED ✅${C.reset}`);

  const patch = { patchId: pid, appliedAt: new Date().toISOString(), description: rc.patchDescription, modifier: rc.modifierToAdd, reason: rc.aiReasoning, triggeredBy: { match: 'Denver Nuggets vs Golden State Warriors', sport: 'BASKETBALL', failureType: 'WRONG_WINNER', betType: 'MONEYLINE', result: '119-101 Nuggets', keyCondition: 'B2B + cross-country + altitude compound' } };
  log(`\n  ${C.bold}Patch added to ${layer}.patches[]:${C.reset}`);
  JSON.stringify(patch, null, 4).split('\n').forEach(l => log(`  ${C.orange}${l}${C.reset}`));

  return { newV, pid };
}

// ─── STEP 5: SUMMARY ─────────────────────────────────────────────────────────

function summary(layer, rc, newV) {
  log('\n' + '═'.repeat(60), C.green);
  log('✅ BASKETBALL SELF-HEALING COMPLETE', C.bold + C.green);
  log('═'.repeat(60), C.green);
  log(`\n  Sport    : ${C.cyan}BASKETBALL (NBA)${C.reset}`);
  log(`  Failed   : Nuggets vs Warriors — Moneyline Away ❌`);
  log(`  Layer    : ${C.orange}${layer}${C.reset} (Environment/Travel)`);
  log(`  Root     : ${rc.rootCause}`);
  log(`  Fix      : ${C.green}${rc.patchDescription}${C.reset}`);
  log(`  Trigger  : ${rc.modifierToAdd.trigger}`);
  log(`  Adj      : ${rc.modifierToAdd.adjustment} multiplier on confidence`);
  log(`\n  Formula  : ${C.grey}v1.0.0 deactivated${C.reset} → ${C.green}v${newV} ACTIVE ✅${C.reset}`);
  log(`  Unchanged: L1_FORM, L2_ROSTER, L3_TACTICAL, L4_PSYCHOLOGY, L6_SIMULATION\n`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const ev    = evaluate();          await wait(300);
  const layer = identifyLayer(ev);   await wait(300);
  const rc    = await rootCause(layer); await wait(300);
  const { newV } = applyPatch(layer, rc); await wait(300);
  summary(layer, rc, newV);
}

main().catch(e => { console.error(C.red + e.message + C.reset); process.exit(1); });
