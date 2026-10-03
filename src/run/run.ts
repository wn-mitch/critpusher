import { BOMB_DAMAGE, DEFAULT_ENCOUNTER_CONFIG, emptyTotals } from "../combat/config";
import { createEncounter } from "../combat/encounter";
import type { Encounter, EncounterSnapshot, EncounterStep } from "../combat/types";
import type { ChuteSettings } from "../chutes";
import type { Tuning } from "../contracts";
import { deriveSeed } from "../random";
import { DEFAULT_TUNING, sanitizeTuning } from "../simulation/config";
import { ENCOUNTERS, INTER_ENCOUNTER_HEAL, STARTERS, VICTORY_REWARD } from "./catalog";
import { resolveBuild } from "./modifiers";
import { calculatePurchase } from "./purchases";
import type { BaseEffects, CompletionService, PurchaseRequest, PurchaseResult, Recovery, Run, RunInventory, RunPhase, RunPurchase, RunSnapshot, StarterId } from "./types";

const BASE_EFFECTS: BaseEffects = {
  swordDamage: DEFAULT_ENCOUNTER_CONFIG.swordDamage,
  skullDamage: DEFAULT_ENCOUNTER_CONFIG.skullDamage,
  potionHealing: DEFAULT_ENCOUNTER_CONFIG.potionHealing,
  bombDamage: BOMB_DAMAGE,
};
const OPENING_SEED_TAG = 0x4f50454e;

class PusherRun implements Run {
  private phase: RunPhase = "starter";
  private inventory: RunInventory = { playerChutes: [], stickers: [], effectLevels: { temperedSwords: 0, restorativeBrew: 0 } };
  private selectedStarterId: StarterId | null = null;
  private playerHp = 100;
  private currency = 0;
  private encounterIndex = 0;
  private completedEncounters = 0;
  private earnedCurrency = 0;
  private spentCurrency = 0;
  private purchases: RunPurchase[] = [];
  private recoveries: Recovery[] = [];
  private completionServices: CompletionService[] = [];
  private readonly serviced = new Set<number>();
  private paused = false;
  private disposed = false;
  private error: string | null = null;

  constructor(readonly encounter: Encounter, private baseTuning: Tuning) {}
  get simulation() { return this.encounter.simulation; }

  chooseStarter(id: StarterId): boolean {
    if (this.disposed || this.phase !== "starter") return false;
    const kit = STARTERS.find((starter) => starter.id === id);
    if (!kit) return false;
    this.inventory = {
      playerChutes: [{ id: "player-0", bag: [...kit.bag] }],
      stickers: [kit.sticker], effectLevels: { temperedSwords: 0, restorativeBrew: 0 },
    };
    this.selectedStarterId = kit.id;
    return this.enterEncounter();
  }

  previewPurchase(request: PurchaseRequest) {
    return calculatePurchase(this.disposed ? "error" : this.phase, this.inventory, this.currency,
      request, this.encounterTuning(), BASE_EFFECTS).preview;
  }
  purchase(request: PurchaseRequest): PurchaseResult {
    const { preview, inventory } = calculatePurchase(this.disposed ? "error" : this.phase, this.inventory, this.currency,
      request, this.encounterTuning(), BASE_EFFECTS);
    if (!preview.allowed) return { success: false, code: preview.blocker!, preview };
    this.inventory = inventory;
    this.currency = preview.remainingMoney;
    this.spentCurrency += preview.cost;
    this.purchases.push({ encounterIndex: this.encounterIndex, request: structuredClone(request), cost: preview.cost });
    return { success: true, preview };
  }
  continueRun(): boolean {
    if (this.disposed || this.phase !== "shop") return false;
    this.encounterIndex++;
    return this.enterEncounter();
  }
  restart(seed?: number): void {
    if (this.disposed) return;
    this.baseTuning = sanitizeTuning(this.baseTuning, seed === undefined ? undefined : { seed });
    this.phase = "starter";
    this.inventory = { playerChutes: [], stickers: [], effectLevels: { temperedSwords: 0, restorativeBrew: 0 } };
    this.selectedStarterId = null;
    this.playerHp = 100;
    this.currency = 0;
    this.encounterIndex = 0;
    this.completedEncounters = 0;
    this.earnedCurrency = 0;
    this.spentCurrency = 0;
    this.purchases = [];
    this.recoveries = [];
    this.completionServices = [];
    this.serviced.clear();
    this.error = null;
    // The dormant encounter's diagnostic default is not owned run inventory.
    this.encounter.reset({ ...this.baseTuning, density: 0 }, DEFAULT_ENCOUNTER_CONFIG);
    this.encounter.setPaused(this.paused);
  }
  step(): EncounterStep {
    if (this.disposed || this.phase !== "encounter") return this.idleStep();
    const result = this.encounter.step();
    const snapshot = this.encounter.snapshot();
    this.earnedCurrency += snapshot.currency - this.currency;
    this.currency = snapshot.currency;
    this.playerHp = snapshot.playerHp;
    if (snapshot.phase === "error") {
      this.phase = "error";
      this.error = snapshot.error;
    } else if (snapshot.phase === "finished") this.serviceCompletion(snapshot);
    return result;
  }
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.paused = paused;
    this.encounter.setPaused(paused);
  }
  setTuning(patch: Partial<Tuning>): void {
    if (this.disposed) return;
    this.baseTuning = sanitizeTuning(this.baseTuning, patch);
    this.simulation.configure(resolveBuild(this.inventory, this.encounterTuning(), BASE_EFFECTS).tuning);
  }
  drop(x: number, settings?: ChuteSettings): boolean {
    return !this.disposed && this.phase === "encounter" && this.encounter.drop(x, settings);
  }
  snapshot(): RunSnapshot {
    return structuredClone({
      ...this.inventory, phase: this.phase, seed: this.baseTuning.seed,
      playerHp: this.playerHp, maxHp: 100, currency: this.currency,
      selectedStarterId: this.selectedStarterId, encounterIndex: this.encounterIndex,
      encounterCount: ENCOUNTERS.length, completedEncounters: this.completedEncounters,
      earnedCurrency: this.earnedCurrency, spentCurrency: this.spentCurrency,
      purchases: this.purchases, recoveries: this.recoveries, completionServices: this.completionServices,
      encounter: this.encounter.snapshot(), build: resolveBuild(this.inventory, this.encounterTuning(), BASE_EFFECTS), error: this.error,
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.encounter.dispose();
  }

  private encounterTuning(): Tuning {
    return { ...this.baseTuning, seed: deriveSeed(this.baseTuning.seed, this.encounterIndex, OPENING_SEED_TAG) };
  }
  private enterEncounter(): boolean {
    const build = resolveBuild(this.inventory, this.encounterTuning(), BASE_EFFECTS);
    const config = ENCOUNTERS[this.encounterIndex]!.config;
    try {
      this.encounter.reset(build.tuning, {
        ...config, swordDamage: build.swordDamage, skullDamage: build.skullDamage, potionHealing: build.potionHealing,
      }, { playerHp: this.playerHp, currency: this.currency, playerChutes: this.inventory.playerChutes, build });
      this.encounter.setPaused(this.paused);
      this.phase = "encounter";
      this.error = null;
      return true;
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
      return false;
    }
  }
  private serviceCompletion(snapshot: EncounterSnapshot): void {
    if (this.serviced.has(snapshot.completionSerial)) return;
    this.serviced.add(snapshot.completionSerial);
    const service: CompletionService = { serial: snapshot.completionSerial, encounterIndex: this.encounterIndex, reward: 0, recovery: null };
    if (snapshot.result !== "victory") this.phase = "lost";
    else {
      this.completedEncounters++;
      this.currency += VICTORY_REWARD;
      this.earnedCurrency += VICTORY_REWARD;
      service.reward = VICTORY_REWARD;
      if (this.encounterIndex + 1 === ENCOUNTERS.length) this.phase = "won";
      else {
        const used = Math.min(INTER_ENCOUNTER_HEAL, 100 - this.playerHp);
        service.recovery = { encounterIndex: this.encounterIndex, offered: INTER_ENCOUNTER_HEAL, used, wasted: INTER_ENCOUNTER_HEAL - used };
        this.playerHp += used;
        this.recoveries.push(service.recovery);
        this.phase = "shop";
      }
    }
    this.completionServices.push(service);
  }
  private idleStep(): EncounterStep {
    const snapshot = this.encounter.snapshot();
    return {
      events: [], gizmoEvents: [], admissions: [], waveEvents: [],
      combat: { effects: [], delta: emptyTotals(), state: {
        playerHp: snapshot.playerHp, enemies: snapshot.enemies, currency: snapshot.currency,
        result: snapshot.result, totals: snapshot.totals,
        combo: snapshot.combo,
      } },
    };
  }
}

export async function createRun(tuning?: Partial<Tuning>): Promise<Run> {
  const base = sanitizeTuning(DEFAULT_TUNING, tuning);
  const encounter = await createEncounter({ ...base, density: 0 });
  return new PusherRun(encounter, base);
}
