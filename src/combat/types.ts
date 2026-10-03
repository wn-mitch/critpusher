import type { CoinType, CoinEvent, CoinView, GizmoEvent, Simulation, Tuning, Vec3 } from "../contracts";
import type { ChuteSettings, ChuteSlot } from "../chutes";
import type { ChuteStreamSnapshot } from "./feed";
import type { ResolvedBuild } from "../run/modifiers";

export type CoinMix = Record<CoinType, number>;
export interface BombConfig {
  hitThreshold: number;
  minClosingSpeed: number;
  blastRadius: number;
  blastDeltaSpeed: number;
}
export interface SimulationConfig { openingMix: CoinMix; bomb: BombConfig }
export interface EnemyDefinition {
  id: string;
  name: string;
  maxHp: number;
  chuteId: string;
  bag: readonly CoinType[];
  kind: "trainee" | "guard" | "escalator" | "foreman" | "escort";
}
export interface WaveDefinition { id: string; enemies: readonly EnemyDefinition[] }
export interface EnemyState {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  chuteId: string;
  admittedRounds: number;
  kind: EnemyDefinition["kind"];
}
export interface PlayerChuteDefinition { id: string; bag: readonly CoinType[] }
export interface EncounterEntry {
  playerHp: number;
  currency: number;
  playerChutes: readonly PlayerChuteDefinition[];
  build?: ResolvedBuild;
}
export interface EncounterConfig extends SimulationConfig {
  playerMaxHp: number;
  waves: readonly WaveDefinition[];
  swordDamage: number;
  skullDamage: number;
  potionHealing: number;
}
export type CombatResult = "victory" | "defeat" | "simultaneous-defeat";
export interface CombatTotals {
  swordDamage: number;
  skullDamage: number;
  bombDamageToEnemy: number;
  bombDamageToPlayer: number;
  enemyHpRemoved: number;
  discardedDamage: number;
  healingOffered: number;
  healingUsed: number;
  healingWasted: number;
  currencyGained: number;
  safeBombs: number;
  detonations: number;
  blastAssociatedDetonations: number;
}
export interface ComboState { chain: number; lastSwordTick: number | null }
export interface CombatState {
  playerHp: number;
  enemies: readonly EnemyState[];
  currency: number;
  result: CombatResult | null;
  totals: CombatTotals;
  combo: ComboState;
}
export interface EnemyHit { enemyId: string; damage: number }
export interface CombatEffect {
  id: number;
  type: CoinType;
  position: Vec3;
  enemyDamage: number;
  swordMultiplier: number;
  enemyHits: readonly EnemyHit[];
  discardedDamage: number;
  playerDamage: number;
  healingOffered: number;
  currency: number;
  safeBomb: boolean;
  detonated: boolean;
  blastAssociated: boolean;
}
export interface CombatStepResult { state: CombatState; delta: CombatTotals; effects: readonly CombatEffect[] }
export type EncounterPhase = "loading" | "active" | "finished" | "error";
export interface FeedLayout {
  id: string;
  ownerId: string;
  enabled: boolean;
  slot: number;
  x: number;
  source: "player" | "enemy";
  preview: readonly CoinType[];
}
export interface FeedBurstMember { stockId: number; type: CoinType; row: number; admittedId: number | null }
export interface FeedBurstState {
  phase: "idle" | "emitting" | "rearming";
  cohort: readonly FeedBurstMember[];
  trapRetracted: boolean;
}
export interface FeedTray extends FeedLayout {
  coins: readonly CoinView[];
  gateOpen: boolean;
  burst: FeedBurstState;
}
export interface RoundAdmission {
  accepted: true;
  tick: number;
  action: number;
  round: number;
  aimX: number;
  newRound: boolean;
  coins: readonly { chuteId: string; id: number; type: CoinType }[];
}
export interface WaveEvent { kind: "entered" | "died"; waveIndex: number; enemyIds: readonly string[]; tick: number }
export interface EncounterStep {
  events: readonly CoinEvent[];
  gizmoEvents: readonly GizmoEvent[];
  combat: CombatStepResult;
  admissions: readonly RoundAdmission[];
  waveEvents: readonly WaveEvent[];
}
export interface EncounterSnapshot {
  phase: EncounterPhase;
  result: CombatResult | null;
  playerHp: number;
  combo: ComboState;
  build: ResolvedBuild | null;
  playerMaxHp: number;
  enemies: readonly EnemyState[];
  frontEnemyId: string | null;
  waveIndex: number;
  waveCount: number;
  livingWaveHp: number;
  currency: number;
  acceptedActions: number;
  acceptedRounds: number;
  queuedRounds: number;
  remainingRounds: number;
  interruptedRounds: number;
  completionSerial: number;
  tick: number;
  chuteSlots: readonly ChuteSlot[];
  playerChutes: readonly PlayerChuteDefinition[];
  chuteSettings: ChuteSettings;
  feedStreams: readonly ChuteStreamSnapshot[];
  config: EncounterConfig;
  totals: CombatTotals;
  lastAdmission: RoundAdmission | null;
  paused: boolean;
  error: string | null;
  loading: { ticks: number; collectedByType: CoinMix; lostByType: CoinMix; detonated: number };
  recentEffects: readonly CombatStepResult[];
}
export interface Encounter {
  readonly simulation: Simulation;
  step(): EncounterStep;
  setAim(x: number, settings?: ChuteSettings): void;
  drop(x: number, settings?: ChuteSettings): boolean;
  cancelDrops(): void;
  setPaused(paused: boolean): void;
  snapshot(): EncounterSnapshot;
  preview(): readonly FeedTray[];
  reset(tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>, entry?: EncounterEntry): void;
  dispose(): void;
}
