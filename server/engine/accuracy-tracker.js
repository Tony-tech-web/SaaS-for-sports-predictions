// server/engine/accuracy-tracker.js
// Computes rolling accuracy stats, generates snapshots, detects formula drift

'use strict';

const { PrismaClient } = require('@prisma/client');
const { formulaManager } = require('./formula');
const logger = require('../config/logger');

const prisma = new PrismaClient();

// ─── ROLLING ACCURACY ────────────────────────────────────────────────────────

async function computeRollingAccuracy(formulaVersionId, windowDays = 7) {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

  const predictions = await prisma.prediction.findMany({
    where: {
      formulaVersionId,
      isVerified: true,
      updatedAt: { gte: since },
    },
    select: {
      wasCorrect: true,
      confidenceTier: true,
      confidencePct: true,
      predictedOutcome: true,
    },
  });

  if (predictions.length === 0) return null;

  const total = predictions.length;
  const correct = predictions.filter(p => p.wasCorrect).length;

  const byTier = {
    TIER1: { total: 0, correct: 0 },
    TIER2: { total: 0, correct: 0 },
    TIER3: { total: 0, correct: 0 },
  };

  const byOutcome = {};

  for (const p of predictions) {
    byTier[p.confidenceTier].total++;
    if (p.wasCorrect) byTier[p.confidenceTier].correct++;

    const outcome = p.predictedOutcome.startsWith('OVER')
      ? 'OVER'
      : p.predictedOutcome.startsWith('UNDER')
        ? 'UNDER'
        : p.predictedOutcome;

    if (!byOutcome[outcome]) byOutcome[outcome] = { total: 0, correct: 0 };
    byOutcome[outcome].total++;
    if (p.wasCorrect) byOutcome[outcome].correct++;
  }

  const rate = (t) => t.total > 0 ? Math.round((t.correct / t.total) * 100) / 100 : null;

  return {
    windowDays,
    total,
    correct,
    overallAccuracy: rate({ total, correct }),
    tier1: { ...byTier.TIER1, accuracy: rate(byTier.TIER1) },
    tier2: { ...byTier.TIER2, accuracy: rate(byTier.TIER2) },
    tier3: { ...byTier.TIER3, accuracy: rate(byTier.TIER3) },
    byOutcome: Object.fromEntries(
      Object.entries(byOutcome).map(([k, v]) => [k, { ...v, accuracy: rate(v) }])
    ),
  };
}

// ─── DRIFT DETECTOR ──────────────────────────────────────────────────────────
// Detects if formula accuracy is consistently declining (needs manual review)

async function detectDrift(formulaVersionId) {
  const snapshots = await prisma.accuracySnapshot.findMany({
    where: { versionId: formulaVersionId },
    orderBy: { snapshotDate: 'desc' },
    take: 10,
  });

  if (snapshots.length < 3) return { driftDetected: false, reason: 'Insufficient data' };

  const recent = snapshots.slice(0, 3).map(s => s.overallRate);
  const older = snapshots.slice(3, 6).map(s => s.overallRate);

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.length > 0 ? older.reduce((a, b) => a + b, 0) / older.length : null;

  const driftThreshold = 0.10; // 10% drop triggers alert
  const tier1DriftThreshold = 0.08;

  const tier1Recent = snapshots.slice(0, 3).map(s => s.tier1Rate);
  const tier1Avg = tier1Recent.reduce((a, b) => a + b, 0) / tier1Recent.length;

  const isDrifting = olderAvg !== null && (olderAvg - recentAvg) > driftThreshold;
  const tier1Drifting = tier1Avg < (0.80 - tier1DriftThreshold);

  return {
    driftDetected: isDrifting || tier1Drifting,
    overallAccuracy: recentAvg,
    tier1Rate: tier1Avg,
    trend: isDrifting ? 'DECLINING' : 'STABLE',
    tier1Status: tier1Drifting ? 'BELOW_TARGET' : 'ON_TARGET',
    snapshotsAnalysed: snapshots.length,
    recommendation: isDrifting || tier1Drifting
      ? 'Review recent patches — formula may need manual adjustment'
      : 'Formula performing within acceptable bounds',
  };
}

// ─── SNAPSHOT BUILDER ────────────────────────────────────────────────────────

async function buildAndSaveSnapshot(formulaVersionId) {
  logger.info({ formulaVersionId }, '📸 Building accuracy snapshot');

  const [stats7d, stats30d] = await Promise.all([
    computeRollingAccuracy(formulaVersionId, 7),
    computeRollingAccuracy(formulaVersionId, 30),
  ]);

  const stats = stats30d || stats7d;
  if (!stats) {
    logger.info({ formulaVersionId }, 'No verified predictions yet — skipping snapshot');
    return null;
  }

  // Update formula version stats
  await prisma.formulaVersion.update({
    where: { id: formulaVersionId },
    data: {
      accuracy7d: stats7d?.overallAccuracy ?? null,
      accuracy30d: stats30d?.overallAccuracy ?? null,
      tier1Rate: stats.tier1?.accuracy ?? null,
    },
  });

  // Save snapshot
  const snapshot = await prisma.accuracySnapshot.create({
    data: {
      versionId: formulaVersionId,
      tier1Rate: stats.tier1?.accuracy ?? 0,
      tier2Rate: stats.tier2?.accuracy ?? 0,
      tier3Rate: stats.tier3?.accuracy ?? 0,
      overallRate: stats.overallAccuracy ?? 0,
      totalSampled: stats.total,
      byBetType: stats.byOutcome,
    },
  });

  // Check for drift
  const drift = await detectDrift(formulaVersionId);

  if (drift.driftDetected) {
    logger.warn({
      formulaVersionId,
      drift,
    }, '⚠️ FORMULA DRIFT DETECTED — accuracy declining');

    // Emit to WebSocket if available
    if (global._io) {
      global._io.to('formula:updates').emit('formula:drift_alert', {
        formulaVersionId,
        drift,
        snapshot,
      });
    }
  }

  logger.info({
    overall7d: stats7d?.overallAccuracy,
    overall30d: stats30d?.overallAccuracy,
    tier1Rate: stats.tier1?.accuracy,
    driftDetected: drift.driftDetected,
  }, '✅ Snapshot saved');

  return { snapshot, drift, stats7d, stats30d };
}

// ─── FULL SYSTEM ACCURACY REPORT ─────────────────────────────────────────────

async function generateSystemReport() {
  const versions = await prisma.formulaVersion.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true, version: true, isActive: true,
      totalPredictions: true, correctPredictions: true,
      accuracy7d: true, accuracy30d: true, tier1Rate: true,
      createdAt: true, changelog: true,
    },
  });

  const patches = await prisma.formulaPatch.groupBy({
    by: ['failedLayer'],
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
  });

  const activeVersion = versions.find(v => v.isActive);
  const drift = activeVersion ? await detectDrift(activeVersion.id) : null;

  const totalPredictions = await prisma.prediction.count({ where: { isVerified: true } });
  const totalCorrect = await prisma.prediction.count({ where: { isVerified: true, wasCorrect: true } });

  return {
    systemAccuracy: totalPredictions > 0 ? Math.round((totalCorrect / totalPredictions) * 100) : null,
    totalVerified: totalPredictions,
    formulaVersions: versions.length,
    totalPatches: patches.reduce((s, p) => s + p._count.id, 0),
    patchesByLayer: Object.fromEntries(patches.map(p => [p.failedLayer, p._count.id])),
    activeFormula: activeVersion ? {
      version: activeVersion.version,
      accuracy7d: activeVersion.accuracy7d,
      accuracy30d: activeVersion.accuracy30d,
      tier1Rate: activeVersion.tier1Rate,
      drift,
    } : null,
    versionHistory: versions.map(v => ({
      version: v.version,
      isActive: v.isActive,
      totalPredictions: v.totalPredictions,
      accuracy: v.totalPredictions > 0 ? Math.round((v.correctPredictions / v.totalPredictions) * 100) : null,
      tier1Rate: v.tier1Rate,
      createdAt: v.createdAt,
    })),
  };
}

module.exports = { computeRollingAccuracy, buildAndSaveSnapshot, generateSystemReport, detectDrift };
