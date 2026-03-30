# ⚽ Football Oracle — API Reference

> Auto-generated from `lib/api-router.js` — do not edit manually.

**App Base URL:** `https://yourdomain.com`  
**Data Engine URL:** `http://localhost:3001`

---

## Table of Contents

- [health](#health)
- [users](#users)
- [slips](#slips)
- [slipDetail](#slipdetail)
- [upload](#upload)
- [predict](#predict)
- [results](#results)
- [formula](#formula)
- [admin](#admin)
- [webhookStripe](#webhookstripe)
- [engineHealth](#enginehealth)
- [engineQueuePredict](#enginequeuepredict)
- [engineQueueVerify](#enginequeueverify)
- [engineJobStatus](#enginejobstatus)
- [engineAdminSnapshot](#engineadminsnapshot)
- [WebSocket Events](#websocket-events)
- [Enums](#enums)

---

## `health`

### GET `https://yourdomain.com/api/health`

🔓 Public  

**Description:** Service health check — DB + formula version

**Response:**
```json
{
  "status": "healthy",
  "formula": "string",
  "db": "connected"
}
```

---

## `users`

### GET `https://yourdomain.com/api/users`

🔐 Authenticated  

**Description:** Current user profile, plan, daily limits, and stats

**Query Parameters:**
  - `stats`: `boolean`

**Rate Limit:** 60 per 1m

**Response:**
```json
{
  "user": "User",
  "limits": "PlanLimits",
  "stats": "UserStats"
}
```

---

### PATCH `https://yourdomain.com/api/users`

🔐 Authenticated  

**Description:** Update user name

**Request Body:**
  - `name`: string

**Rate Limit:** 10 per 1m

---

## `slips`

### GET `https://yourdomain.com/api/slips`

🔐 Authenticated  

**Description:** List all bet slips (paginated)

**Query Parameters:**
  - `page`: `number`
  - `limit`: `number`
  - `status`: `SlipStatus`

**Rate Limit:** 60 per 1m

**Response:**
```json
{
  "slips": "BetSlip[]",
  "pagination": "Pagination"
}
```

---

### POST `https://yourdomain.com/api/slips`

🔐 Authenticated  

**Description:** Create a bet slip from text, image (base64), or manual match array

**Request Variants:**
- **text**: `source: "TEXT"`
  - `rawInput`: `string`
  - `autoPredict`: `boolean?`
- **image**: `source: "IMAGE"`
  - `imageBase64`: `string`
  - `mimeType`: `string`
  - `autoPredict`: `boolean?`
- **manual**: `source: "MANUAL"`
  - `matches`: `MatchInput[]`
  - `autoPredict`: `boolean?`

**Rate Limits by Plan:**
- FREE: 3 per 24h
- PRO: 25 per 24h
- ELITE: 200 per 24h

**Response:**
```json
{
  "slipId": "string",
  "matchesExtracted": "number",
  "status": "PROCESSING"
}
```

---

## `slipDetail`

### GET `https://yourdomain.com/api/slips/:slipId`

🔐 Authenticated  

**Description:** Full slip detail — all matches, predictions, results, summary

**Response:**
```json
{
  "slip": "BetSlipDetail",
  "summary": "SlipSummary"
}
```

---

### DELETE `https://yourdomain.com/api/slips/:slipId`

🔐 Authenticated  

**Description:** Delete slip and cascade-delete all predictions/results

---

## `upload`

### POST `https://yourdomain.com/api/upload`

🔐 Authenticated  

**Description:** Upload bet slip image — Claude Vision OCR extracts matches

**Request Body:**
  - `image`: File (JPEG/PNG/WebP, max 5MB)

**Rate Limits by Plan:**
- FREE: 2 per 24h
- PRO: 20 per 24h
- ELITE: 100 per 24h

**Response:**
```json
{
  "matches": "MatchInput[]",
  "imageBase64": "string",
  "mimeType": "string"
}
```

---

## `predict`

### POST `https://yourdomain.com/api/predict`

🔐 Authenticated  

**Description:** Run 6-layer multi-AI prediction on a slip or single match

**Request Variants:**
- **slip**: `source: "slip"`
  - `slipId`: `cuid`
- **match**: `source: "match"`
  - `matchId`: `cuid`

**Rate Limits by Plan:**
- FREE: 5 per 24h
- PRO: 50 per 24h
- ELITE: 500 per 24h

**Response:**
```json
{
  "slipId": "string",
  "predictions": "PredictionResponse[]",
  "summary": {
    "total": "number",
    "tier1": "number",
    "avgConfidence": "number",
    "formulaVersion": "string"
  }
}
```

---

### GET `https://yourdomain.com/api/predict`

🔐 Authenticated  

**Description:** Retrieve prediction results for a slip or match

**Query Parameters:**
  - `slipId`: `cuid?`
  - `matchId`: `cuid?`

---

## `results`

### POST `https://yourdomain.com/api/results`

🔐 Authenticated  

**Description:** Submit match result — auto-triggers self-healing if prediction failed

**Request Variants:**
- **single**: `source: "single"`
  - `matchId`: `cuid`
  - `homeScore`: `number`
  - `awayScore`: `number`
  - `source`: `ResultSource?`
- **batch**: `source: "batch"`
  - `results`: `ResultInput[]`

**Side Effects:**
- Marks prediction as verified (wasCorrect)
- Triggers FormulaManager.applyPatch() if prediction was wrong
- Creates new FormulaVersion with incremented patch semver
- Emits formula:patched WebSocket event if self-healed
- Updates formula version accuracy stats

**Response:**
```json
{
  "verified": "boolean",
  "wasCorrect": "boolean",
  "selfHealed": "boolean",
  "failedLayer": "FailedLayer?",
  "newFormulaVersion": "string?",
  "patchApplied": "string?"
}
```

---

### GET `https://yourdomain.com/api/results`

🔐 Authenticated  

**Description:** Verified results history with accuracy stats

**Query Parameters:**
  - `page`: `number`
  - `limit`: `number`

**Response:**
```json
{
  "predictions": "VerifiedPrediction[]",
  "stats": "AccuracyStats",
  "pagination": "Pagination"
}
```

---

## `formula`

### GET `https://yourdomain.com/api/formula`

🔐 Authenticated  

**Description:** Formula version info — active config, history, patches, accuracy

**Query Parameters:**
  - `view`: `active|history|patches|accuracy`
  - `page`: `number?`
  - `layer`: `FailedLayer?`

---

### POST `https://yourdomain.com/api/formula`

🔐 Auth + Plan: `ELITE`  

**Description:** Admin: seed base formula or rollback to a version

**Request Body:**
  - `action`: seed|rollback
  - `targetVersionId`: string?

---

## `admin`

### GET `https://yourdomain.com/api/admin`

🔐 Auth + Plan: `ELITE`  

**Description:** Admin-only system report, patch history, version management, usage analytics

**Query Parameters:**
  - `view`: `report|patches|versions|usage`
  - `page`: `number?`
  - `layer`: `FailedLayer?`

---

### POST `https://yourdomain.com/api/admin`

🔐 Auth + Plan: `ELITE`  

**Description:** Admin actions: rollback, snapshot, scraper, set_plan, seed_formula

---

## `webhookStripe`

### POST `https://yourdomain.com/api/webhooks/stripe`

🔓 Public  

**Description:** Stripe webhook — handles subscription lifecycle, plan upgrades/downgrades

**Stripe Events Handled:**
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `checkout.session.completed`
- `invoice.payment_failed`

---

## `engineHealth`

### GET `http://localhost:3001/health`

🔓 Public  

**Description:** Data engine health — formula, queue stats, uptime

---

## `engineQueuePredict`

### POST `http://localhost:3001/queue/predict`

🔓 Public  

**Description:** Queue a Bull prediction job

**Request Body:**
  - `matchId`: string
  - `userId`: string
  - `matchData`: MatchInput
  - `slipId`: string?

---

## `engineQueueVerify`

### POST `http://localhost:3001/queue/verify`

🔓 Public  

**Description:** Queue a Bull verification job

**Request Body:**
  - `matchId`: string
  - `homeScore`: number
  - `awayScore`: number
  - `source`: string?

---

## `engineJobStatus`

### GET `http://localhost:3001/queue/status/:jobId`

🔓 Public  

**Description:** Get Bull job state and result

**Query Parameters:**
  - `queue`: `predictions|verifications`

---

## `engineAdminSnapshot`

### POST `http://localhost:3001/admin/snapshot`

🔓 Public  

**Description:** Trigger manual accuracy snapshot

---

## WebSocket Events

Connect to: `ws://localhost:3001`

### Client → Server

#### `subscribe:slip`
**Payload:** slipId: string  
**Description:** Subscribe to prediction updates for a slip

#### `subscribe:formula`
**Payload:** none  
**Description:** Subscribe to formula patch/drift events

### Server → Client

#### `prediction:complete`
**Payload:** `{ matchId, prediction: PredictionResponse }`  
**Description:** Fired when a prediction job completes

#### `prediction:error`
**Payload:** `{ matchId, error: string }`  
**Description:** Fired when a prediction job fails permanently

#### `formula:patched`
**Payload:** `{ matchId, failedLayer, newVersion, patchDescription }`  
**Description:** Fired after self-healing patch is applied

#### `formula:drift_alert`
**Payload:** `{ formulaVersionId, drift, snapshot }`  
**Description:** Fired when formula accuracy is declining

#### `formula:rollback`
**Payload:** `{ version: string }`  
**Description:** Fired after admin rollback

---

## Enums

### Enum `SlipStatus`

- `PENDING`
- `PROCESSING`
- `PREDICTED`
- `VERIFIED`
- `FAILED`

### Enum `SlipSource`

- `TEXT`
- `IMAGE`
- `OCR_IMAGE`
- `MANUAL`

### Enum `ConfidenceTier`

- `TIER1`
- `TIER2`
- `TIER3`

### Enum `Plan`

- `FREE`
- `PRO`
- `ELITE`

### Enum `FailedLayer`

- `L1_FORM`
- `L2_SQUAD`
- `L3_TACTICAL`
- `L4_PSYCHOLOGY`
- `L5_ENVIRONMENT`
- `L6_SIMULATION`

### Enum `FailureType`

- `WRONG_OUTCOME`
- `WRONG_GOALS`
- `WRONG_SCORE`

### Enum `ResultSource`

- `MANUAL`
- `API`
- `WEB_SCRAPE`

### Enum `BetType`

- `HOME`
- `AWAY`
- `DRAW`
- `OVER_0.5`
- `OVER_1.5`
- `OVER_2.5`
- `OVER_3.5`
- `UNDER_0.5`
- `UNDER_1.5`
- `UNDER_2.5`
- `UNDER_3.5`
- `BTTS_YES`
- `BTTS_NO`
- `DNB_HOME`
- `DNB_AWAY`
- `DC_HOME_DRAW`
- `DC_AWAY_DRAW`
- `DC_HOME_AWAY`

