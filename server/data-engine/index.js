// server/data-engine/index.js
// Standalone Express data engine for background tasks:
// - Scheduled formula accuracy snapshots
// - WebSocket real-time prediction updates
// - Result auto-fetching (web scraping)
// - Bull job queue for async predictions

'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server: SocketIO } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const Bull = require('bull');
const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');
const { formulaManager } = require('../engine/formula');
const { predictMatch } = require('../engine/predictor');
const { verifyAndPatch } = require('../engine/verifier');

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

// ─── SOCKET.IO SETUP ─────────────────────────────────────────────────────────

const io = new SocketIO(server, {
  cors: {
    origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});

// Real-time prediction events
io.on('connection', (socket) => {
  logger.info({ socketId: socket.id }, 'Client connected');

  socket.on('subscribe:slip', (slipId) => {
    socket.join(`slip:${slipId}`);
    logger.info({ slipId, socketId: socket.id }, 'Subscribed to slip updates');
  });

  socket.on('subscribe:formula', () => {
    socket.join('formula:updates');
  });

  socket.on('disconnect', () => {
    logger.info({ socketId: socket.id }, 'Client disconnected');
  });
});

// Expose io for use in other modules
global._io = io;

// ─── JOB QUEUES ──────────────────────────────────────────────────────────────

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const predictionQueue = new Bull('predictions', REDIS_URL, {
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

const verificationQueue = new Bull('verifications', REDIS_URL, {
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 10000 },
    removeOnComplete: 50,
  },
});

const accuracyQueue = new Bull('accuracy-snapshots', REDIS_URL);

// ─── PREDICTION JOB PROCESSOR ────────────────────────────────────────────────

predictionQueue.process('predict-match', 3, async (job) => {
  const { matchId, userId, matchData } = job.data;
  logger.info({ jobId: job.id, matchId }, '🔄 Processing prediction job');

  try {
    const result = await predictMatch(matchData, userId, matchId);

    // Emit to connected clients subscribed to this slip
    if (global._io && job.data.slipId) {
      global._io.to(`slip:${job.data.slipId}`).emit('prediction:complete', {
        matchId,
        prediction: result,
      });
    }

    logger.info({ jobId: job.id, matchId, outcome: result.predictedOutcome }, '✅ Prediction job complete');
    return result;
  } catch (err) {
    logger.error({ jobId: job.id, matchId, err: err.message }, '❌ Prediction job failed');
    throw err;
  }
});

predictionQueue.on('failed', (job, err) => {
  logger.error({ jobId: job.id, err: err.message }, 'Prediction queue job permanently failed');
  if (global._io && job.data.slipId) {
    global._io.to(`slip:${job.data.slipId}`).emit('prediction:error', {
      matchId: job.data.matchId,
      error: err.message,
    });
  }
});

// ─── VERIFICATION JOB PROCESSOR ──────────────────────────────────────────────

verificationQueue.process('verify-result', 2, async (job) => {
  const { matchId, homeScore, awayScore, source } = job.data;
  logger.info({ jobId: job.id, matchId }, '🔍 Processing verification job');

  const outcome = await verifyAndPatch(matchId, { homeScore, awayScore, source });

  if (!outcome.wasCorrect && outcome.selfHealed && global._io) {
    global._io.to('formula:updates').emit('formula:patched', {
      matchId,
      failedLayer: outcome.failedLayer,
      newVersion: outcome.newFormulaVersion,
      patchDescription: outcome.patchApplied,
    });
  }

  return outcome;
});

// ─── ACCURACY SNAPSHOT JOB ────────────────────────────────────────────────────

accuracyQueue.process('snapshot', async (job) => {
  logger.info('📸 Computing accuracy snapshot');

  const activeFormula = await formulaManager.getActiveFormula();

  // 7-day accuracy
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [preds7d, preds30d] = await Promise.all([
    prisma.prediction.findMany({
      where: { isVerified: true, updatedAt: { gte: since7d }, formulaVersionId: activeFormula.id },
      select: { wasCorrect: true, confidenceTier: true, predictedOutcome: true },
    }),
    prisma.prediction.findMany({
      where: { isVerified: true, updatedAt: { gte: since30d }, formulaVersionId: activeFormula.id },
      select: { wasCorrect: true, confidenceTier: true, predictedOutcome: true },
    }),
  ]);

  const calcAccuracy = (preds) => preds.length > 0
    ? Math.round((preds.filter(p => p.wasCorrect).length / preds.length) * 100) / 100
    : null;

  const accuracy7d = calcAccuracy(preds7d);
  const accuracy30d = calcAccuracy(preds30d);
  const tier1 = preds30d.filter(p => p.confidenceTier === 'TIER1');
  const tier1Rate = calcAccuracy(tier1);

  await prisma.formulaVersion.update({
    where: { id: activeFormula.id },
    data: { accuracy7d, accuracy30d, tier1Rate },
  });

  // Create snapshot record
  const byBetType = {};
  for (const p of preds30d) {
    const type = p.predictedOutcome.startsWith('OVER') ? 'OVER' : p.predictedOutcome.startsWith('UNDER') ? 'UNDER' : p.predictedOutcome;
    if (!byBetType[type]) byBetType[type] = { total: 0, correct: 0 };
    byBetType[type].total++;
    if (p.wasCorrect) byBetType[type].correct++;
  }

  await prisma.accuracySnapshot.create({
    data: {
      versionId: activeFormula.id,
      tier1Rate: preds30d.filter(p => p.confidenceTier === 'TIER1' && p.wasCorrect).length / Math.max(tier1.length, 1),
      tier2Rate: preds30d.filter(p => p.confidenceTier === 'TIER2' && p.wasCorrect).length / Math.max(preds30d.filter(p => p.confidenceTier === 'TIER2').length, 1),
      tier3Rate: preds30d.filter(p => p.confidenceTier === 'TIER3' && p.wasCorrect).length / Math.max(preds30d.filter(p => p.confidenceTier === 'TIER3').length, 1),
      overallRate: accuracy30d || 0,
      totalSampled: preds30d.length,
      byBetType,
    },
  });

  logger.info({ accuracy7d, accuracy30d, tier1Rate }, '✅ Accuracy snapshot saved');
});

// ─── CRON JOBS ────────────────────────────────────────────────────────────────

// Accuracy snapshot every 6 hours
cron.schedule('0 */6 * * *', () => {
  accuracyQueue.add('snapshot', {}, { priority: 10 });
  logger.info('🕐 Scheduled accuracy snapshot queued');
});

// Formula version health check every hour
cron.schedule('0 * * * *', async () => {
  try {
    const active = await formulaManager.getActiveFormula();
    if (!active || active.id === 'base') {
      logger.warn('⚠️ No formula in DB — seeding base formula');
      await formulaManager.seedBaseFormula();
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Formula health check failed');
  }
});

// ─── REST API ENDPOINTS ───────────────────────────────────────────────────────

app.use(helmet());
app.use(cors({ origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000' }));
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

// Health check
app.get('/health', async (req, res) => {
  const activeFormula = await formulaManager.getActiveFormula().catch(() => null);
  const queueStats = await Promise.all([
    predictionQueue.getJobCounts(),
    verificationQueue.getJobCounts(),
  ]);

  res.json({
    status: 'ok',
    engine: 'Football Oracle Data Engine v1.0',
    formula: activeFormula?.version || 'unknown',
    queues: {
      predictions: queueStats[0],
      verifications: queueStats[1],
    },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Queue a prediction job
app.post('/queue/predict', async (req, res) => {
  const { matchId, userId, matchData, slipId } = req.body;
  if (!matchId || !userId || !matchData) {
    return res.status(400).json({ error: 'matchId, userId, matchData required' });
  }

  const job = await predictionQueue.add('predict-match', { matchId, userId, matchData, slipId }, {
    priority: 1,
  });

  res.json({ jobId: job.id, queued: true });
});

// Queue a verification job
app.post('/queue/verify', async (req, res) => {
  const { matchId, homeScore, awayScore, source } = req.body;
  if (!matchId || homeScore === undefined || awayScore === undefined) {
    return res.status(400).json({ error: 'matchId, homeScore, awayScore required' });
  }

  const job = await verificationQueue.add('verify-result', { matchId, homeScore, awayScore, source: source || 'API' });
  res.json({ jobId: job.id, queued: true });
});

// Get job status
app.get('/queue/status/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const { queue = 'predictions' } = req.query;
  const q = queue === 'verifications' ? verificationQueue : predictionQueue;
  const job = await q.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const state = await job.getState();
  res.json({ jobId, state, progress: job.progress(), result: job.returnvalue });
});

// Force accuracy snapshot
app.post('/admin/snapshot', async (req, res) => {
  await accuracyQueue.add('snapshot', {});
  res.json({ queued: true });
});

// ─── STARTUP ─────────────────────────────────────────────────────────────────

const PORT = process.env.DATA_ENGINE_PORT || 3001;

server.listen(PORT, async () => {
  logger.info({ port: PORT }, '🚀 Football Oracle Data Engine started');

  // Seed formula on startup if needed
  try {
    await formulaManager.seedBaseFormula();
    logger.info('✅ Formula verified/seeded');
  } catch (err) {
    logger.warn({ err: err.message }, 'Formula seed failed — DB may not be connected yet');
  }
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await predictionQueue.close();
  await verificationQueue.close();
  await accuracyQueue.close();
  await prisma.$disconnect();
  server.close(() => process.exit(0));
});

module.exports = { predictionQueue, verificationQueue, app };
