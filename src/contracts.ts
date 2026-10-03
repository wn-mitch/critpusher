import type { CombatStepResult, FeedLayout, FeedTray, SimulationConfig } from "./combat/types";
import type { StickerId } from "./run/types";
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}
export interface Tuning {
  seed: number;
  density: number;
  radius: number;
  thickness: number;
  shelfFront: number;
  coinWeight: number;
  friction: number;
  stroke: number;
  period: number;
  dropHeight: number;
  dropRate: number;
}
export const COIN_TYPES = ["gold", "diamond", "sword", "skull", "potion", "bomb"] as const;
export type CoinType = (typeof COIN_TYPES)[number];
export interface CoinView {
  id: number;
  type: CoinType;
  bombHits: number;
  position: Vec3;
  rotation: Quaternion;
  radius: number;
  thickness: number;
}
export interface GizmoDefinition { kind: "bell"; radius: number; density: number; payout: number }
export interface GizmoView extends GizmoDefinition { id: number; position: Vec3; rotation: Quaternion }
export type GizmoEvent = { id: number; type: "bell"; position: Vec3 } & (
  | { kind: "collected"; currency: number }
  | { kind: "lost"; reason: "out-of-bounds" | "invalid-pose" | "spawn-failed" }
);
export interface GizmoStats { spawned: number; active: number; collected: number; lost: number; pending: number }
export interface NativeFeedAdmission { chuteId: string; id: number; type: CoinType; row: number }
interface CoinEventBase {
  id: number;
  type: CoinType;
  position: Vec3;
}
export type CoinEvent = CoinEventBase & (
  | { kind: "collected" }
  | { kind: "lost"; reason: "out-of-bounds" | "invalid-pose" | "spawn-failed" }
  | { kind: "detonated"; chainRootId: number | null; blastAssociated: boolean }
);
export interface SimulationStats {
  time: number;
  active: number;
  sleeping: number;
  spawned: number;
  collected: number;
  collectedByType: Record<CoinType, number>;
  detonated: number;
  lost: number;
  pendingRain: number;
  physicsMs: number;
  pusherZ: number;
  phase: number;
  gizmos: GizmoStats;
}
export interface Simulation {
  readonly coins: ReadonlyMap<number, CoinView>;
  readonly gizmos: ReadonlyMap<number, GizmoView>;
  readonly tuning: Tuning;
  readonly config: SimulationConfig;
  setBombsActive(active: boolean): void;
  configureGizmo(definition: GizmoDefinition | null): void;
  drainGizmoEvents(): GizmoEvent[];
  /** Discard only future rain; admitted coin accounting is unchanged. */
  cancelRain(): void;
  setFeedLayout(layout: readonly FeedLayout[]): void;
  feedTrays(): readonly FeedTray[];
  /** Opens every ready feeder atomically, adopting its existing bodies into the ledger. */
  releaseFeed(): number[] | null;
  startFeedBurst(): boolean;
  cancelFeedBurst(): void;
  drainFeedAdmissions(): NativeFeedAdmission[];
  step(): void;
  drop(x: number, mode?: "chute" | "back-row"): boolean;
  /**
   * Atomically release one to six vertical chute stacks of one to three coins.
   * Returned ids follow input chute order, then bottom-to-top order.
   * A nonnegative integer minimumIntervalTicks overrides the drop-rate cooldown.
   * Releases start with downward exit velocity; occupied slots still reject atomically.
   */
  releaseChutes(
    chutes: readonly { x: number; count: number; type?: CoinType }[],
    minimumIntervalTicks?: number,
  ): number[] | null;
  reset(tuning?: Partial<Tuning>, config?: Partial<SimulationConfig>): void;
  configure(tuning: Partial<Tuning>): void;
  drainEvents(): CoinEvent[];
  stats(): SimulationStats;
  dispose(): void;
}
export interface Presentation {
  readonly canvas: HTMLCanvasElement;
  render(
    simulation: Simulation,
    dt: number,
    reducedMotion: boolean,
    trays: readonly FeedTray[],
  ): void;
  collect(
    events: readonly CoinEvent[],
    reducedMotion: boolean,
    combat?: CombatStepResult,
  ): void;
  clearEffects(): void;
  setStickers(stickers: readonly StickerId[]): void;
  markTargets(targets: ReadonlyMap<number, number>): void;
  pointerToChute(clientX: number, clientY: number): number;
  resize(): void;
  dispose(): void;
}
