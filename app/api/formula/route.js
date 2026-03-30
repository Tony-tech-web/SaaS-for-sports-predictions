// app/api/formula/route.js
// Formula version management, accuracy tracking, patch history

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';
import { formulaManager, BASE_FORMULA } from '@/server/engine/formula';

const prisma = new PrismaClient();

// ─── GET /api/formula — Get active formula and version history ─────────────────

export async function GET(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view') || 'active'; // active | history | patches | accuracy

    if (view === 'active') {
      const active = await formulaManager.getActiveFormula();
      return NextResponse.json({
        version: active.version,
        isActive: true,
        formulaJson: active.formulaJson,
        systemPromptPreview: active.systemPrompt?.slice(0, 500) + '...',
        changelog: active.changelog,
        stats: {
          totalPredictions: active.totalPredictions,
          correctPredictions: active.correctPredictions,
          accuracy: active.totalPredictions > 0
            ? Math.round((active.correctPredictions / active.totalPredictions) * 100)
            : null,
          accuracy7d: active.accuracy7d,
          accuracy30d: active.accuracy30d,
          tier1Rate: active.tier1Rate,
        },
        createdAt: active.createdAt,
      });
    }

    if (view === 'history') {
      const versions = await prisma.formulaVersion.findMany({
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true, version: true, isActive: true,
          changelog: true, createdAt: true,
          totalPredictions: true, correctPredictions: true,
          accuracy7d: true, tier1Rate: true,
          majorVersion: true, minorVersion: true, patchVersion: true,
        },
      });

      return NextResponse.json({
        versions: versions.map(v => ({
          ...v,
          accuracy: v.totalPredictions > 0
            ? Math.round((v.correctPredictions / v.totalPredictions) * 100)
            : null,
        })),
      });
    }

    if (view === 'patches') {
      const page = parseInt(searchParams.get('page') || '1');
      const patches = await prisma.formulaPatch.findMany({
        orderBy: { appliedAt: 'desc' },
        take: 20,
        skip: (page - 1) * 20,
        include: {
          fromVersion: { select: { version: true } },
          result: {
            include: {
              match: { select: { homeTeam: true, awayTeam: true, betType: true } },
            },
          },
        },
      });

      return NextResponse.json({
        patches: patches.map(p => ({
          id: p.id,
          fromVersion: p.fromVersion.version,
          newVersion: p.newVersionId ? `v${p.newVersionId}` : null,
          match: p.result?.match ? `${p.result.match.homeTeam} vs ${p.result.match.awayTeam}` : 'Unknown',
          betType: p.result?.match?.betType,
          failedLayer: p.failedLayer,
          failureType: p.failureType,
          predictedValue: p.predictedValue,
          actualValue: p.actualValue,
          patchDescription: p.patchDescription,
          modifierAdded: p.modifierAdded,
          failureAnalysis: p.failureAnalysis,
          aiReasoning: p.aiReasoning,
          appliedAt: p.appliedAt,
        })),
      });
    }

    if (view === 'accuracy') {
      // Compute accuracy breakdown by bet type and tier
      const predictions = await prisma.prediction.findMany({
        where: { isVerified: true },
        select: {
          predictedOutcome: true,
          confidenceTier: true,
          wasCorrect: true,
          confidencePct: true,
          formulaVersion: { select: { version: true } },
        },
      });

      const byTier = { TIER1: { total: 0, correct: 0 }, TIER2: { total: 0, correct: 0 }, TIER3: { total: 0, correct: 0 } };
      const byOutcome = {};

      for (const p of predictions) {
        byTier[p.confidenceTier].total++;
        if (p.wasCorrect) byTier[p.confidenceTier].correct++;

        const outcome = p.predictedOutcome.startsWith('OVER') ? 'OVER' : p.predictedOutcome.startsWith('UNDER') ? 'UNDER' : p.predictedOutcome;
        if (!byOutcome[outcome]) byOutcome[outcome] = { total: 0, correct: 0 };
        byOutcome[outcome].total++;
        if (p.wasCorrect) byOutcome[outcome].correct++;
      }

      const tierAccuracy = Object.fromEntries(
        Object.entries(byTier).map(([tier, data]) => [
          tier,
          { ...data, accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 100) : null },
        ])
      );

      const outcomeAccuracy = Object.fromEntries(
        Object.entries(byOutcome).map(([outcome, data]) => [
          outcome,
          { ...data, accuracy: data.total > 0 ? Math.round((data.correct / data.total) * 100) : null },
        ])
      );

      return NextResponse.json({
        totalVerified: predictions.length,
        overall: {
          correct: predictions.filter(p => p.wasCorrect).length,
          accuracy: predictions.length > 0 ? Math.round((predictions.filter(p => p.wasCorrect).length / predictions.length) * 100) : null,
        },
        byTier: tierAccuracy,
        byOutcome: outcomeAccuracy,
      });
    }

    return NextResponse.json({ error: 'Invalid view parameter' }, { status: 400 });

  } catch (err) {
    console.error('Formula API error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST /api/formula — Seed base formula (admin only) ──────────────────────

export async function POST(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user || user.plan !== 'ELITE') {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const body = await request.json();
    const { action } = body;

    if (action === 'seed') {
      const formula = await formulaManager.seedBaseFormula();
      return NextResponse.json({ success: true, formula });
    }

    if (action === 'rollback') {
      const { targetVersionId } = body;
      if (!targetVersionId) return NextResponse.json({ error: 'targetVersionId required' }, { status: 400 });

      await prisma.formulaVersion.updateMany({ data: { isActive: false } });
      await prisma.formulaVersion.update({
        where: { id: targetVersionId },
        data: { isActive: true },
      });

      formulaManager._activeFormula = null; // Invalidate cache

      return NextResponse.json({ success: true, message: `Rolled back to ${targetVersionId}` });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
