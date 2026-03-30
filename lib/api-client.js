// lib/api-client.js  [v2.0 — multi-sport SDK]
'use strict';

const DEFAULT_BASE_URL   = typeof window !== 'undefined' ? window.location.origin : process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
const DEFAULT_ENGINE_URL = process.env.DATA_ENGINE_URL || 'http://localhost:3001';

class ApiError extends Error {
  constructor(message, status, details = null) {
    super(message); this.name = 'ApiError'; this.status = status; this.details = details;
  }
}

async function request(url, options = {}) {
  const { token, ...rest } = options;
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.headers || {}) };
  const res  = await fetch(url, { ...rest, headers });
  let body;
  try { body = await res.json(); } catch { body = { error: `HTTP ${res.status}` }; }
  if (!res.ok) throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, body?.details || null);
  return body;
}

const get  = (url, tok)         => request(url, { method: 'GET',    token: tok });
const post = (url, data, tok)   => request(url, { method: 'POST',   body: JSON.stringify(data), token: tok });
const patch= (url, data, tok)   => request(url, { method: 'PATCH',  body: JSON.stringify(data), token: tok });
const del  = (url, tok)         => request(url, { method: 'DELETE', token: tok });

class FootballOracleClient {
  constructor(config = {}) {
    this.baseUrl   = config.baseUrl   || DEFAULT_BASE_URL;
    this.engineUrl = config.engineUrl || DEFAULT_ENGINE_URL;
    this._token    = config.token     || null;
    this._getToken = config.getToken  || null;
  }
  async _tok() { return this._getToken ? this._getToken() : this._token; }
  _url(p)    { return `${this.baseUrl}${p}`; }
  _eng(p)    { return `${this.engineUrl}${p}`; }

  // ── Health ──────────────────────────────────────────────────────────────────
  health()        { return get(this._url('/api/health')); }
  engineHealth()  { return get(this._eng('/health')); }

  // ── Users ───────────────────────────────────────────────────────────────────
  async getUser(includeStats = true) { return get(this._url(`/api/users${includeStats ? '' : '?stats=false'}`), await this._tok()); }
  async updateUser(data)             { return patch(this._url('/api/users'), data, await this._tok()); }

  // ── Slips (sport-aware) ─────────────────────────────────────────────────────
  async listSlips(params = {})       { const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v])=>v!=null))).toString(); return get(this._url(`/api/slips${qs?'?'+qs:''}`), await this._tok()); }
  async getSlip(slipId)              { return get(this._url(`/api/slips/${slipId}`), await this._tok()); }
  async deleteSlip(slipId)           { return del(this._url(`/api/slips/${slipId}`), await this._tok()); }
  async createSlipFromText(rawInput, autoPredict=true) { return post(this._url('/api/slips'), { source:'TEXT', rawInput, autoPredict }, await this._tok()); }
  async createSlipFromImage(imageBase64, mimeType='image/jpeg', autoPredict=true) { return post(this._url('/api/slips'), { source:'IMAGE', imageBase64, mimeType, autoPredict }, await this._tok()); }
  async createSlipManual(matches, autoPredict=true) { return post(this._url('/api/slips'), { source:'MANUAL', matches, autoPredict }, await this._tok()); }

  // ── Football slip helpers ───────────────────────────────────────────────────
  async createFootballSlip(matches, autoPredict=true) {
    return this.createSlipManual(matches.map(m => ({ ...m, sport: 'FOOTBALL' })), autoPredict);
  }

  // ── Basketball slip helpers ─────────────────────────────────────────────────
  /** @param {Array<{homeTeam,awayTeam,betType,betLine?,competition?,scheduledAt?}>} games */
  async createBasketballSlip(games, autoPredict=true) {
    return this.createSlipManual(games.map(g => ({ ...g, sport: 'BASKETBALL' })), autoPredict);
  }

  // ── Upload ──────────────────────────────────────────────────────────────────
  async uploadSlipImage(imageFile) {
    const tok = await this._tok();
    const fd  = new FormData(); fd.append('image', imageFile);
    const res = await fetch(this._url('/api/upload'), { method: 'POST', headers: tok ? { Authorization: `Bearer ${tok}` } : {}, body: fd });
    const b   = await res.json();
    if (!res.ok) throw new ApiError(b?.error || 'Upload failed', res.status, b?.details);
    return b;
  }

  // ── Predictions ─────────────────────────────────────────────────────────────
  async predictSlip(slipId)          { return post(this._url('/api/predict'), { slipId }, await this._tok()); }
  async predictMatch(matchId)        { return post(this._url('/api/predict'), { matchId }, await this._tok()); }
  async getPredictionsForSlip(slipId){ return get(this._url(`/api/predict?slipId=${slipId}`), await this._tok()); }
  async getPredictionForMatch(matchId){ return get(this._url(`/api/predict?matchId=${matchId}`), await this._tok()); }

  // ── Results — Football ──────────────────────────────────────────────────────
  async submitFootballResult(matchId, homeScore, awayScore, source='MANUAL') {
    return post(this._url('/api/results'), { matchId, homeScore, awayScore, source }, await this._tok());
  }

  // ── Results — Basketball (with splits) ─────────────────────────────────────
  /**
   * @param {string}  matchId
   * @param {number}  homeScore   Final home score
   * @param {number}  awayScore   Final away score
   * @param {Object}  [opts]      Optional splits: homeFirstHalf, awayFirstHalf, homeFirstQuarter, awayFirstQuarter, overtime, backToBackOccurred
   */
  async submitBasketballResult(matchId, homeScore, awayScore, opts = {}) {
    return post(this._url('/api/results'), { matchId, homeScore, awayScore, source: opts.source || 'MANUAL', homeFirstHalf: opts.homeFirstHalf, awayFirstHalf: opts.awayFirstHalf, homeFirstQuarter: opts.homeFirstQuarter, awayFirstQuarter: opts.awayFirstQuarter, overtime: opts.overtime || false, backToBackOccurred: opts.backToBackOccurred }, await this._tok());
  }

  async submitResult(matchId, homeScore, awayScore, source='MANUAL') { return this.submitFootballResult(matchId, homeScore, awayScore, source); }
  async submitResultsBatch(results) { return post(this._url('/api/results'), { results }, await this._tok()); }
  async getResults(params = {}) { const qs = new URLSearchParams(params).toString(); return get(this._url(`/api/results${qs?'?'+qs:''}`), await this._tok()); }
  async getResultsBySport(sport, params={}) { return this.getResults({ ...params, sport }); }

  // ── Formula ─────────────────────────────────────────────────────────────────
  async getActiveFormula(sport='FOOTBALL')  { return get(this._url(`/api/formula?view=active&sport=${sport}`), await this._tok()); }
  async getFormulaHistory(sport)            { return get(this._url(`/api/formula?view=history${sport?'&sport='+sport:''}`), await this._tok()); }
  async getFormulaPatches(params={})        { return get(this._url(`/api/formula?${new URLSearchParams({view:'patches',...params})}`), await this._tok()); }
  async getFormulaAccuracy(sport)           { return get(this._url(`/api/formula?view=accuracy${sport?'&sport='+sport:''}`), await this._tok()); }
  async rollbackFormula(targetVersionId)    { return post(this._url('/api/formula'), { action:'rollback', targetVersionId }, await this._tok()); }

  // ── Admin ────────────────────────────────────────────────────────────────────
  async getSystemReport()               { return get(this._url('/api/admin?view=report'), await this._tok()); }
  async adminGetPatches(params={})      { return get(this._url(`/api/admin?${new URLSearchParams({view:'patches',...params})}`), await this._tok()); }
  async adminGetVersions()              { return get(this._url('/api/admin?view=versions'), await this._tok()); }
  async adminGetUsage()                 { return get(this._url('/api/admin?view=usage'), await this._tok()); }
  async adminRollback(targetVersionId)  { return post(this._url('/api/admin'), { action:'rollback', targetVersionId }, await this._tok()); }
  async adminTriggerSnapshot()          { return post(this._url('/api/admin'), { action:'snapshot' }, await this._tok()); }
  async adminTriggerScraper()           { return post(this._url('/api/admin'), { action:'scrape' }, await this._tok()); }
  async adminSetPlan(userId, plan)      { return post(this._url('/api/admin'), { action:'set_plan', userId, plan }, await this._tok()); }

  // ── Engine queues ───────────────────────────────────────────────────────────
  async queuePrediction(payload)          { return post(this._eng('/queue/predict'), payload); }
  async queueVerification(payload)        { return post(this._eng('/queue/verify'), payload); }
  async getJobStatus(jobId, queue='predictions') { return get(this._eng(`/queue/status/${jobId}?queue=${queue}`)); }
}

let _instance = null;
function getClient(config={}) { if (!_instance || Object.keys(config).length) _instance = new FootballOracleClient(config); return _instance; }
function createReactClient(getToken) { return new FootballOracleClient({ getToken }); }

module.exports = { FootballOracleClient, getClient, createReactClient, ApiError };
