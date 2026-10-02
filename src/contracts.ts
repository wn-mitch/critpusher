import type { ChuteDrop } from "./chutes";
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
export type CoinFaction = "ally" | "enemy";
export interface CoinView {
  id: number;
  faction: CoinFaction;
  position: Vec3;
  rotation: Quaternion;
  radius: number;
  thickness: number;
}
export interface CollectionEvent {
  id: number;
  kind: "collected" | "lost";
  faction: CoinFaction;
  position: Vec3;
}
export interface SimulationStats {
  time: number;
  active: number;
  sleeping: number;
  spawned: number;
  collected: number;
  allyCollected: number;
  enemyCollected: number;
  lost: number;
  pendingRain: number;
  physicsMs: number;
  pusherZ: number;
  phase: number;
}
export interface Simulation {
  readonly coins: ReadonlyMap<number, CoinView>;
  readonly tuning: Tuning;
  step(): void;
  drop(x: number, mode?: "chute" | "back-row"): boolean;
  /**
   * Atomically release one to five vertical chute stacks of one to three coins.
   * Returned ids follow input chute order, then bottom-to-top order.
   */
  releaseChutes(
    chutes: readonly { x: number; count: number; faction?: CoinFaction }[],
  ): number[] | null;
  reset(tuning?: Partial<Tuning>): void;
  configure(tuning: Partial<Tuning>): void;
  drainEvents(): CollectionEvent[];
  stats(): SimulationStats;
  dispose(): void;
}
export interface Presentation {
  readonly canvas: HTMLCanvasElement;
  render(
    simulation: Simulation,
    dt: number,
    reducedMotion: boolean,
    chutes: readonly ChuteDrop[],
  ): void;
  collect(events: CollectionEvent[], reducedMotion: boolean): void;
  markTargets(targets: ReadonlyMap<number, number>): void;
  pointerToChute(clientX: number, clientY: number): number;
  resize(): void;
  dispose(): void;
}
