// types/index.ts  [v2.0 — Football + Basketball]

export type Sport          = 'FOOTBALL' | 'BASKETBALL';
export type Plan           = 'FREE' | 'PRO' | 'ELITE';
export type SlipSource     = 'TEXT' | 'IMAGE' | 'OCR_IMAGE' | 'MANUAL';
export type SlipStatus     = 'PENDING' | 'PROCESSING' | 'PREDICTED' | 'VERIFIED' | 'FAILED';
export type ConfidenceTier = 'TIER1' | 'TIER2' | 'TIER3';
export type InjuryImpact   = 'NONE' | 'MINOR' | 'MAJOR' | 'CRITICAL';
export type FailedLayer    = 'L1_FORM' | 'L2_SQUAD' | 'L2_ROSTER' | 'L3_TACTICAL' | 'L4_PSYCHOLOGY' | 'L5_ENVIRONMENT' | 'L6_SIMULATION';
export type FailureType    = 'WRONG_OUTCOME' | 'WRONG_GOALS' | 'WRONG_SCORE' | 'WRONG_WINNER' | 'WRONG_SPREAD' | 'WRONG_TOTAL';

export type FootballBetType = 'HOME' | 'AWAY' | 'DRAW' | 'OVER_0.5' | 'OVER_1.5' | 'OVER_2.5' | 'OVER_3.5' | 'UNDER_0.5' | 'UNDER_1.5' | 'UNDER_2.5' | 'UNDER_3.5' | 'BTTS_YES' | 'BTTS_NO' | 'DNB_HOME' | 'DNB_AWAY' | 'DC_HOME_DRAW' | 'DC_AWAY_DRAW' | 'DC_HOME_AWAY';
export type BasketballBetType = 'MONEYLINE' | 'SPREAD' | 'OVER_TOTAL' | 'UNDER_TOTAL' | 'FIRST_QUARTER_WINNER' | 'FIRST_HALF_WINNER' | 'FIRST_HALF_OVER' | 'FIRST_HALF_UNDER' | 'HOME_OVER' | 'HOME_UNDER' | 'AWAY_OVER' | 'AWAY_UNDER' | 'BOTH_OVER_100' | 'DOUBLE_CHANCE' | 'WINNING_MARGIN';
export type BetType = FootballBetType | BasketballBetType;

export interface MatchInput {
  sport?:       Sport;
  homeTeam:     string;
  awayTeam:     string;
  betType:      BetType;
  betLine?:     number | null;
  betTarget?:   string | null;
  competition?: string | null;
  scheduledAt?: string | null;
}

export interface LayerScores       { L1: number; L2: number; L3: number; L4: number; L5: number; L6: number }
export interface SimulationResults { SIM_A: number; SIM_B: number; SIM_C: number; weighted: number }

export interface FormulaPatchModifier {
  description: string; trigger: string; adjustment: number;
  adjustmentType: 'multiplier' | 'additive'; appliesTo: 'confidence' | 'xg' | 'probability'; context?: string;
}

export interface FormulaLayerPatch {
  patchId: string; appliedAt: string; description: string; modifier: FormulaPatchModifier; reason: string;
}

export interface LayerConfig { description: string; metrics: Record<string, unknown>; patches: FormulaLayerPatch[] }

export interface AiConsensusConfig {
  primaryModel: string; validatorModel: string; consensusThreshold: number;
  debateRounds: number; tieBreaker: string; weightings: { claude: number; gpt4: number };
}

export interface PredictionResponse {
  predictionId: string; matchId: string; sport: Sport;
  homeTeam: string; awayTeam: string; betType: string; betLine: number | null;
  predictedOutcome: string; predictedScore: string | null;
  confidencePct: number; confidenceTier: ConfidenceTier;
  keyDriver: string; redFlags: string[];
  layerScores: LayerScores; simulationResults: SimulationResults;
  verdict: string; rationale: string;
  hadAIConflict: boolean; formulaVersion: string; gameTypeModifier: number;
  backToBackFlag?: boolean; injuryImpact?: InjuryImpact; paceAdvantage?: string | null;
}

export interface SubmitResultRequest {
  matchId: string; homeScore: number; awayScore: number;
  source?: 'MANUAL' | 'API' | 'WEB_SCRAPE';
  homeFirstHalf?: number; awayFirstHalf?: number;
  homeFirstQuarter?: number; awayFirstQuarter?: number;
  overtime?: boolean; backToBackOccurred?: boolean;
}

export interface WsPredictionComplete { matchId: string; prediction: PredictionResponse }
export interface WsPredictionError    { matchId: string; error: string }
export interface WsFormulaPatched     { matchId: string; sport: Sport; failedLayer: FailedLayer; newVersion: string; patchDescription: string }
