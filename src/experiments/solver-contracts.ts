import type { CollectionEvent, Simulation } from "../contracts";

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
  observe(simulation: Simulation): LaneBoard;
  record(events: readonly CollectionEvent[]): void;
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
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type SolverPolicy = (
  state: SolverState,
) => SolverDecision | Promise<SolverDecision>;
