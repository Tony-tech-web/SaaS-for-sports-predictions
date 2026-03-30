// lib/api-router.js  [v2.0 — multi-sport registry]
'use strict';

const ROUTES = {
  health: { GET: { path: '/api/health', auth: false, description: 'Service health — DB, formula versions (FOOTBALL + BASKETBALL)' } },
  users:  { GET: { path: '/api/users', auth: true, description: 'User profile, plan limits, per-sport stats', query: { stats: 'boolean', sport: 'FOOTBALL|BASKETBALL?' } },
            PATCH: { path: '/api/users', auth: true, description: 'Update name', body: { name: 'string' } } },
  slips: {
    GET: { path: '/api/slips', auth: true, description: 'List slips with optional sport filter', query: { page: 'number', limit: 'number', status: 'SlipStatus', sport: 'FOOTBALL|BASKETBALL?' } },
    POST: {
      path: '/api/slips', auth: true,
      rateLimit: { FREE: { window:'24h', max:3 }, PRO: { window:'24h', max:25 }, ELITE: { window:'24h', max:200 } },
      description: 'Create slip — auto-detects sport per match. Mix football + basketball in one slip.',
      variants: {
        text:       { source:'TEXT',   body: { rawInput:'string', autoPredict:'boolean?' } },
        image:      { source:'IMAGE',  body: { imageBase64:'string', mimeType:'string', autoPredict:'boolean?' } },
        manual:     { source:'MANUAL', body: { matches:'MatchInput[]', autoPredict:'boolean?' } },
        football:   { source:'MANUAL', note:'Set sport:"FOOTBALL" per match for explicit typing' },
        basketball: { source:'MANUAL', note:'Set sport:"BASKETBALL", betLine:number for NBA spreads/totals' },
      },
      response: { slipId:'string', matchesExtracted:'number', sports:'{ FOOTBALL:number, BASKETBALL:number }' },
    },
  },
  slipDetail: {
    GET:    { path:'/api/slips/:slipId', auth:true, description:'Full slip detail — sport breakdown, predictions per match' },
    DELETE: { path:'/api/slips/:slipId', auth:true, description:'Delete slip + cascade predictions' },
  },
  upload: { POST: { path:'/api/upload', auth:true, description:'Image OCR — extracts matches from bet slip photo', contentType:'multipart/form-data', body: { image:'File (JPEG/PNG/WebP, max 5MB)' }, response: { matches:'MatchInput[] (with auto-detected sport)', imageBase64:'string' } } },
  predict: {
    POST: { path:'/api/predict', auth:true, description:'Trigger 6-layer AI prediction. Routes to football or basketball formula automatically.', variants: { slip:{ body:{ slipId:'cuid' } }, match:{ body:{ matchId:'cuid' } } }, response: { predictions:'PredictionResponse[] (sport-aware)' } },
    GET:  { path:'/api/predict', auth:true, description:'Get predictions for slip or match', query: { slipId:'cuid?', matchId:'cuid?' } },
  },
  results: {
    POST: {
      path:'/api/results', auth:true, description:'Submit result — triggers sport-specific evaluation + self-healing if wrong',
      variants: {
        football:           { body:{ matchId:'cuid', homeScore:'number', awayScore:'number', source:'string?' } },
        basketball:         { body:{ matchId:'cuid', homeScore:'number', awayScore:'number', homeFirstHalf:'number?', awayFirstHalf:'number?', homeFirstQuarter:'number?', awayFirstQuarter:'number?', overtime:'boolean?', backToBackOccurred:'boolean?' } },
        batch:              { body:{ results:'ResultInput[]' } },
      },
      sideEffects: ['Evaluates via sport-specific logic (football xG / basketball spreads)', 'Triggers formula self-healing on failure (sport-isolated patches)', 'Emits formula:patched WS event with sport field'],
    },
    GET: { path:'/api/results', auth:true, description:'Verified results + accuracy stats split by sport', query: { page:'number', limit:'number', sport:'FOOTBALL|BASKETBALL?' } },
  },
  formula: {
    GET:  { path:'/api/formula', auth:true, description:'Formula info — separate active versions for FOOTBALL and BASKETBALL', query: { view:'active|history|patches|accuracy', sport:'FOOTBALL|BASKETBALL?', page:'number?', layer:'FailedLayer?' } },
    POST: { path:'/api/formula', auth:true, roles:['ELITE'], description:'Seed or rollback formula per sport', body:{ action:'seed|rollback', targetVersionId:'string?', sport:'FOOTBALL|BASKETBALL?' } },
  },
  admin: {
    GET:  { path:'/api/admin', auth:true, roles:['ELITE'], description:'System report with per-sport accuracy', query:{ view:'report|patches|versions|usage', sport:'FOOTBALL|BASKETBALL?', page:'number?', layer:'FailedLayer?' } },
    POST: { path:'/api/admin', auth:true, roles:['ELITE'], description:'Admin actions', actions:{ rollback:{targetVersionId:'string',sport:'string?'}, snapshot:null, scrape:null, set_plan:{userId:'string',plan:'FREE|PRO|ELITE'}, seed_formula:{sport:'FOOTBALL|BASKETBALL?'} } },
  },
  webhookStripe: { POST: { path:'/api/webhooks/stripe', auth:false, description:'Stripe subscription lifecycle', events:['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','checkout.session.completed','invoice.payment_failed'] } },

  // Data engine
  engineHealth:        { GET:  { path:'/health',              base:'engine', auth:false, description:'Engine health — both formula queues' } },
  engineQueuePredict:  { POST: { path:'/queue/predict',       base:'engine', auth:false, description:'Queue Bull prediction job', body:{ matchId:'string', userId:'string', matchData:'MatchInput (sport-aware)', slipId:'string?' } } },
  engineQueueVerify:   { POST: { path:'/queue/verify',        base:'engine', auth:false, description:'Queue Bull verification job', body:{ matchId:'string', homeScore:'number', awayScore:'number', source:'string?', overtime:'boolean?' } } },
  engineJobStatus:     { GET:  { path:'/queue/status/:jobId', base:'engine', auth:false, description:'Bull job state' } },
  engineSnapshot:      { POST: { path:'/admin/snapshot',      base:'engine', auth:false, description:'Manual accuracy snapshot' } },
};

const WS_EVENTS = {
  subscribe: {
    'subscribe:slip':    { payload:'slipId: string',  description:'Subscribe to prediction updates for a slip' },
    'subscribe:formula': { payload:null,              description:'Subscribe to formula patch/drift events (both sports)' },
  },
  emit: {
    'prediction:complete': { payload:'{ matchId, prediction: PredictionResponse (sport-aware) }', description:'Prediction job done' },
    'prediction:error':    { payload:'{ matchId, error }',                                        description:'Prediction job failed' },
    'formula:patched':     { payload:'{ matchId, sport, failedLayer, newVersion, patchDescription }', description:'Self-healing patch applied (includes sport field)' },
    'formula:drift_alert': { payload:'{ sport, formulaVersionId, drift, snapshot }',              description:'Formula accuracy declining' },
    'formula:rollback':    { payload:'{ sport, version }',                                        description:'Admin rollback executed' },
  },
};

const ENUMS = {
  Sport:          ['FOOTBALL', 'BASKETBALL'],
  SlipStatus:     ['PENDING', 'PROCESSING', 'PREDICTED', 'VERIFIED', 'FAILED'],
  SlipSource:     ['TEXT', 'IMAGE', 'OCR_IMAGE', 'MANUAL'],
  ConfidenceTier: ['TIER1', 'TIER2', 'TIER3'],
  InjuryImpact:   ['NONE', 'MINOR', 'MAJOR', 'CRITICAL'],
  Plan:           ['FREE', 'PRO', 'ELITE'],
  FailedLayer:    ['L1_FORM', 'L2_SQUAD', 'L2_ROSTER', 'L3_TACTICAL', 'L4_PSYCHOLOGY', 'L5_ENVIRONMENT', 'L6_SIMULATION'],
  FailureType:    ['WRONG_OUTCOME', 'WRONG_GOALS', 'WRONG_WINNER', 'WRONG_SPREAD', 'WRONG_TOTAL', 'WRONG_SCORE'],
  FootballBetTypes: ['HOME','AWAY','DRAW','OVER_0.5','OVER_1.5','OVER_2.5','OVER_3.5','UNDER_0.5','UNDER_1.5','UNDER_2.5','UNDER_3.5','BTTS_YES','BTTS_NO','DNB_HOME','DNB_AWAY'],
  BasketballBetTypes: ['MONEYLINE','SPREAD','OVER_TOTAL','UNDER_TOTAL','FIRST_QUARTER_WINNER','FIRST_HALF_WINNER','FIRST_HALF_OVER','FIRST_HALF_UNDER','HOME_OVER','HOME_UNDER','AWAY_OVER','AWAY_UNDER','BOTH_OVER_100','DOUBLE_CHANCE','WINNING_MARGIN'],
};

function getAllRoutes() {
  return Object.entries(ROUTES).flatMap(([name, methods]) =>
    Object.entries(methods).map(([method, cfg]) => ({ name, method, path: cfg.path, base: cfg.base || 'app', auth: cfg.auth, roles: cfg.roles || null, description: cfg.description }))
  );
}

module.exports = { ROUTES, WS_EVENTS, ENUMS, getAllRoutes };
