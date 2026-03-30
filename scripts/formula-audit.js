#!/usr/bin/env node
// scripts/formula-audit.js
// CLI tool to audit formula versions, patches, and accuracy
// Usage: node scripts/formula-audit.js [--version v3.1.0] [--layer L1_FORM]

'use strict';

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { generateSystemReport, computeRollingAccuracy } = require('../server/engine/accuracy-tracker');

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i += 2) {
  flags[args[i].replace('--', '')] = args[i + 1];
}

function bar(value, max = 100, width = 30) {
  const filled = Math.round((value / max) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function tier(pct) {
  if (pct >= 80) return '\x1b[32m✅ TIER1\x1b[0m';
  if (pct >= 65) return '\x1b[33m⚠️ TIER2\x1b[0m';
  return '\x1b[31m❌ TIER3\x1b[0m';
}

async function main() {
  console.log('\n\x1b[1m⚽ FOOTBALL ORACLE — FORMULA AUDIT REPORT\x1b[0m');
  console.log('═'.repeat(60));

  const report = await generateSystemReport();

  // ── System Overview ──────────────────────────────────────────────────────
  console.log('\n\x1b[1m📊 SYSTEM OVERVIEW\x1b[0m');
  console.log(`Total verified predictions : ${report.totalVerified}`);
  console.log(`System-wide accuracy       : ${report.systemAccuracy ?? 'N/A'}%`);
  console.log(`Formula versions           : ${report.formulaVersions}`);
  console.log(`Self-healing patches       : ${report.totalPatches}`);

  // ── Active Formula ───────────────────────────────────────────────────────
  if (report.activeFormula) {
    const af = report.activeFormula;
    console.log('\n\x1b[1m🔬 ACTIVE FORMULA\x1b[0m');
    console.log(`Version  : \x1b[32m${af.version}\x1b[0m`);
    console.log(`Acc 7d   : ${af.accuracy7d ? `${(af.accuracy7d * 100).toFixed(1)}% ${bar(af.accuracy7d * 100)}` : 'N/A'}`);
    console.log(`Acc 30d  : ${af.accuracy30d ? `${(af.accuracy30d * 100).toFixed(1)}% ${bar(af.accuracy30d * 100)}` : 'N/A'}`);
    console.log(`Tier1 %  : ${af.tier1Rate ? `${(af.tier1Rate * 100).toFixed(1)}% ${bar(af.tier1Rate * 100)}` : 'N/A'}`);

    if (af.drift) {
      const d = af.drift;
      const driftColor = d.driftDetected ? '\x1b[31m' : '\x1b[32m';
      console.log(`Drift    : ${driftColor}${d.trend} — ${d.recommendation}\x1b[0m`);
    }
  }

  // ── Patches by Layer ─────────────────────────────────────────────────────
  console.log('\n\x1b[1m🔧 SELF-HEALING PATCHES BY LAYER\x1b[0m');
  const layers = ['L1_FORM', 'L2_SQUAD', 'L3_TACTICAL', 'L4_PSYCHOLOGY', 'L5_ENVIRONMENT', 'L6_SIMULATION'];
  const maxPatches = Math.max(...Object.values(report.patchesByLayer || {}), 1);

  for (const layer of layers) {
    const count = report.patchesByLayer?.[layer] || 0;
    const barStr = bar(count, maxPatches, 20);
    console.log(`  ${layer.padEnd(20)} ${barStr} ${count}`);
  }

  // ── Version History ──────────────────────────────────────────────────────
  console.log('\n\x1b[1m📜 VERSION HISTORY\x1b[0m');
  for (const v of (report.versionHistory || []).slice(0, 8)) {
    const active = v.isActive ? ' \x1b[32m← ACTIVE\x1b[0m' : '';
    const acc = v.accuracy !== null ? `${v.accuracy}%` : 'No data';
    const t1 = v.tier1Rate ? `T1: ${(v.tier1Rate * 100).toFixed(0)}%` : '';
    console.log(`  v${v.version.padEnd(8)} ${acc.padEnd(8)} ${t1.padEnd(10)} preds:${v.totalPredictions}${active}`);
  }

  // ── Recent Patches ───────────────────────────────────────────────────────
  if (!flags.version && !flags.layer) {
    const recentPatches = await prisma.formulaPatch.findMany({
      orderBy: { appliedAt: 'desc' },
      take: 5,
      include: {
        fromVersion: { select: { version: true } },
        result: {
          include: { match: { select: { homeTeam: true, awayTeam: true, betType: true } } },
        },
      },
    });

    console.log('\n\x1b[1m📋 RECENT SELF-HEALING PATCHES\x1b[0m');
    for (const p of recentPatches) {
      console.log(`\n  v${p.fromVersion.version} → Layer: \x1b[33m${p.failedLayer}\x1b[0m`);
      if (p.result?.match) {
        console.log(`  Match    : ${p.result.match.homeTeam} vs ${p.result.match.awayTeam} [${p.result.match.betType}]`);
      }
      console.log(`  Failure  : ${p.failureType} (predicted: ${p.predictedValue}, actual: ${p.actualValue})`);
      console.log(`  Fix      : ${p.patchDescription}`);
      console.log(`  Applied  : ${new Date(p.appliedAt).toLocaleString()}`);
    }
  }

  // ── Layer-specific filter ────────────────────────────────────────────────
  if (flags.layer) {
    const layerPatches = await prisma.formulaPatch.findMany({
      where: { failedLayer: flags.layer },
      orderBy: { appliedAt: 'desc' },
      take: 10,
      include: {
        fromVersion: { select: { version: true } },
      },
    });

    console.log(`\n\x1b[1m🔎 PATCHES FOR LAYER: ${flags.layer}\x1b[0m`);
    console.log(`Total: ${layerPatches.length}`);
    for (const p of layerPatches) {
      console.log(`\n  [v${p.fromVersion.version}] ${new Date(p.appliedAt).toLocaleDateString()}`);
      console.log(`  ${p.patchDescription}`);
      console.log(`  Modifier: ${JSON.stringify(p.modifierAdded)}`);
    }
  }

  console.log('\n' + '═'.repeat(60));
  console.log('Audit complete.\n');
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
