// app/api/predict/route.js
// Manual prediction trigger for a slip or individual match

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';
import { predictMatch, predictSlip } from '@/server/engine/predictor';
import { z } from 'zod';

const prisma = new PrismaClient();

const PredictSlipSchema = z.object({
  slipId: z.string().cuid(),
});

const PredictMatchSchema = z.object({
  matchId: z.string().cuid(),
});

// ─── POST /api/predict ────────────────────────────────────────────────────────

export async function POST(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const body = await request.json();

    // ── Predict an entire slip ────────────────────────────────────────────
    if (body.slipId) {
      const { slipId } = PredictSlipSchema.parse(body);

      const slip = await prisma.betSlip.findUnique({
        where: { id: slipId },
        include: { matches: true },
      });

      if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });
      if (slip.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      if (slip.status === 'PREDICTED') return NextResponse.json({ error: 'Slip already predicted', slipId }, { status: 409 });

      const results = await predictSlip(
        slip.matches.map(m => ({
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          betType: m.betType,
          betTarget: m.betTarget,
          competition: m.competition,
          scheduledAt: m.scheduledAt,
        })),
        user.id,
        slipId
      );

      return NextResponse.json({
        success: true,
        slipId,
        predictions: results,
        summary: {
          total: results.length,
          tier1: results.filter(r => r.confidenceTier === 'TIER1').length,
          tier2: results.filter(r => r.confidenceTier === 'TIER2').length,
          tier3: results.filter(r => r.confidenceTier === 'TIER3').length,
          averageConfidence: Math.round(results.reduce((sum, r) => sum + (r.confidencePct || 0), 0) / results.length),
          aiConflicts: results.filter(r => r.hadAIConflict).length,
          formulaVersion: results[0]?.formulaVersion,
        },
      });
    }

    // ── Predict a single match ─────────────────────────────────────────────
    if (body.matchId) {
      const { matchId } = PredictMatchSchema.parse(body);

      const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { slip: { select: { userId: true } }, prediction: true },
      });

      if (!match) return NextResponse.json({ error: 'Match not found' }, { status: 404 });
      if (match.slip.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      if (match.prediction) return NextResponse.json({ error: 'Match already predicted', prediction: match.prediction }, { status: 409 });

      const result = await predictMatch(
        {
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          betType: match.betType,
          betTarget: match.betTarget,
          competition: match.competition,
          scheduledAt: match.scheduledAt,
        },
        user.id,
        matchId
      );

      return NextResponse.json({ success: true, prediction: result });
    }

    return NextResponse.json({ error: 'Provide slipId or matchId' }, { status: 400 });

  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.errors }, { status: 400 });
    }
    console.error('Prediction error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── GET /api/predict?slipId=xxx — Get predictions for a slip ────────────────

export async function GET(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const slipId = searchParams.get('slipId');
    const matchId = searchParams.get('matchId');

    if (slipId) {
      const slip = await prisma.betSlip.findUnique({
        where: { id: slipId },
        include: {
          matches: {
            include: {
              prediction: true,
              result: true,
            },
          },
        },
      });

      if (!slip) return NextResponse.json({ error: 'Slip not found' }, { status: 404 });
      if (slip.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      return NextResponse.json({ slip });
    }

    if (matchId) {
      const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: {
          prediction: true,
          result: true,
          slip: { select: { userId: true } },
        },
      });

      if (!match) return NextResponse.json({ error: 'Match not found' }, { status: 404 });
      if (match.slip.userId !== user.id) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

      return NextResponse.json({ match });
    }

    return NextResponse.json({ error: 'Provide slipId or matchId query param' }, { status: 400 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
