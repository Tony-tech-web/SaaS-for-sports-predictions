// prisma/seed.js  [v2.0]
'use strict';
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Oracle database...\n');

  const { BASE_FORMULA, generateSystemPrompt } = require('../server/engine/formula');
  const { BASE_BASKETBALL_FORMULA }            = require('../server/engine/sports/basketball/formula');
  const { generateBasketballSystemPrompt }     = require('../server/engine/sports/basketball/prompt');

  for (const [sport, formula, promptFn] of [
    ['FOOTBALL',    BASE_FORMULA,            generateSystemPrompt],
    ['BASKETBALL',  BASE_BASKETBALL_FORMULA, generateBasketballSystemPrompt],
  ]) {
    const existing = await prisma.formulaVersion.findFirst({ where: { version: formula.version, sport } });
    if (existing) { console.log(`  ✓ ${sport} v${formula.version} already exists`); continue; }
    const [maj, min, pat] = formula.version.split('.').map(Number);
    await prisma.formulaVersion.create({
      data: {
        version: formula.version, sport, majorVersion: maj, minorVersion: min, patchVersion: pat,
        isActive: true, formulaJson: formula, systemPrompt: promptFn(formula),
        changelog: `Initial ${sport} formula — v${formula.version}`,
      },
    });
    console.log(`  ✅ ${sport} formula v${formula.version} seeded`);
  }

  console.log('\n✅ Seed complete');
}

main().catch(e => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
