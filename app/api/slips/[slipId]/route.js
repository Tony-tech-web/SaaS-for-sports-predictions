// app/api/slips/[slipId]/route.js
// Single slip detail — GET full predictions, DELETE slip

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── GET /api/slips/[slipId] ──────────────────────────────────────────────────

export async function GET(request, { params }) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const slip = await prisma.betSlip.findUnique({
      where: { id: params.slipId },
      include: {
        matches: {
          include: {
            prediction: {
              include: {
                formulaVersion: { select: { version: true, tier1Rate: true } },
              },
            },
            result: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });
    if (slip.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Enrich with slip-level summary
    const predictions = slip.matches.map(m => m.prediction).filter(Boolean);
    const verified = predictions.filter(p => p.isVerified);
    const correct = verified.filter(p => p.wasCorrect);

    const summary = {
      totalMatches: slip.matches.length,
      predicted: predictions.length,
      verified: verified.length,
      correct: correct.length,
      accuracy: verified.length > 0 ? Math.round((correct.length / verified.length) * 100) : null,
      tier1Count: predictions.filter(p => p.confidenceTier === 'TIER1').length,
      tier2Count: predictions.filter(p => p.confidenceTier === 'TIER2').length,
      tier3Count: predictions.filter(p => p.confidenceTier === 'TIER3').length,
      avgConfidence: predictions.length > 0
        ? Math.round(predictions.reduce((s, p) => s + p.confidencePct, 0) / predictions.length)
        : null,
      hasAIConflicts: predictions.some(p =>
        p.consensusOutput?.consensus?.outcomeMismatch === true
      ),
      formulaVersion: predictions[0]?.formulaVersion?.version || null,
      patchesTriggered: predictions.filter(p => p.formulaPatchApplied).length,
    };

    return NextResponse.json({
      slip: {
        id: slip.id,
        source: slip.source,
        status: slip.status,
        createdAt: slip.createdAt,
        updatedAt: slip.updatedAt,
        matches: slip.matches.map(m => ({
          id: m.id,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          competition: m.competition,
          betType: m.betType,
          betTarget: m.betTarget,
          scheduledAt: m.scheduledAt,
          prediction: m.prediction ? {
            id: m.prediction.id,
            predictedOutcome: m.prediction.predictedOutcome,
            predictedScore: m.prediction.predictedScore,
            confidencePct: m.prediction.confidencePct,
            confidenceTier: m.prediction.confidenceTier,
            keyDriver: m.prediction.keyDriver,
            redFlags: m.prediction.redFlags,
            layerScores: m.prediction.layerScores,
            simulationResults: m.prediction.simulationResults,
            verdict: m.prediction.verdict,
            rationale: m.prediction.rationale,
            isVerified: m.prediction.isVerified,
            wasCorrect: m.prediction.wasCorrect,
            formulaPatchApplied: m.prediction.formulaPatchApplied,
            aiConflict: m.prediction.consensusOutput?.consensus?.outcomeMismatch || false,
            formulaVersion: m.prediction.formulaVersion?.version,
            createdAt: m.prediction.createdAt,
          } : null,
          result: m.result ? {
            homeScore: m.result.homeScore,
            awayScore: m.result.awayScore,
            actualOutcome: m.result.actualOutcome,
            totalGoals: m.result.totalGoals,
            verifiedAt: m.result.verifiedAt,
          } : null,
        })),
      },
      summary,
    });

  } catch (err) {
    console.error('Slip detail error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── DELETE /api/slips/[slipId] ───────────────────────────────────────────────

export async function DELETE(request, { params }) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const slip = await prisma.betSlip.findUnique({ where: { id: params.slipId } });
    if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });
    if (slip.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

    // Cascade delete predictions → matches → slip
    await prisma.$transaction([
      prisma.prediction.deleteMany({
        where: { match: { slipId: params.slipId } },
      }),
      prisma.matchResult.deleteMany({
        where: { match: { slipId: params.slipId } },
      }),
      prisma.match.deleteMany({ where: { slipId: params.slipId } }),
      prisma.betSlip.delete({ where: { id: params.slipId } }),
    ]);

    return NextResponse.json({ success: true, deleted: params.slipId });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
