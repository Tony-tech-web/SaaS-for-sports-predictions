// server/ai/orchestrator.js
// Multi-AI consensus engine — Claude (primary) + GPT-4 (validator)
// Debate protocol resolves conflicts. Claude wins ties.

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const pRetry = require('p-retry');
const logger = require('../config/logger');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── SINGLE AI CALL: CLAUDE ───────────────────────────────────────────────────

async function callClaude(systemPrompt, userContent, options = {}) {
  const { maxTokens = 2000, temperature = 0.3, model = 'claude-opus-4-5' } = options;

  return pRetry(async () => {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        }
      ],
    });

    // Extract text from response (may include tool use blocks)
    const textBlocks = response.content.filter(b => b.type === 'text');
    const fullText = textBlocks.map(b => b.text).join('');

    return { raw: fullText, usage: response.usage, model, provider: 'claude' };
  }, {
    retries: 3,
    onFailedAttempt: (err) => {
      logger.warn({ attempt: err.attemptNumber, err: err.message }, 'Claude retry attempt');
    },
  });
}

// ─── SINGLE AI CALL: GPT-4 ───────────────────────────────────────────────────

async function callGPT4(systemPrompt, userContent, options = {}) {
  const { maxTokens = 2000, temperature = 0.3, model = 'gpt-4o' } = options;

  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OpenAI API key not set — skipping GPT-4 validation');
    return null;
  }

  return pRetry(async () => {
    const response = await openai.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    const text = response.choices[0]?.message?.content || '';
    return { raw: text, usage: response.usage, model, provider: 'gpt4' };
  }, {
    retries: 2,
    onFailedAttempt: (err) => {
      logger.warn({ attempt: err.attemptNumber, err: err.message }, 'GPT-4 retry attempt');
    },
  });
}

// ─── JSON PARSER ─────────────────────────────────────────────────────────────

function safeParseJSON(text) {
  if (!text) return null;

  // Strip markdown fences if present
  const cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  // Find JSON object
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1) return null;

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    // Try to extract partial JSON
    try {
      const partial = cleaned.slice(start);
      return JSON.parse(partial);
    } catch {
      logger.warn({ text: text.slice(0, 200) }, 'Failed to parse AI JSON response');
      return null;
    }
  }
}

// ─── CONFIDENCE GAP DETECTOR ──────────────────────────────────────────────────

function detectConflict(claudeOutput, gptOutput, consensusThreshold = 15) {
  if (!claudeOutput || !gptOutput) return false;

  const claudeConf = claudeOutput.confidencePct || 0;
  const gptConf = gptOutput.confidencePct || 0;
  const outcomeMismatch = claudeOutput.predictedOutcome !== gptOutput.predictedOutcome;
  const confGap = Math.abs(claudeConf - gptConf) > consensusThreshold;

  return outcomeMismatch || confGap;
}

// ─── DEBATE PROTOCOL ──────────────────────────────────────────────────────────

async function runDebateRound(systemPrompt, originalQuery, claudeOutput, gptOutput, round) {
  const debatePrompt = `
DEBATE ROUND ${round} — CONFLICT RESOLUTION REQUIRED

ORIGINAL MATCH QUERY:
${originalQuery}

CLAUDE ANALYSIS (Primary — 60% weight):
Predicted Outcome: ${claudeOutput.predictedOutcome}
Confidence: ${claudeOutput.confidencePct}%
Key Driver: ${claudeOutput.keyDriver}
Red Flags: ${JSON.stringify(claudeOutput.redFlags)}

GPT-4 ANALYSIS (Validator — 40% weight):
Predicted Outcome: ${gptOutput.predictedOutcome}
Confidence: ${gptOutput.confidencePct}%
Key Driver: ${gptOutput.keyDriver}

TASK: These two analyses conflict. As the tiebreaker, re-evaluate ONLY the specific points of conflict, incorporating the strongest arguments from both analyses. Output your FINAL MERGED prediction in the required JSON format. Do not hedge — make a definitive call.
`;

  const result = await callClaude(systemPrompt, debatePrompt, { maxTokens: 1500 });
  return safeParseJSON(result.raw);
}

// ─── CONSENSUS MERGER ─────────────────────────────────────────────────────────

function mergeConsensus(claudeOutput, gptOutput, weights = { claude: 0.60, gpt4: 0.40 }) {
  if (!claudeOutput) return gptOutput;
  if (!gptOutput) return claudeOutput;

  const outcomeMismatch = claudeOutput.predictedOutcome !== gptOutput.predictedOutcome;

  // If outcomes disagree, Claude wins (primary model)
  const finalOutcome = outcomeMismatch
    ? claudeOutput.predictedOutcome
    : claudeOutput.predictedOutcome;

  // Weighted confidence average
  const claudeConf = claudeOutput.confidencePct || 0;
  const gptConf = gptOutput.confidencePct || 0;
  let mergedConf = (claudeConf * weights.claude) + (gptConf * weights.gpt4);

  // If outcomes disagreed, reduce confidence
  if (outcomeMismatch) mergedConf = mergedConf * 0.88;

  mergedConf = Math.min(98, Math.max(30, Math.round(mergedConf)));

  // Tier assignment
  let tier;
  if (mergedConf >= 80) tier = 'TIER1';
  else if (mergedConf >= 65) tier = 'TIER2';
  else tier = 'TIER3';

  // Merge red flags (union)
  const claudeFlags = Array.isArray(claudeOutput.redFlags) ? claudeOutput.redFlags : [];
  const gptFlags = Array.isArray(gptOutput.redFlags) ? gptOutput.redFlags : [];
  const allFlags = [...new Set([...claudeFlags, ...gptFlags])];

  // If they disagreed, add a flag
  if (outcomeMismatch) {
    allFlags.push(`MODEL DISAGREEMENT: Claude predicted ${claudeOutput.predictedOutcome} (${claudeConf}%), GPT-4 predicted ${gptOutput.predictedOutcome} (${gptConf}%)`);
  }

  return {
    ...claudeOutput,
    predictedOutcome: finalOutcome,
    confidencePct: mergedConf,
    confidenceTier: tier,
    redFlags: allFlags,
    consensus: {
      claudeConfidence: claudeConf,
      gptConfidence: gptConf,
      outcomeMismatch,
      mergeWeights: weights,
      finalConfidence: mergedConf,
    },
  };
}

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────

/**
 * Run multi-AI prediction with consensus protocol
 * @param {string} systemPrompt - The active formula system prompt
 * @param {string} matchQuery - The structured match analysis request
 * @param {Object} options - { consensusThreshold, debateRounds, weights }
 */
async function orchestratePrediction(systemPrompt, matchQuery, options = {}) {
  const {
    consensusThreshold = 15,
    debateRounds = 2,
    weights = { claude: 0.60, gpt4: 0.40 },
  } = options;

  logger.info({ matchQuery: matchQuery.slice(0, 100) }, '🧠 Starting AI orchestration');

  // ── STEP 1: Run Claude (primary) ─────────────────────────────────────────
  logger.info('Running Claude primary analysis...');
  const claudeResult = await callClaude(systemPrompt, matchQuery);
  const claudeOutput = safeParseJSON(claudeResult.raw);

  if (!claudeOutput) {
    throw new Error('Claude failed to return valid JSON prediction');
  }

  // ── STEP 2: Run GPT-4 (validator) ────────────────────────────────────────
  let gptOutput = null;
  if (process.env.OPENAI_API_KEY) {
    logger.info('Running GPT-4 validation...');
    try {
      const gptResult = await callGPT4(systemPrompt, matchQuery);
      if (gptResult) gptOutput = safeParseJSON(gptResult.raw);
    } catch (err) {
      logger.warn({ err: err.message }, 'GPT-4 validation failed — proceeding with Claude only');
    }
  }

  // ── STEP 3: Conflict detection ────────────────────────────────────────────
  const hasConflict = detectConflict(claudeOutput, gptOutput, consensusThreshold);
  let finalOutput;

  if (hasConflict && gptOutput) {
    logger.info({
      claudeOutcome: claudeOutput.predictedOutcome,
      gptOutcome: gptOutput.predictedOutcome,
      claudeConf: claudeOutput.confidencePct,
      gptConf: gptOutput.confidencePct,
    }, '⚡ Conflict detected — entering debate protocol');

    // ── STEP 4: Debate rounds ─────────────────────────────────────────────
    let debateOutput = null;
    for (let round = 1; round <= debateRounds; round++) {
      debateOutput = await runDebateRound(systemPrompt, matchQuery, claudeOutput, gptOutput, round);
      if (debateOutput) break;
    }

    finalOutput = debateOutput || mergeConsensus(claudeOutput, gptOutput, weights);
  } else {
    // ── STEP 5: Merge without debate ─────────────────────────────────────
    finalOutput = mergeConsensus(claudeOutput, gptOutput, weights);
  }

  // ── STEP 6: Final validation & tier assignment ────────────────────────────
  const conf = finalOutput.confidencePct || 50;
  finalOutput.confidenceTier = conf >= 80 ? 'TIER1' : conf >= 65 ? 'TIER2' : 'TIER3';

  logger.info({
    outcome: finalOutput.predictedOutcome,
    confidence: finalOutput.confidencePct,
    tier: finalOutput.confidenceTier,
    hadConflict: hasConflict,
  }, '✅ AI orchestration complete');

  return {
    claudeOutput,
    gptOutput,
    consensusOutput: finalOutput,
    hadConflict: hasConflict,
    metadata: {
      claudeTokens: claudeResult.usage,
      gptTokens: null,
      debateRoundsUsed: hasConflict ? debateRounds : 0,
    },
  };
}

// ─── IMAGE OCR: Extract bet slip from image ────────────────────────────────────

async function extractSlipFromImage(imageBase64, mimeType = 'image/jpeg') {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: imageBase64 },
        },
        {
          type: 'text',
          text: `Extract all bet selections from this betting slip image. Return ONLY a JSON array with this structure:
[{
  "homeTeam": string,
  "awayTeam": string,
  "betType": "HOME" | "AWAY" | "DRAW" | "OVER_X.X" | "UNDER_X.X" | "BTTS_YES" | "BTTS_NO",
  "betTarget": string | null,
  "competition": string | null,
  "scheduledAt": string | null
}]
Be precise. Ignore odds. Extract only match and bet type information.`,
        },
      ],
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  return safeParseJSON(text) || [];
}

// ─── TEXT PARSER: Extract bet slip from text ──────────────────────────────────

async function extractSlipFromText(rawText) {
  const response = await anthropic.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Parse the following betting slip text and extract all bet selections. Return ONLY a JSON array:
[{
  "homeTeam": string,
  "awayTeam": string,
  "betType": "HOME" | "AWAY" | "DRAW" | "OVER_X.X" | "UNDER_X.X" | "BTTS_YES" | "BTTS_NO",
  "betTarget": string | null,
  "competition": string | null,
  "scheduledAt": string | null
}]

Betting slip text:
${rawText}`,
    }],
  });

  const text = response.content.find(b => b.type === 'text')?.text || '';
  return safeParseJSON(text) || [];
}

module.exports = {
  orchestratePrediction,
  extractSlipFromImage,
  extractSlipFromText,
  callClaude,
  callGPT4,
  safeParseJSON,
};
