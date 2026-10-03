import type { CoinEvent, Simulation } from "../contracts";
import type { BombConfig, CombatEffect, CombatTotals, Encounter, EnemyState } from "../combat/types";
import type { CoinType, Vec3 } from "../contracts";
import type { BagCounts, EffectLevels, StickerId } from "../run/types";

export const SOLVER_LANE_CENTERS = [-4, -2, 0, 2, 4] as const;

export interface SurfaceCell {
  count: number;
  meanHeight: number | null;
  meanForwardSpeed: number | null;
}

export interface SolverLane {
  index: number;
  aimX: number;
  upper: SurfaceCell;
  lowerRear: SurfaceCell;
  lowerMiddle: SurfaceCell;
  lowerFront: SurfaceCell;
  nearEdge: number;
  edgeGap: number | null;
  recentCollected: number;
}

export interface LaneBoard {
  time: number;
  sampleSeconds: number;
  phase: number;
  period: number;
  pusherFront: number;
  shelfFront: number;
  active: number;
  airborne: number;
  falling: number;
  lanes: SolverLane[];
}

export interface LaneObserver {
  observe(simulation: Simulation, visibleIds?: ReadonlySet<number>): LaneBoard;
  record(events: readonly CoinEvent[]): void;
  reset(): void;
}

export interface SolverAction {
  lane: number;
  waitQuarters: 0 | 1 | 2 | 3;
}

export interface RecentRelease {
  action: SolverAction;
  coins: number;
  collected: number;
}

export interface SolverState {
  board: LaneBoard;
  releaseCoins: number;
  feed: "chute" | "back-row";
  recent: RecentRelease[];
  pattern?: "sequential" | "stack" | "flanks";
  candidateAimXs?: readonly number[];
  enemyCoins?: number;
  spacing?: number;
}

export interface SolverDecision {
  action: SolverAction;
  probabilities?: Record<string, number>;
  responseChoice?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type SolverPolicy = (
  state: SolverState,
) => SolverDecision | Promise<SolverDecision>;

export interface CombatTypeCounts {
  counts: Record<CoinType, number>;
  nearThresholdBombs: number;
}

export interface CombatLaneSummary {
  index: number;
  upper: CombatTypeCounts;
  lowerRear: CombatTypeCounts;
  lowerMiddle: CombatTypeCounts;
  lowerFront: CombatTypeCounts;
  nearEdge: CombatTypeCounts;
}

export interface ExposedCombatCoin {
  type: CoinType;
  position: Vec3;
  bombHits: number;
  nearThreshold: boolean;
}

export interface CombatCandidateChute {
  id: string;
  ownerId: string;
  source: "player" | "enemy";
  slot: number;
  enabled: boolean;
  x: number;
}
export interface CombatCandidate {
  aimX: number;
  chutes: readonly CombatCandidateChute[];
}

export interface PublicCombatBatch {
  delta: CombatTotals;
  effects: readonly Omit<CombatEffect, "id">[];
}

export type ObservedEnemy = EnemyState;

export interface ObservedFeedTray {
  id: string;
  ownerId: string;
  slot: number;
  enabled: boolean;
  x: number;
  source: "player" | "enemy";
  /** Next-to-top order; null preserves the position of an unreadable cap. */
  preview: readonly (CoinType | null)[];
}

export interface CombatObservation {
  visibilityModel: "three-cap-rays-v3";
  board: LaneBoard;
  playerHp: number;
  playerMaxHp: number;
  enemies: readonly ObservedEnemy[];
  frontEnemyId: string | null;
  waveIndex: number;
  waveCount: number;
  livingWaveHp: number;
  currency: number;
  ownedBuild: {
    bags: readonly { chuteId: string; counts: BagCounts }[];
    stickers: readonly StickerId[];
    effectLevels: EffectLevels;
    releaseMode: "ordinary" | "dump";
    detonationPolicy: "physical" | "collected-only";
    coinRadius: number;
    coinThickness: number;
    openingPopulation: number;
    coinWeight: number;
  };
  combo: { chain: number; lastSwordTick: number | null; windowTicks: number; maxMultiplier: number; ticksRemaining: number };
  rules: {
    swordDamage: number;
    skullDamage: number;
    potionHealing: number;
    bombDamage: number;
    bomb: BombConfig;
  };
  candidates: readonly CombatCandidate[];
  feed: readonly ObservedFeedTray[];
  exposedCoins: readonly ExposedCombatCoin[];
  lanes: readonly CombatLaneSummary[];
  recentEffects: readonly PublicCombatBatch[];
}

export interface CombatObserver {
  observe(encounter: Encounter): CombatObservation;
  dispose(): void;
}

export interface CombatSolverState {
  observation: CombatObservation;
  candidateAimXs: readonly number[];
  timing: "adaptive" | "fixed";
}

export type CombatSolverPolicy = (
  state: CombatSolverState,
) => SolverDecision | Promise<SolverDecision>;
