#!/usr/bin/env node
// scripts/generate-api-docs.js
// Auto-generates API reference docs from the central route registry
// Run: node scripts/generate-api-docs.js > docs/API.md

'use strict';

const { ROUTES, WS_EVENTS, ENUMS } = require('../lib/api-router');

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://yourdomain.com';
const ENGINE_URL = process.env.DATA_ENGINE_URL    || 'http://localhost:3001';

function typeLink(t) {
  if (!t) return '—';
  const ENUMS_LIST = Object.keys(ENUMS);
  return ENUMS_LIST.includes(t)
    ? `[\`${t}\`](#enum-${t.toLowerCase()})`
    : `\`${t}\``;
}

function renderBody(body) {
  if (!body) return '';
  return Object.entries(body).map(([k, v]) => `  - \`${k}\`: ${v}`).join('\n');
}

function renderQuery(query) {
  if (!query) return '';
  return Object.entries(query).map(([k, v]) => `  - \`${k}\`: \`${v}\``).join('\n');
}

function authBadge(auth, roles) {
  if (!auth) return '🔓 Public';
  if (roles) return `🔐 Auth + Plan: \`${roles.join(' | ')}\``;
  return '🔐 Authenticated';
}

let md = `# ⚽ Football Oracle — API Reference

> Auto-generated from \`lib/api-router.js\` — do not edit manually.

**App Base URL:** \`${BASE_URL}\`  
**Data Engine URL:** \`${ENGINE_URL}\`

---

## Table of Contents

`;

// TOC
const sections = Object.keys(ROUTES);
sections.forEach(name => {
  md += `- [${name}](#${name.toLowerCase()})\n`;
});
md += `- [WebSocket Events](#websocket-events)\n`;
md += `- [Enums](#enums)\n\n---\n\n`;

// Routes
for (const [name, methods] of Object.entries(ROUTES)) {
  md += `## \`${name}\`\n\n`;

  for (const [method, cfg] of Object.entries(methods)) {
    const base = cfg.base === 'engine' ? ENGINE_URL : BASE_URL;
    md += `### ${method} \`${base}${cfg.path}\`\n\n`;
    md += `${authBadge(cfg.auth, cfg.roles)}  \n\n`;
    md += `**Description:** ${cfg.description}\n\n`;

    if (cfg.query) {
      md += `**Query Parameters:**\n${renderQuery(cfg.query)}\n\n`;
    }

    if (cfg.body) {
      md += `**Request Body:**\n${renderBody(cfg.body)}\n\n`;
    }

    if (cfg.variants) {
      md += `**Request Variants:**\n`;
      for (const [vname, v] of Object.entries(cfg.variants)) {
        md += `- **${vname}**: \`source: "${v.source || vname}"\`\n`;
        if (v.body) {
          md += Object.entries(v.body).map(([k, t]) => `  - \`${k}\`: \`${t}\``).join('\n') + '\n';
        }
      }
      md += '\n';
    }

    if (cfg.sideEffects) {
      md += `**Side Effects:**\n`;
      cfg.sideEffects.forEach(e => { md += `- ${e}\n`; });
      md += '\n';
    }

    if (cfg.events) {
      md += `**Stripe Events Handled:**\n`;
      cfg.events.forEach(e => { md += `- \`${e}\`\n`; });
      md += '\n';
    }

    if (cfg.rateLimit && typeof cfg.rateLimit === 'object' && cfg.rateLimit.FREE) {
      md += `**Rate Limits by Plan:**\n`;
      for (const [plan, limit] of Object.entries(cfg.rateLimit)) {
        md += `- ${plan}: ${limit.max} per ${limit.window}\n`;
      }
      md += '\n';
    } else if (cfg.rateLimit) {
      md += `**Rate Limit:** ${cfg.rateLimit.max} per ${cfg.rateLimit.window}\n\n`;
    }

    if (cfg.response) {
      md += `**Response:**\n\`\`\`json\n${JSON.stringify(cfg.response, null, 2)}\n\`\`\`\n\n`;
    }

    md += `---\n\n`;
  }
}

// WebSocket Events
md += `## WebSocket Events\n\n`;
md += `Connect to: \`ws://${ENGINE_URL.replace('http://', '').replace('https://', '')}\`\n\n`;

md += `### Client → Server\n\n`;
for (const [event, cfg] of Object.entries(WS_EVENTS.subscribe)) {
  md += `#### \`${event}\`\n`;
  md += `**Payload:** ${cfg.payload || 'none'}  \n`;
  md += `**Description:** ${cfg.description}\n\n`;
}

md += `### Server → Client\n\n`;
for (const [event, cfg] of Object.entries(WS_EVENTS.emit)) {
  md += `#### \`${event}\`\n`;
  md += `**Payload:** \`${cfg.payload}\`  \n`;
  md += `**Description:** ${cfg.description}\n\n`;
}

// Enums
md += `---\n\n## Enums\n\n`;
for (const [name, values] of Object.entries(ENUMS)) {
  md += `### Enum \`${name}\`\n\n`;
  md += values.map(v => `- \`${v}\``).join('\n') + '\n\n';
}

// Output
process.stdout.write(md);
