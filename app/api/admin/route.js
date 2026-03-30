// app/api/admin/route.js
// Admin-only: system report, formula rollback, manual patch audit, scraper trigger

import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';
import { generateSystemReport } from '@/server/engine/accuracy-tracker';
import { formulaManager } from '@/server/engine/formula';

const prisma = new PrismaClient();

async function requireAdmin(clerkId) {
  const user = await prisma.user.findUnique({ where: { clerkId } });
  if (!user || user.plan !== 'ELITE') {
    return { error: true, user: null };
  }
  return { error: false, user };
}

// ─── GET /api/admin?view=report|patches|versions|drift ────────────────────────

export async function GET(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { error, user } = await requireAdmin(clerkId);
    if (error) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

    const { searchParams } = new URL(request.url);
    const view = searchParams.get('view') || 'report';

    if (view === 'report') {
      const report = await generateSystemReport();
      return NextResponse.json(report);
    }

    if (view === 'patches') {
      const page = parseInt(searchParams.get('page') || '1');
      const layer = searchParams.get('layer');

      const patches = await prisma.formulaPatch.findMany({
        where: layer ? { failedLayer: layer } : {},
        orderBy: { appliedAt: 'desc' },
        skip: (page - 1) * 20,
        take: 20,
        include: {
          fromVersion: { select: { version: true } },
          result: {
            include: {
              match: {
                select: { homeTeam: true, awayTeam: true, competition: true, betType: true },
              },
            },
          },
        },
      });

      const total = await prisma.formulaPatch.count({
        where: layer ? { failedLayer: layer } : {},
      });

      return NextResponse.json({ patches, total, page });
    }

    if (view === 'versions') {
      const versions = await prisma.formulaVersion.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          _count: { select: { predictions: true, patches: true } },
        },
      });
      return NextResponse.json({ versions });
    }

    if (view === 'usage') {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const [byPlan, totalCost, topUsers] = await Promise.all([
        prisma.user.groupBy({
          by: ['plan'],
          _count: { id: true },
        }),
        prisma.usageLog.aggregate({
          where: { createdAt: { gte: since } },
          _sum: { cost: true, tokensUsed: true },
          _count: true,
        }),
        prisma.usageLog.groupBy({
          by: ['userId'],
          _sum: { cost: true },
          orderBy: { _sum: { cost: 'desc' } },
          take: 10,
        }),
      ]);

      return NextResponse.json({
        planDistribution: Object.fromEntries(byPlan.map(p => [p.plan, p._count.id])),
        totalCost30d: Number((totalCost._sum.cost || 0).toFixed(4)),
        totalTokens30d: totalCost._sum.tokensUsed || 0,
        totalCalls30d: totalCost._count,
        topSpenders: topUsers,
      });
    }

    return NextResponse.json({ error: 'Invalid view' }, { status: 400 });

  } catch (err) {
    console.error('Admin GET error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// ─── POST /api/admin — Admin actions ─────────────────────────────────────────

export async function POST(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { error } = await requireAdmin(clerkId);
    if (error) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

    const body = await request.json();
    const { action } = body;

    // ── Roll back to a specific formula version ──────────────────────────
    if (action === 'rollback') {
      const { targetVersionId } = body;
      if (!targetVersionId) return NextResponse.json({ error: 'targetVersionId required' }, { status: 400 });

      const targetVersion = await prisma.formulaVersion.findUnique({
        where: { id: targetVersionId },
      });
      if (!targetVersion) return NextResponse.json({ error: 'Version not found' }, { status: 404 });

      await prisma.$transaction([
        prisma.formulaVersion.updateMany({ data: { isActive: false } }),
        prisma.formulaVersion.update({ where: { id: targetVersionId }, data: { isActive: true } }),
      ]);

      formulaManager._activeFormula = null; // Invalidate cache

      if (global._io) {
        global._io.to('formula:updates').emit('formula:rollback', {
          version: targetVersion.version,
        });
      }

      return NextResponse.json({
        success: true,
        message: `Rolled back to v${targetVersion.version}`,
        version: targetVersion.version,
      });
    }

    // ── Trigger accuracy snapshot ────────────────────────────────────────
    if (action === 'snapshot') {
      const { buildAndSaveSnapshot } = await import('@/server/engine/accuracy-tracker');
      const active = await formulaManager.getActiveFormula();
      const result = await buildAndSaveSnapshot(active.id);
      return NextResponse.json({ success: true, result });
    }

    // ── Trigger auto-verification scraper ────────────────────────────────
    if (action === 'scrape') {
      // Call data engine endpoint
      const res = await fetch(`http://localhost:${process.env.DATA_ENGINE_PORT || 3001}/admin/snapshot`, {
        method: 'POST',
      });
      return NextResponse.json({ success: res.ok, message: 'Scraper triggered' });
    }

    // ── Update plan for a user (admin override) ──────────────────────────
    if (action === 'set_plan') {
      const { userId, plan } = body;
      if (!userId || !plan) return NextResponse.json({ error: 'userId and plan required' }, { status: 400 });
      if (!['FREE', 'PRO', 'ELITE'].includes(plan)) return NextResponse.json({ error: 'Invalid plan' }, { status: 400 });

      const updated = await prisma.user.update({
        where: { id: userId },
        data: { plan },
      });

      return NextResponse.json({ success: true, user: updated });
    }

    // ── Seed base formula ────────────────────────────────────────────────
    if (action === 'seed_formula') {
      const formula = await formulaManager.seedBaseFormula();
      return NextResponse.json({ success: true, version: formula.version });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

  } catch (err) {
    console.error('Admin POST error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
