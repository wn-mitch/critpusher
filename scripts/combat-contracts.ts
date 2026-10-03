import type { CoinEvent, CoinType, SimulationStats } from "../src/contracts";
import type {
  CombatResult,
  CombatStepResult,
  EncounterConfig,
  EncounterSnapshot,
  FeedTray,
  RoundAdmission,
  WaveEvent,
} from "../src/combat/types";
import type { ChuteStreamSnapshot } from "../src/combat/feed";
import type { CombatObservation, SolverAction, SolverDecision } from "../src/experiments/solver-contracts";

export const FIGHT_VERSION = "first-fight-v2" as const;
export const FIGHT_POLICIES = ["center", "random", "rule", "jev"] as const;
export type FightPolicy = typeof FIGHT_POLICIES[number];
export type FightTiming = "adaptive" | "fixed";
export type FightPhase = "smoke" | "screen" | "evaluate" | "replay";
export type FightOutcome = CombatResult | "budget-exhausted";
export type TypeCounts = Record<CoinType, number>;

export interface FightProfile {
  name: string;
  mixture: "balanced" | "recovery" | "pressure";
  bombPreset: "sensitive" | "standard" | "resistant";
  config: EncounterConfig;
}
export interface FightTrial {
  id: string;
  profile: FightProfile;
  policy: FightPolicy;
  timing: FightTiming;
  seed: number;
  actions: number;
  maxJevRequests: number;
}
export interface FightLoading {
  ticks: number;
  plannedStarting: TypeCounts;
  admittedStarting: TypeCounts;
  collectedByType: TypeCounts;
  lostByType: TypeCounts;
  detonated: number;
  nativeFeedIds: readonly number[];
}
export interface FightLedgerEntry {
  tick: number;
  stage: "loading" | "wait" | "window" | "tail";
  action: number | null;
  events: readonly CoinEvent[];
  combat: CombatStepResult;
  admissions: readonly RoundAdmission[];
  waveEvents: readonly WaveEvent[];
  feed: readonly FeedTray[];
  feedStreams: readonly ChuteStreamSnapshot[];
}
export interface FightDecisionTrace {
  opportunity: number;
  tick: number;
  observation: CombatObservation;
  suggested: SolverDecision | null;
  executed: SolverAction | null;
  aimX: number | null;
  waitTicks: number;
  waitAdvancedTicks: number;
  mechanicalWaitAdvancedTicks: number;
  windowAdvancedTicks: number;
  admissions: readonly RoundAdmission[];
  requestCharged: boolean;
  error: string | null;
}
export interface FightWindow {
  action: number;
  startTick: number;
  admittedAtTick: number;
  endTick: number;
  waitTicks: number;
  catches: number;
  detonations: number;
  enemyDamage: number;
  playerDamage: number;
  healingUsed: number;
  currency: number;
  dry: boolean;
  noEnemyDamage: boolean;
}
export interface FightMetrics {
  acceptedActions: number;
  attemptedActions: number;
  decisionOpportunities: number;
  elapsedTicks: number;
  elapsedSeconds: number;
  finalTick: number;
  terminalActionCount: number | null;
  terminalSeconds: number | null;
  longestDry: number;
  longestNoEnemyDamage: number;
  largestRollingIncoming: number;
  largestRollingIncomingFraction: number;
  severeBurst: boolean;
  lostByType: TypeCounts;
}
export interface FightApiUsage {
  chargedRequests: number;
  inputTokens: number;
  outputTokens: number;
  usageUnavailableRequests: number;
}
export interface FightRow {
  trial: FightTrial;
  status: "complete" | "invalid";
  result: FightOutcome | null;
  error: string | null;
  loading: FightLoading | null;
  initialDigest: string | null;
  simulationDigest: string | null;
  final: EncounterSnapshot | null;
  finalFeed: readonly FeedTray[] | null;
  physicalFinal: SimulationStats | null;
  metrics: FightMetrics | null;
  api: FightApiUsage | null;
  ledger: FightLedgerEntry[];
  decisions: FightDecisionTrace[];
  windows: FightWindow[];
  wallSeconds: number;
}
export interface MetricSummary {
  count: number;
  median: number | null;
  p10: number | null;
  p90: number | null;
  worst: number | null;
}
export type FightMetric =
  | "playerHp" | "enemyHp" | "currency" | "swordDamage" | "bombDamageToEnemy"
  | "enemyHpRemoved" | "discardedDamage" | "skullDamage" | "bombDamageToPlayer"
  | "healingOffered" | "healingUsed" | "healingWasted" | "detonations" | "safeBombs"
  | "blastAssociatedDetonations" | "lostCoins" | "acceptedActions" | "elapsedSeconds"
  | "longestDry" | "longestNoEnemyDamage" | "largestRollingIncoming"
  | "largestRollingIncomingFraction";
export interface CountRate { count: number; denominator: number; rate: number | null }
export interface FightSummary {
  profile: string;
  policy: FightPolicy;
  timing: FightTiming;
  planned: number;
  valid: number;
  invalid: number;
  invalidRate: number | null;
  outcomes: Record<FightOutcome, CountRate>;
  metrics: Record<FightMetric, MetricSummary>;
  lostByType: Record<CoinType, MetricSummary>;
  finish: { terminal: number; censored: number; actions: MetricSummary; seconds: MetricSummary };
  seeds: number[];
}
export type ComparisonMetric = "victory" | "playerHp" | "currency" | "longestDry" | "largestRollingIncomingFraction";
export interface DifferenceInterval { difference: number | null; lower95: number | null; upper95: number | null }
export interface FightComparison {
  profile: string;
  timing: FightTiming;
  left: FightPolicy;
  right: FightPolicy;
  plannedPairs: number;
  validPairs: number;
  omittedPairs: number;
  metrics: Record<ComparisonMetric, DifferenceInterval>;
  seeds: number[];
}
export interface SelectionGates {
  maxInvalid: number;
  maxUnfinishedRate: number;
  maxEarlyTerminalRate: number;
  minMedianTerminalActions: number;
  maxMedianTerminalActions: number;
  maxSevereTailRate: number;
  severeTailDamageFraction: number;
  preferredJevVictoryMin: number;
  preferredJevVictoryMax: number;
}
export interface SelectionCandidate {
  profile: FightProfile;
  eligible: boolean;
  reasons: string[];
  planned: number;
  valid: number;
  invalid: number;
  unfinishedRate: number | null;
  earlyTerminalRate: number | null;
  medianTerminalActions: number | null;
  severeTailRate: number | null;
  worstPolicySimultaneousDefeatRate: number | null;
  jevVictoryRate: number | null;
  medianJevPlayerHp: number | null;
  medianJevCurrency: number | null;
}
export interface FrozenSelection {
  version: "first-fight-selection-v1";
  status: "selected" | "no-qualified-mixture";
  mode: "qualified" | "diagnostic";
  screeningSeeds: number[];
  screeningReportDigest: string;
  protocolDigest: string;
  gates: SelectionGates;
  profiles: FightProfile[];
  ranking: SelectionCandidate[];
  digest: string;
}
export interface ReplayCheck {
  trialId: string;
  matched: boolean;
  initialDigestMatch: boolean;
  ledgerMatch: boolean;
  simulationDigestMatch: boolean;
  outcomeMatch: boolean;
  error: string | null;
}
export interface FightIdentity {
  sourceDigest: string;
  dependencyDigest: string;
  node: string;
  platform: string;
  arch: string;
  osRelease: string;
}
export interface FightReport {
  version: typeof FIGHT_VERSION;
  phase: FightPhase;
  status: "running" | "complete" | "invalid";
  protocol: {
    loadingMinimumTicks: 720;
    loadingMaximumTicks: 1440;
    cycleTicks: 144;
    actions: number;
    visibilityModel: CombatObservation["visibilityModel"];
    timing: FightTiming[];
    seeds: number[];
    plannedTrials: FightTrial[];
    bootstrapResamples: 2000;
    bootstrapSeed: number;
    notes: string[];
  };
  identity: FightIdentity;
  planned: number;
  completed: number;
  invalid: number;
  rows: FightRow[];
  summary: FightSummary[];
  comparisons: FightComparison[];
  selection: FrozenSelection | null;
  replay: ReplayCheck[];
  elapsedSeconds: number;
}
