# ⚽ Football Oracle — SaaS Backend

> Production-grade football prediction SaaS with multi-AI consensus engine and self-healing formula

---

## Architecture

```
football-oracle/
├── app/
│   └── api/
│       ├── slips/route.js       ← Bet slip ingestion (text, image, manual)
│       ├── predict/route.js     ← Prediction trigger
│       ├── results/route.js     ← Result submission + formula self-healing
│       ├── formula/route.js     ← Formula management & accuracy tracking
│       ├── upload/route.js      ← Image OCR endpoint
│       └── health/route.js      ← Health check
│
├── server/
│   ├── engine/
│   │   ├── formula.js           ← Versioned formula config + patch manager
│   │   ├── predictor.js         ← Main prediction orchestrator
│   │   └── verifier.js          ← Self-healing result verifier
│   ├── ai/
│   │   └── orchestrator.js      ← Claude (primary) + GPT-4 (validator) + debate
│   ├── data-engine/
│   │   └── index.js             ← Express server: WebSockets, Bull queues, cron
│   └── config/
│       └── logger.js            ← Pino structured logging
│
└── prisma/
    ├── schema.prisma            ← Full DB schema
    └── seed.js                  ← Seeds base formula to DB
```

---

## How It Works

### 1. Bet Slip Ingestion
- **Text input** → Claude parses free-text into structured matches
- **Image upload** → Claude vision OCR extracts bet selections
- **Manual JSON** → Direct structured input

### 2. Prediction Engine (6-Layer Formula)
```
L1 Form Engine       (22%) → xG, momentum, last 5 results
L2 Squad Intelligence (20%) → Injuries, key player coefficients
L3 Tactical Matrix   (16%) → Formation, pressing, set pieces
L4 Psychology        (14%) → H2H dominance, motivation, streaks
L5 Environment       (10%) → Weather, travel, altitude, schedule
L6 Simulation        (18%) → 3× weighted sims → final probability
```

### 3. Multi-AI Consensus Protocol
```
Claude (Primary, 60%) ──┐
                         ├── Conflict? → Debate (2 rounds) → Claude wins ties
GPT-4 (Validator, 40%) ─┘
```
Confidence gap >15% or outcome mismatch → triggers debate protocol

### 4. Self-Healing Formula
When a prediction fails:
1. Identifies which layer was responsible (heuristic + AI analysis)
2. AI runs root-cause forensics on the specific failure
3. Generates ONLY a modifier addition to the failing layer
4. Creates a new patch version — never modifies existing versions
5. New formula version activates immediately

**Rule: Only the failing layer is modified. Nothing else changes.**

---

## API Reference

### POST /api/slips
Create a bet slip from text, image, or manual input.

```json
// Text input
{ "source": "TEXT", "rawInput": "Stockport vs Wimbledon Home, Senegal vs Peru Home" }

// Image input (base64)
{ "source": "IMAGE", "imageBase64": "...", "mimeType": "image/jpeg" }

// Manual input
{
  "source": "MANUAL",
  "matches": [
    { "homeTeam": "Arsenal", "awayTeam": "Chelsea", "betType": "HOME", "competition": "Premier League" }
  ]
}
```

### POST /api/predict
Trigger prediction for a slip or match.
```json
{ "slipId": "clxxx..." }
// or
{ "matchId": "clxxx..." }
```

### POST /api/results
Submit match result — triggers self-healing if prediction was wrong.
```json
// Single
{ "matchId": "clxxx...", "homeScore": 2, "awayScore": 1, "source": "MANUAL" }

// Batch
{ "results": [{ "matchId": "...", "homeScore": 1, "awayScore": 0 }, ...] }
```

### GET /api/formula?view=active|history|patches|accuracy
Formula management and accuracy tracking.

### POST /api/upload
Upload image of bet slip for OCR extraction.
- Form data: `image` field (JPEG/PNG/WebP, max 5MB)

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in DATABASE_URL, ANTHROPIC_API_KEY, CLERK keys

# 3. Database setup
npx prisma migrate dev --name init
npx prisma generate
npm run db:seed

# 4. Start (Next.js API + Data Engine)
npm run dev
```

### Services Required
- **PostgreSQL** — Primary database
- **Redis** — Job queues (Bull) + caching
- **Anthropic API** — Claude (required)
- **OpenAI API** — GPT-4 validator (optional — degrades gracefully)
- **Clerk** — Authentication

---

## Formula Versioning

Formula versions follow semver:
- **Major** (x.0.0): Manual architectural changes to layer weights
- **Minor** (x.y.0): Significant formula restructuring
- **Patch** (x.y.z): **Auto-applied by self-healing system** — one patch per prediction failure

Each patch:
- ✅ Adds a modifier to ONLY the failing layer's `patches[]` array
- ✅ Creates a new `FormulaVersion` record
- ✅ Activates immediately
- ❌ Never deletes or modifies other layers
- ❌ Never changes layer weights globally

---

## Confidence Tiers

| Tier | Range | Meaning |
|------|-------|---------|
| TIER 1 | 80-100% | High Confidence — Strong analytical support |
| TIER 2 | 65-79% | Moderate Confidence — Back with caution |
| TIER 3 | <65% | Low Confidence — Flag to user |

---

## Real-Time Events (WebSocket)

Connect to data engine at `ws://localhost:3001`:

```js
socket.emit('subscribe:slip', slipId)
socket.on('prediction:complete', ({ matchId, prediction }) => {})
socket.on('prediction:error', ({ matchId, error }) => {})

socket.emit('subscribe:formula')
socket.on('formula:patched', ({ failedLayer, newVersion, patchDescription }) => {})
```
