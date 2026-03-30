// server/data-engine/scraper.js
// Lightweight result auto-fetcher — scrapes public football score sources
// Used to auto-verify predictions without manual score entry

'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { PrismaClient } = require('@prisma/client');
const logger = require('../config/logger');

const prisma = new PrismaClient();

// ─── TEAM NAME NORMALISER ─────────────────────────────────────────────────────
// Fuzzy maps common name variants to canonical form

const TEAM_ALIASES = {
  'man city': 'manchester city',
  'man utd': 'manchester united',
  'man united': 'manchester united',
  'spurs': 'tottenham hotspur',
  'tottenham': 'tottenham hotspur',
  'arsenal fc': 'arsenal',
  'chelsea fc': 'chelsea',
  'inter': 'inter milan',
  'atletico': 'atletico madrid',
  'barca': 'barcelona',
  'real': 'real madrid',
  'psg': 'paris saint-germain',
  'wolves': 'wolverhampton wanderers',
  'west brom': 'west bromwich albion',
  'newcastle': 'newcastle united',
  'leeds': 'leeds united',
  'brighton': 'brighton & hove albion',
  'norwich': 'norwich city',
  'boro': 'middlesbrough',
  'stockport': 'stockport county',
  'wimbledon': 'afc wimbledon',
  'port vale fc': 'port vale',
  'wycombe': 'wycombe wanderers',
};

function normaliseTeamName(name) {
  const lower = name.toLowerCase().trim();
  return TEAM_ALIASES[lower] || lower;
}

function teamsMatch(a, b) {
  const na = normaliseTeamName(a);
  const nb = normaliseTeamName(b);
  return na === nb || na.includes(nb) || nb.includes(na);
}

// ─── SCORE SOURCES ────────────────────────────────────────────────────────────

// Source 1: SofaScore (public API — no auth required for basic results)
async function fetchFromSofaScore(homeTeam, awayTeam, date) {
  try {
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const url = `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FootballOracle/1.0)',
        'Accept': 'application/json',
      },
      timeout: 8000,
    });

    const events = response.data?.events || [];

    for (const event of events) {
      const home = event.homeTeam?.name || '';
      const away = event.awayTeam?.name || '';

      if (teamsMatch(home, homeTeam) && teamsMatch(away, awayTeam)) {
        if (event.status?.type === 'finished') {
          return {
            homeScore: event.homeScore?.current ?? null,
            awayScore: event.awayScore?.current ?? null,
            status: 'finished',
            source: 'sofascore',
          };
        }
        return { status: event.status?.type || 'unknown', source: 'sofascore' };
      }
    }
    return null;
  } catch (err) {
    logger.debug({ err: err.message }, 'SofaScore fetch failed');
    return null;
  }
}

// Source 2: FlashScore (public HTML scrape)
async function fetchFromFlashScore(homeTeam, awayTeam) {
  try {
    const query = encodeURIComponent(`${homeTeam} ${awayTeam}`);
    const url = `https://www.flashscore.com/search/?q=${query}`;
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      timeout: 8000,
    });

    const $ = cheerio.load(response.data);
    // Parse FlashScore result elements
    const results = [];
    $('.event__match').each((i, el) => {
      const homeEl = $(el).find('.event__homeParticipant').text().trim();
      const awayEl = $(el).find('.event__awayParticipant').text().trim();
      const homeScore = parseInt($(el).find('.event__score--home').text().trim());
      const awayScore = parseInt($(el).find('.event__score--away').text().trim());

      if (teamsMatch(homeEl, homeTeam) && teamsMatch(awayEl, awayTeam)) {
        if (!isNaN(homeScore) && !isNaN(awayScore)) {
          results.push({ homeScore, awayScore, status: 'finished', source: 'flashscore' });
        }
      }
    });

    return results[0] || null;
  } catch (err) {
    logger.debug({ err: err.message }, 'FlashScore fetch failed');
    return null;
  }
}

// ─── MAIN AUTO-FETCH FUNCTION ─────────────────────────────────────────────────

/**
 * Try to auto-fetch the result for a match
 * Returns null if match not finished or not found
 */
async function fetchMatchResult(homeTeam, awayTeam, scheduledAt) {
  const date = scheduledAt ? new Date(scheduledAt) : new Date();

  // Try sources in priority order
  const sources = [
    () => fetchFromSofaScore(homeTeam, awayTeam, date),
    () => fetchFromFlashScore(homeTeam, awayTeam),
  ];

  for (const fetchFn of sources) {
    const result = await fetchFn();
    if (result && result.status === 'finished' && result.homeScore !== null) {
      logger.info({
        match: `${homeTeam} vs ${awayTeam}`,
        score: `${result.homeScore}-${result.awayScore}`,
        source: result.source,
      }, '✅ Auto-fetched result');
      return result;
    }
  }

  logger.debug({ homeTeam, awayTeam }, 'Result not yet available from any source');
  return null;
}

// ─── BATCH AUTO-VERIFIER ─────────────────────────────────────────────────────

/**
 * Scans all unverified predictions where scheduled time has passed
 * Tries to auto-fetch results and trigger verification
 */
async function runAutoVerification() {
  const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago (game + buffer)

  const unverifiedMatches = await prisma.match.findMany({
    where: {
      result: null, // No result yet
      prediction: { isNot: null }, // Has a prediction
      OR: [
        { scheduledAt: { lte: cutoff } },
        { scheduledAt: null, createdAt: { lte: cutoff } },
      ],
    },
    include: {
      prediction: { select: { id: true } },
    },
    take: 50,
    orderBy: { scheduledAt: 'asc' },
  });

  if (unverifiedMatches.length === 0) {
    logger.debug('No unverified matches pending auto-fetch');
    return { checked: 0, verified: 0 };
  }

  logger.info({ count: unverifiedMatches.length }, '🔄 Running auto-verification scan');

  let verified = 0;

  for (const match of unverifiedMatches) {
    try {
      const result = await fetchMatchResult(match.homeTeam, match.awayTeam, match.scheduledAt);

      if (result) {
        // Queue for verification (imported dynamically to avoid circular deps)
        const { verificationQueue } = require('./index');
        await verificationQueue.add('verify-result', {
          matchId: match.id,
          homeScore: result.homeScore,
          awayScore: result.awayScore,
          source: 'WEB_SCRAPE',
        });
        verified++;
        logger.info({ matchId: match.id, result }, 'Queued auto-verification');
      }

      // Polite delay between requests
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      logger.error({ err: err.message, matchId: match.id }, 'Auto-verification error');
    }
  }

  logger.info({ checked: unverifiedMatches.length, verified }, '✅ Auto-verification scan complete');
  return { checked: unverifiedMatches.length, verified };
}

module.exports = { fetchMatchResult, runAutoVerification, normaliseTeamName };
