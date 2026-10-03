import type { EncounterStep } from "../src/combat/types";
import type { SolverAction, CombatObservation } from "../src/experiments/solver-contracts";
import type { CoinType } from "../src/contracts";
import type { OfferId, PurchasePreview, PurchaseRequest, PurchaseResult, RunSnapshot, StarterId } from "../src/run/types";

export const RUN_VERSION = "mvp3-run-v1" as const;
export const RUN_POLICIES = ["center", "random", "rule"] as const;
export type RunPolicy = typeof RUN_POLICIES[number];
export type RunStudyPhase = "smoke" | "screen" | "evaluate" | "replay";
export type BuildId = "collector" | "swarm" | "volley" | "tempo" | "recovery" | "no-purchases-collector" | "no-purchases-swarm" | "no-purchases-volley";
export interface PurchasePriority { offerId: OfferId; cap: number }
export interface BuildProfile { id: BuildId; starter: StarterId; priorities: readonly PurchasePriority[] }
export interface RunTrial { id: string; seed: number; build: BuildId; policy: RunPolicy; actions: number }
export interface RunDecision { encounterIndex: number; tick: number; observation: CombatObservation; action: SolverAction; aimX: number }
export interface ShopTrace {
  encounterIndex: number;
  opportunities: PurchasePreview[];
  attempts: { request: PurchaseRequest; preview: PurchasePreview; result: PurchaseResult }[];
  before: RunSnapshot;
  after: RunSnapshot;
}
export interface TickTrace {
  kind: "tick";
  encounterIndex: number;
  stage: "loading" | "wait" | "mechanical" | "window" | "tail";
  tick: number;
  step: EncounterStep;
  state: unknown;
}
export interface QuietSpan { kind: "quiet"; encounterIndex: number; stage: TickTrace["stage"]; from: number; through: number; digest: string }
export type RunTrace = TickTrace | QuietSpan | { kind: "entry" | "completion" | "shop"; encounterIndex: number; state: unknown };
export interface EncounterMetrics {
  encounterIndex: number;
  loadingOutcome: "victory" | "defeat" | null;
  acquiredBuild: boolean;
  completedWaves: number;
  terminalHp: number;
  entryHp: number;
  grossIncoming: number;
  coinHealingUsed: number;
  coinHealingWasted: number;
  recoveryUsed: number;
  recoveryWasted: number;
  netAttrition: number;
  moneyEarned: number;
  moneySpent: number;
  moneyCarried: number;
  legalPurchaseOpportunities: number;
  unaffordablePurchaseOpportunities: number;
  bags: RunSnapshot["playerChutes"];
  nativeBags: RunSnapshot["encounter"]["feedStreams"];
  chuteCount: number;
  stickers: RunSnapshot["stickers"];
  swordDamage: number;
  bombDamage: number;
  comboDistribution: Record<string, number>;
  acceptedActions: number;
  admittedRounds: number;
  burstDurations: number[];
  mechanicalWaitTicks: number;
  burstStallTicks: number;
  escalationTriggers: { enemyId: string; threshold: number; tick: number }[];
  discardedDamage: number;
  enemyHpRemoved: number;
  lostCoins: Record<CoinType, number>;
  lostGizmos: number;
  gizmoCurrency: number;
  outcome: string;
  failurePhase: string | null;
  failureCause: string | null;
}
export interface RunRow {
  trial: RunTrial;
  status: "won" | "lost" | "unfinished" | "invalid";
  error: string | null;
  failurePhase: string | null;
  decisions: RunDecision[];
  shops: ShopTrace[];
  trace: RunTrace[];
  encounters: EncounterMetrics[];
  final: RunSnapshot | null;
  finalPhysical: unknown;
  finalDigest: string | null;
}
export type RunRowSummary = Pick<
  RunRow,
  "trial" | "status" | "error" | "failurePhase" | "encounters" | "final" | "finalDigest"
>;
export interface RunRowIdentity {
  trial: RunTrial;
  digest: string;
}
export interface Distribution { count: number; median: number | null; p10: number | null; p90: number | null; worst: number | null }
export interface Gate { name: string; passed: boolean; evidence: unknown; adjustment: string | null }
export interface RunConfigurationEvidence {
  digest: string;
  catalogDigest: string;
  mechanicalDigest: string;
  fixedRecovery: number;
  victoryReward: number;
  miniature: {
    radius: number;
    thickness: number;
    openingPopulation: number;
    coinWeight: number;
    swordDamage: number;
  };
  mechanics: {
    actionLimit: number;
    roundLimit: number;
    loadingLimit: number;
    mechanicalLimit: number;
    windowTicks: number;
    shopPurchaseLimit: number;
  };
}
export interface ReplayCheck {
  trialId: string;
  matched: boolean;
  expectedDigest: string;
  actualDigest: string;
  error: string | null;
}
export interface RunSummary {
  planned: number;
  outcomes: Record<RunRow["status"], number>;
  byBuild: Record<string, { planned: number; won: number; lost: number; unfinished: number; invalid: number; winRate: number; metrics: Record<string, Distribution> }>;
  gates: Gate[];
  accepted: boolean;
}
export interface RunReport {
  version: typeof RUN_VERSION;
  phase: RunStudyPhase;
  protocolDigest: string;
  configuration: RunConfigurationEvidence;
  manifest: RunTrial[];
  rows: RunRow[];
  summary: RunSummary;
  selectionDigest: string | null;
  replayChecks: ReplayCheck[];
}
export interface RunReportProjection {
  version: typeof RUN_VERSION;
  phase: RunStudyPhase;
  protocolDigest: string;
  configuration: RunConfigurationEvidence;
  manifest: RunTrial[];
  rows: RunRowSummary[];
  rowIdentities: RunRowIdentity[];
  summary: RunSummary;
  selectionDigest: string | null;
  replayChecks: ReplayCheck[];
}
export interface RunSelection {
  version: typeof RUN_VERSION;
  protocolDigest: string;
  screenReportDigest: string;
  screenManifest: RunTrial[];
  gates: Gate[];
  evaluationManifest: RunTrial[];
  digest: string;
}
