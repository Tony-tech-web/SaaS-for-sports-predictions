// server/data-engine/cron.js
// All scheduled jobs for the data engine — imported by index.js

'use strict';

const cron = require('node-cron');
const Bull = require('bull');
const logger = require('../config/logger');
const { buildAndSaveSnapshot } = require('../engine/accuracy-tracker');
const { runAutoVerification } = require('./scraper');
const { formulaManager } = require('../engine/formula');

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

function registerCronJobs(queues) {
  const { accuracyQueue } = queues;

  // ── Formula health check — every 30 minutes ──────────────────────────────
  cron.schedule('*/30 * * * *', async () => {
    try {
      const active = await formulaManager.getActiveFormula();
      if (!active || active.id === 'base') {
        logger.warn('No DB formula found — re-seeding');
        await formulaManager.seedBaseFormula();
      }
      logger.debug({ version: active?.version }, '✅ Formula health OK');
    } catch (err) {
      logger.error({ err: err.message }, 'Formula health check failed');
    }
  });

  // ── Accuracy snapshot — every 6 hours ────────────────────────────────────
  cron.schedule('0 */6 * * *', async () => {
    logger.info('⏰ Scheduled accuracy snapshot triggered');
    try {
      const active = await formulaManager.getActiveFormula();
      const result = await buildAndSaveSnapshot(active.id);
      if (result?.drift?.driftDetected) {
        logger.warn({ drift: result.drift }, '🚨 Formula drift detected in scheduled snapshot');
      }
    } catch (err) {
      logger.error({ err: err.message }, 'Scheduled accuracy snapshot failed');
    }
  });

  // ── Auto result scraper — every 90 minutes ───────────────────────────────
  cron.schedule('*/90 * * * *', async () => {
    logger.info('🕷️ Running auto-verification scraper');
    try {
      const result = await runAutoVerification();
      logger.info(result, 'Auto-verification complete');
    } catch (err) {
      logger.error({ err: err.message }, 'Auto-verification scraper failed');
    }
  });

  // ── Daily stats reset log — midnight ─────────────────────────────────────
  cron.schedule('0 0 * * *', async () => {
    logger.info('🌙 Daily reset — logging system stats');
    try {
      const active = await formulaManager.getActiveFormula();
      logger.info({
        formulaVersion: active?.version,
        time: new Date().toISOString(),
      }, '📅 Daily system checkpoint');
    } catch (err) {
      logger.error({ err: err.message }, 'Daily checkpoint failed');
    }
  });

  logger.info('✅ All cron jobs registered');
}

module.exports = { registerCronJobs };
