import type { ChuteSettings } from "../chutes";
import type { CoinType, Simulation, Tuning } from "../contracts";
import type { Encounter, EncounterSnapshot, EncounterStep, PlayerChuteDefinition } from "../combat/types";
import type { ResolvedBuild } from "./modifiers";

export type RunPhase = "starter" | "encounter" | "shop" | "won" | "lost" | "error";
export type StarterId = "collector" | "swarm" | "volley";
export type StickerId = "collected-only" | "miniature" | "magazine-dump" | "combo-bell";
export interface EffectLevels { temperedSwords: number; restorativeBrew: number }
export interface RunInventory {
  playerChutes: readonly PlayerChuteDefinition[];
  stickers: readonly StickerId[];
  effectLevels: EffectLevels;
}
export interface StarterDefinition { id: StarterId; label: string; bag: readonly CoinType[]; sticker: StickerId; description: string; tradeoff: string }
export type CompositionOfferId = "sword-pack" | "potion-pack" | "gold-pack" | "diamond-mint";
export type GlobalOfferId = "tempered-swords" | "restorative-brew" | StickerId;
export type OfferId = CompositionOfferId | GlobalOfferId | "extra-chute";
export type PurchaseRequest =
  | { offerId: CompositionOfferId; chuteId: string; replaceType: CoinType }
  | { offerId: "extra-chute"; chuteId: string }
  | { offerId: GlobalOfferId };
export type PurchaseFailure = "not-in-shop" | "unknown-offer" | "unknown-chute" | "invalid-replacement" | "insufficient-currency" | "limit-reached" | "already-owned";
export type BagCounts = Record<CoinType, number>;
export interface PurchasePreview {
  request: PurchaseRequest;
  allowed: boolean;
  blocker: PurchaseFailure | null;
  cost: number;
  remainingMoney: number;
  currentCounts: readonly { chuteId: string; counts: BagCounts }[];
  resultingCounts: readonly { chuteId: string; counts: BagCounts }[];
  currentBuild: ResolvedBuild;
  resultingBuild: ResolvedBuild;
  resultingChuteCount: number;
  resultingStickerCount: number;
}
export type PurchaseResult = { success: true; preview: PurchasePreview } | { success: false; code: PurchaseFailure; preview: PurchasePreview };
export interface ShopOffer { id: OfferId; label: string; price: number; description: string }
export interface RunPurchase { encounterIndex: number; request: PurchaseRequest; cost: number }
export interface Recovery { encounterIndex: number; offered: number; used: number; wasted: number }
export interface CompletionService { serial: number; encounterIndex: number; reward: number; recovery: Recovery | null }
export interface RunSnapshot extends RunInventory {
  phase: RunPhase;
  seed: number;
  playerHp: number;
  maxHp: number;
  currency: number;
  selectedStarterId: StarterId | null;
  encounterIndex: number;
  encounterCount: number;
  completedEncounters: number;
  earnedCurrency: number;
  spentCurrency: number;
  purchases: readonly RunPurchase[];
  recoveries: readonly Recovery[];
  completionServices: readonly CompletionService[];
  encounter: EncounterSnapshot;
  build: ResolvedBuild;
  error: string | null;
}
export interface Run {
  readonly encounter: Encounter;
  readonly simulation: Simulation;
  chooseStarter(id: StarterId): boolean;
  previewPurchase(request: PurchaseRequest): PurchasePreview;
  purchase(request: PurchaseRequest): PurchaseResult;
  continueRun(): boolean;
  restart(seed?: number): void;
  step(): EncounterStep;
  setPaused(paused: boolean): void;
  setTuning(patch: Partial<Tuning>): void;
  drop(x: number, settings?: ChuteSettings): boolean;
  snapshot(): RunSnapshot;
  dispose(): void;
}
export interface BaseEffects { swordDamage: number; skullDamage: number; potionHealing: number; bombDamage: number }
export interface RunTuning { base: Tuning }
