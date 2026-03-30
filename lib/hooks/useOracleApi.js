// lib/hooks/useOracleApi.js
// React hook — wires the API client to Clerk auth token automatically
// Usage: const api = useOracleApi();
//        const slip = await api.slips.create.fromText("Arsenal vs Chelsea Home");

'use client';

import { useAuth } from '@clerk/nextjs';
import { useMemo, useCallback } from 'react';
import { FootballOracleClient, ApiError } from '@/lib/api-client';

// ─── MAIN HOOK ────────────────────────────────────────────────────────────────

export function useOracleApi() {
  const { getToken } = useAuth();

  const client = useMemo(() => {
    return new FootballOracleClient({
      getToken: () => getToken(),
    });
  }, [getToken]);

  return client;
}

// ─── NAMESPACED HOOK (cleaner DX) ─────────────────────────────────────────────

export function useOracle() {
  const api = useOracleApi();

  return useMemo(() => ({

    // ── Health ──────────────────────────────────────────────────────────────
    health: {
      check:  ()  => api.health(),
      engine: ()  => api.engineHealth(),
    },

    // ── User ────────────────────────────────────────────────────────────────
    user: {
      get:    (includeStats) => api.getUser(includeStats),
      update: (data)         => api.updateUser(data),
    },

    // ── Slips ───────────────────────────────────────────────────────────────
    slips: {
      list:        (params)                            => api.listSlips(params),
      get:         (slipId)                            => api.getSlip(slipId),
      delete:      (slipId)                            => api.deleteSlip(slipId),
      create: {
        fromText:  (rawInput, autoPredict)             => api.createSlipFromText(rawInput, autoPredict),
        fromImage: (base64, mimeType, autoPredict)     => api.createSlipFromImage(base64, mimeType, autoPredict),
        manual:    (matches, autoPredict)              => api.createSlipManual(matches, autoPredict),
      },
    },

    // ── Upload ──────────────────────────────────────────────────────────────
    upload: {
      image: (file) => api.uploadSlipImage(file),
    },

    // ── Predictions ─────────────────────────────────────────────────────────
    predictions: {
      forSlip:    (slipId)  => api.getPredictionsForSlip(slipId),
      forMatch:   (matchId) => api.getPredictionForMatch(matchId),
      runSlip:    (slipId)  => api.predictSlip(slipId),
      runMatch:   (matchId) => api.predictMatch(matchId),
    },

    // ── Results ─────────────────────────────────────────────────────────────
    results: {
      list:   (params)                                  => api.getResults(params),
      submit: (matchId, home, away, source)             => api.submitResult(matchId, home, away, source),
      batch:  (results)                                 => api.submitResultsBatch(results),
    },

    // ── Formula ─────────────────────────────────────────────────────────────
    formula: {
      active:   ()         => api.getActiveFormula(),
      history:  ()         => api.getFormulaHistory(),
      patches:  (params)   => api.getFormulaPatches(params),
      accuracy: ()         => api.getFormulaAccuracy(),
      rollback: (versionId)=> api.rollbackFormula(versionId),
    },

    // ── Admin ────────────────────────────────────────────────────────────────
    admin: {
      report:    ()             => api.getSystemReport(),
      patches:   (params)       => api.adminGetPatches(params),
      versions:  ()             => api.adminGetVersions(),
      usage:     ()             => api.adminGetUsage(),
      rollback:  (versionId)    => api.adminRollback(versionId),
      snapshot:  ()             => api.adminTriggerSnapshot(),
      scrape:    ()             => api.adminTriggerScraper(),
      setPlan:   (userId, plan) => api.adminSetPlan(userId, plan),
    },

    // ── Engine Queues ───────────────────────────────────────────────────────
    queue: {
      predict:   (payload)         => api.queuePrediction(payload),
      verify:    (payload)         => api.queueVerification(payload),
      status:    (jobId, queue)    => api.getJobStatus(jobId, queue),
    },

  }), [api]);
}

// ─── ERROR HELPER ─────────────────────────────────────────────────────────────

export { ApiError };

export function isApiError(err) {
  return err instanceof ApiError;
}

export function getErrorMessage(err) {
  if (err instanceof ApiError) {
    if (err.status === 429) return `Rate limit reached — upgrade your plan`;
    if (err.status === 401) return `Session expired — please sign in again`;
    if (err.status === 403) return `You don't have permission for this action`;
    if (err.status === 404) return `Not found`;
    return err.message;
  }
  return err?.message || 'Unknown error';
}
