// app/api/health/route.js
import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { formulaManager } from '@/server/engine/formula';

const prisma = new PrismaClient();

export async function GET() {
  try {
    // DB ping
    await prisma.$queryRaw`SELECT 1`;
    const activeFormula = await formulaManager.getActiveFormula();

    return NextResponse.json({
      status: 'healthy',
      service: 'Football Oracle API',
      formula: activeFormula?.version || 'unknown',
      db: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ status: 'degraded', error: err.message }, { status: 503 });
  }
}
