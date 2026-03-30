// app/api/slips/route.js  [v2.0 — sport-aware ingestion]
import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { PrismaClient } from '@prisma/client';
import { extractSlipFromImage, extractSlipFromText } from '@/server/ai/orchestrator';
import { predictSlip } from '@/server/engine/predictor';
import { detectSport, getSlipSportBreakdown } from '@/server/engine/sport-router';
import { z } from 'zod';

const prisma = new PrismaClient();

const TextSlip   = z.object({ source: z.literal('TEXT'),   rawInput: z.string().min(5).max(5000), autoPredict: z.boolean().optional().default(true) });
const ImageSlip  = z.object({ source: z.enum(['IMAGE','OCR_IMAGE']), imageBase64: z.string(), mimeType: z.enum(['image/jpeg','image/png','image/webp']).optional().default('image/jpeg'), autoPredict: z.boolean().optional().default(true) });
const ManualSlip = z.object({
  source: z.literal('MANUAL'),
  matches: z.array(z.object({
    sport:       z.enum(['FOOTBALL','BASKETBALL']).optional(),
    homeTeam:    z.string().min(2),
    awayTeam:    z.string().min(2),
    betType:     z.string(),
    betLine:     z.number().optional().nullable(),
    betTarget:   z.string().optional().nullable(),
    competition: z.string().optional().nullable(),
    scheduledAt: z.string().optional().nullable(),
  })).min(1).max(20),
  autoPredict: z.boolean().optional().default(true),
});

export async function POST(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const today = new Date(); today.setHours(0,0,0,0);
    const todaySlips = await prisma.betSlip.count({ where: { userId: user.id, createdAt: { gte: today } } });
    const limits = { FREE: 3, PRO: 25, ELITE: 200 };
    if (todaySlips >= (limits[user.plan] || 3)) return NextResponse.json({ error: `Daily slip limit (${limits[user.plan]} for ${user.plan})`, upgradeUrl: '/pricing' }, { status: 429 });

    const body = await request.json();
    let parsedMatches = [], source = body.source, rawInput = '';

    if (source === 'TEXT') {
      const v = TextSlip.parse(body);
      rawInput = v.rawInput;
      parsedMatches = await extractSlipFromText(rawInput);
    } else if (source === 'IMAGE' || source === 'OCR_IMAGE') {
      const v = ImageSlip.parse(body);
      rawInput = `[Image — ${v.mimeType}]`;
      parsedMatches = await extractSlipFromImage(v.imageBase64, v.mimeType);
    } else if (source === 'MANUAL') {
      const v = ManualSlipSchema.parse(body);
      parsedMatches = v.matches;
      rawInput = JSON.stringify(parsedMatches);
    } else {
      return NextResponse.json({ error: 'Invalid source' }, { status: 400 });
    }

    if (!parsedMatches?.length) return NextResponse.json({ error: 'No matches extracted' }, { status: 422 });

    // Auto-detect sport per match
    const matchesWithSport = parsedMatches.map(m => ({ ...m, sport: m.sport || detectSport(m) }));
    const sportBreakdown   = getSlipSportBreakdown(matchesWithSport);
    const dominantSport    = Object.entries(sportBreakdown).sort(([,a],[,b]) => b-a)[0]?.[0] || 'FOOTBALL';

    const slip = await prisma.betSlip.create({
      data: {
        userId: user.id, source, rawInput, status: 'PROCESSING', sport: dominantSport,
        matches: {
          create: matchesWithSport.map(m => ({
            sport:       m.sport || 'FOOTBALL',
            homeTeam:    m.homeTeam,
            awayTeam:    m.awayTeam,
            competition: m.competition || null,
            scheduledAt: m.scheduledAt ? new Date(m.scheduledAt) : null,
            betType:     m.betType,
            betTarget:   m.betTarget || null,
            betLine:     m.betLine   || null,
          })),
        },
      },
      include: { matches: true },
    });

    if (body.autoPredict !== false) {
      predictSlip(matchesWithSport, user.id, slip.id).catch(console.error);
    }

    return NextResponse.json({
      success: true, slipId: slip.id,
      matchesExtracted: parsedMatches.length,
      sports: sportBreakdown,
      matches: slip.matches.map(m => ({ id: m.id, sport: m.sport, homeTeam: m.homeTeam, awayTeam: m.awayTeam, betType: m.betType, betLine: m.betLine, competition: m.competition })),
      status: 'PROCESSING',
      estimatedTime: `${parsedMatches.length * 15}s`,
    }, { status: 201 });

  } catch (err) {
    if (err?.errors) return NextResponse.json({ error: 'Validation failed', details: err.errors }, { status: 400 });
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const { userId: clerkId } = auth();
    if (!clerkId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const user = await prisma.user.findUnique({ where: { clerkId } });
    if (!user) return NextResponse.json({ error: 'User not found' }, { status: 404 });

    const { searchParams } = new URL(request.url);
    const page   = parseInt(searchParams.get('page')  || '1');
    const limit  = Math.min(parseInt(searchParams.get('limit') || '10'), 50);
    const status = searchParams.get('status');
    const sport  = searchParams.get('sport');
    const where  = { userId: user.id, ...(status ? { status } : {}), ...(sport ? { sport } : {}) };

    const [slips, total] = await Promise.all([
      prisma.betSlip.findMany({ where, include: { matches: { include: { prediction: { select: { predictedOutcome: true, confidencePct: true, confidenceTier: true, wasCorrect: true, keyDriver: true, sport: true, backToBackFlag: true, injuryImpact: true } }, result: { select: { homeScore: true, awayScore: true, actualOutcome: true } } } } }, orderBy: { createdAt: 'desc' }, skip: (page-1)*limit, take: limit }),
      prisma.betSlip.count({ where }),
    ]);

    return NextResponse.json({ slips, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) { return NextResponse.json({ error: err.message }, { status: 500 }); }
}
