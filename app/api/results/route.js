// app/api/results/route.js  [v2.0 — multi-sport with basketball splits]
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const SingleResult = z.object({
  matchId:          z.string().cuid(),
  homeScore:        z.number().int().min(0).max(300),
  awayScore:        z.number().int().min(0).max(300),
  source:           z.enum(['MANUAL','API','WEB_SCRAPE']).optional().default('MANUAL'),
  homeFirstHalf:    z.number().int().optional(),
  awayFirstHalf:    z.number().int().optional(),
  homeFirstQuarter: z.number().int().optional(),
  awayFirstQuarter: z.number().int().optional(),
  overtime:         z.boolean().optional().default(false),
  backToBackOccurred: z.boolean().optional(),
});

const BatchResults = z.object({ results: z.array(SingleResult).min(1).max(50) });

async function processResult(data, clerkId) {
  const match = await prisma.match.findUnique({
    where: { id: data.matchId },
    include: { prediction: true, slip: { select: { userId: true } } },
  });
  if (!match) throw Object.assign(new Error('Match not found'), { status: 404 });

  const user = await prisma.user.findUnique({ where: { clerkId } });
  if (match.slip.userId !== user?.id && user?.plan !== 'ELITE') throw Object.assign(new Error('Forbidden'), { status: 403 });

  const exists = await prisma.matchResult.findUnique({ where: { matchId: data.matchId } });
  if (exists) throw Object.assign(new Error('Already verified'), { status: 409 });

  const sport         = match.sport || 'FOOTBALL';
  const { homeScore, awayScore } = data;
  const actualOutcome = homeScore > awayScore ? 'HOME' : awayScore > homeScore ? 'AWAY' : 'DRAW';
  const totalGoals    = homeScore + awayScore;

  const result = await prisma.matchResult.create({
    data: { matchId: data.matchId, sport, homeScore, awayScore, actualOutcome, totalGoals, homeFirstHalf: data.homeFirstHalf || null, awayFirstHalf: data.awayFirstHalf || null, homeFirstQuarter: data.homeFirstQuarter || null, awayFirstQuarter: data.awayFirstQuarter || null, overtime: data.overtime || false, source: data.source || 'MANUAL' },
  });

  if (!match.prediction) return { verified: true, wasCorrect: null, sport };

  // Evaluate via sport router
  const { evaluatePrediction, identifyFailedLayer, getFormulaForSport } = await import('@/server/engine/sport-router');
  const { wasCorrect, failureType, predictedValue, actualValue } = evaluatePrediction(sport, match.prediction, { homeScore, awayScore, actualOutcome, totalGoals, backToBackOccurred: data.backToBackOccurred });

  await prisma.prediction.update({ where: { id: match.prediction.id }, data: { isVerified: true, wasCorrect } });

  if (!wasCorrect && failureType && failureType !== 'INSUFFICIENT_DATA') {
    const failedLayer  = identifyFailedLayer(sport, match.prediction, { homeScore, awayScore, actualOutcome, totalGoals, backToBackOccurred: data.backToBackOccurred }, failureType);
    const activeFormula = await getFormulaForSport(sport);

    // Fire-and-forget self-heal
    runSelfHeal({ match, prediction: match.prediction, result, sport, failedLayer, failureType, predictedValue, actualValue, activeFormulaId: activeFormula.id }).catch(console.error);

    return { verified: true, wasCorrect: false, failureType, predictedValue, actualValue, selfHealTriggered: true, failedLayer, sport };
  }

  return { verified: true, wasCorrect, actualOutcome, score: `${homeScore}-${awayScore}`, sport };
}

async function runSelfHeal({ match, prediction, result, sport, failedLayer, failureType, predictedValue, actualValue, activeFormulaId }) {
  try {
    const { callClaude } = await import('@/server/ai/orchestrator');
    const { formulaManager } = await import('@/server/engine/formula');

    const sys = `You are a ${sport} prediction forensics expert. Identify why ${failedLayer} failed. ONLY suggest additions to this layer. Return JSON: {failureAnalysis,rootCause,modifierToAdd:{description,trigger,adjustment,adjustmentType,appliesTo},patchDescription,aiReasoning}`;
    const q   = `FAILURE: ${match.homeTeam} vs ${match.awayTeam} [${match.betType}] | Predicted: ${prediction.predictedOutcome} (${prediction.confidencePct}%) | Actual: ${result.homeScore}-${result.awayScore} | Layer: ${failedLayer} | Type: ${failureType}`;

    const res = await callClaude(sys, q, { maxTokens: 600 });
    const txt = res.raw, s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    const rc  = JSON.parse(txt.slice(s, e + 1));

    await formulaManager.applyPatch({ fromVersionId: activeFormulaId, resultId: result.id, failedLayer, patchDiff: {}, modifierAdded: rc.modifierToAdd, patchDescription: rc.patchDescription, aiReasoning: rc.aiReasoning, failureAnalysis: rc.failureAnalysis, failureType, predictedValue, actualValue });
    await prisma.prediction.update({ where: { id: prediction.id }, data: { formulaPatchApplied: true } });
    if (global._io) global._io.to('formula:updates').emit('formula:patched', { sport, failedLayer });
  } catch (err) { console.error('Self-heal failed:', err.message); }
}

export async function POST(req) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await req.json();

    if (body.results) {
      const { results } = BatchResults.parse(body);
      const outcomes = [];
      for (const r of results) {
        try { outcomes.push({ matchId: r.matchId, ...(await processResult(r, clerkId)) }); }
        catch (e) { outcomes.push({ matchId: r.matchId, error: e.message }); }
      }
      const correct = outcomes.filter(o => o.wasCorrect).length;
      return NextResponse.json({ success: true, total: results.length, correct, incorrect: results.length - correct, accuracy: Math.round((correct / results.length) * 100), outcomes });
    }

    const validated = SingleResult.parse(body);
    const outcome   = await processResult(validated, clerkId);
    return NextResponse.json({ success: true, result: outcome });
  } catch (err) {
    if (err?.status) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err?.errors) return NextResponse.json({ error: 'Validation failed', details: err.errors }, { status: 400 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(req) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const { searchParams } = new URL(req.url);
    const page  = parseInt(searchParams.get('page')  || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
    const sport = searchParams.get('sport');
    const where = { userId: user.id, isVerified: true, ...(sport ? { sport } : {}) };

    const [predictions, total, allVerified] = await Promise.all([
      prisma.prediction.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (page-1)*limit, take: limit, include: { match: { include: { result: true } }, formulaVersion: { select: { version: true } } } }),
      prisma.prediction.count({ where }),
      prisma.prediction.findMany({ where: { userId: user.id, isVerified: true }, select: { wasCorrect: true, confidenceTier: true, sport: true } }),
    ]);

    const statsBySport = {};
    for (const s of ['FOOTBALL', 'BASKETBALL']) {
      const sp = allVerified.filter(p => p.sport === s);
      const t1 = sp.filter(p => p.confidenceTier === 'TIER1');
      statsBySport[s] = { total: sp.length, correct: sp.filter(p => p.wasCorrect).length, accuracy: sp.length > 0 ? Math.round((sp.filter(p => p.wasCorrect).length / sp.length) * 100) : null, tier1Total: t1.length, tier1Accuracy: t1.length > 0 ? Math.round((t1.filter(p => p.wasCorrect).length / t1.length) * 100) : null };
    }

    return NextResponse.json({ predictions: predictions.map(p => ({ id: p.id, sport: p.sport, match: `${p.match.homeTeam} vs ${p.match.awayTeam}`, betType: p.match.betType, betLine: p.match.betLine, predicted: p.predictedOutcome, actual: p.match.result?.actualOutcome, score: p.match.result ? `${p.match.result.homeScore}-${p.match.result.awayScore}` : null, confidence: p.confidencePct, tier: p.confidenceTier, correct: p.wasCorrect, patched: p.formulaPatchApplied, formulaVersion: p.formulaVersion.version, backToBackFlag: p.backToBackFlag, injuryImpact: p.injuryImpact })), stats: { overall: { total: allVerified.length, correct: allVerified.filter(p => p.wasCorrect).length, accuracy: allVerified.length > 0 ? Math.round((allVerified.filter(p => p.wasCorrect).length / allVerified.length) * 100) : null }, bySport: statsBySport }, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { return NextResponse.json({ error: err.message }, { status: 500 }); }
}
