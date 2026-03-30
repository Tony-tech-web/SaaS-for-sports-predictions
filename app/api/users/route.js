// app/api/users/route.js
// User profile management, prediction stats, usage tracking

import { NextResponse } from 'next/server';
import { auth, clerkClient } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── GET /api/users — Get current user profile + stats ───────────────────────

export async function GET(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // Upsert user (create on first access)
    const clerkUser = await clerkClient.users.getUser(clerkId);

    let user = await prisma.user.upsert({
      where: { clerkId },
      update: {},
      create: {
        clerkId,
        email: clerkUser.emailAddresses[0]?.emailAddress || '',
        name: `${clerkUser.firstName || ''} ${clerkUser.lastName || ''}`.trim() || null,
        plan: 'FREE',
      },
    });

    const { searchParams } = new URL(request.url);
    const includeStats = searchParams.get('stats') !== 'false';

    let stats = null;
    if (includeStats) {
      const [slipCount, predCount, verifiedPreds, usageLogs] = await Promise.all([
        prisma.betSlip.count({ where: { userId: user.id } }),
        prisma.prediction.count({ where: { userId: user.id } }),
        prisma.prediction.findMany({
          where: { userId: user.id, isVerified: true },
          select: { wasCorrect: true, confidenceTier: true, confidencePct: true },
        }),
        prisma.usageLog.aggregate({
          where: {
            userId: user.id,
            createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
          },
          _sum: { tokensUsed: true, cost: true },
          _count: true,
        }),
      ]);

      const correct = verifiedPreds.filter(p => p.wasCorrect).length;
      const tier1 = verifiedPreds.filter(p => p.confidenceTier === 'TIER1');
      const tier1Correct = tier1.filter(p => p.wasCorrect).length;

      stats = {
        slips: slipCount,
        predictions: predCount,
        verified: verifiedPreds.length,
        correct,
        accuracy: verifiedPreds.length > 0 ? Math.round((correct / verifiedPreds.length) * 100) : null,
        tier1Total: tier1.length,
        tier1Accuracy: tier1.length > 0 ? Math.round((tier1Correct / tier1.length) * 100) : null,
        avgConfidence: verifiedPreds.length > 0
          ? Math.round(verifiedPreds.reduce((s, p) => s + p.confidencePct, 0) / verifiedPreds.length)
          : null,
        usage30d: {
          calls: usageLogs._count,
          tokens: usageLogs._sum.tokensUsed || 0,
          cost: Number((usageLogs._sum.cost || 0).toFixed(4)),
        },
      };
    }

    // Daily limits
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [todaySlips, todayPredictions] = await Promise.all([
      prisma.betSlip.count({ where: { userId: user.id, createdAt: { gte: today } } }),
      prisma.prediction.count({ where: { userId: user.id, createdAt: { gte: today } } }),
    ]);

    const planLimits = {
      FREE:  { slips: 3, predictions: 5 },
      PRO:   { slips: 25, predictions: 50 },
      ELITE: { slips: 200, predictions: 500 },
    };

    const limits = planLimits[user.plan] || planLimits.FREE;

    return NextResponse.json({
      user: {
        id: user.id,
        clerkId: user.clerkId,
        email: user.email,
        name: user.name,
        plan: user.plan,
        createdAt: user.createdAt,
      },
      limits: {
        plan: user.plan,
        daily: {
          slips: { used: todaySlips, limit: limits.slips, remaining: Math.max(0, limits.slips - todaySlips) },
          predictions: { used: todayPredictions, limit: limits.predictions, remaining: Math.max(0, limits.predictions - todayPredictions) },
        },
      },
      stats,
    });

  } catch (err) {
    console.error('User GET error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── PATCH /api/users — Update user preferences ───────────────────────────────

export async function PATCH(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await request.json();
    const allowedFields = ['name'];
    const updateData = Object.fromEntries(
      Object.entries(body).filter(([k]) => allowedFields.includes(k))
    );

    if (Object.keys(updateData).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });
    }

    const user = await prisma.user.update({
      where: { clerkId },
      data: updateData,
    });

    return NextResponse.json({ success: true, user });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
