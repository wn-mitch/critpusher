import { DEFAULT_CHUTES, sanitizeChutes, type ChuteSettings } from "../chutes";
import type { NativeFeedAdmission, Simulation, Tuning } from "../contracts";
import { createSimulation } from "../simulation";
import { createDropSequence } from "../feedback/drop-sequence";
import { encounterConfig, emptyTotals, initialCombatState, enemyStates, validateEntry } from "./config";
import { EncounterFeeds } from "./encounter-feeds";
import { resolveCombatStep } from "./reducer";
import type { CombatState, CombatStepResult, Encounter, EncounterConfig, EncounterEntry, EncounterPhase,
  EncounterSnapshot, EncounterStep, FeedLayout, FeedTray, RoundAdmission, WaveEvent } from "./types";

const FIXED_HZ = 60;
const MIN_LOADING_TICKS = 720;
const MAX_LOADING_TICKS = 1440;
const MAX_RECENT_EFFECTS = 6;
const OPENING_ERROR = "Opening load incomplete; reseed the pile";
interface ScheduledDrops { action: number; aimX: number; layout: readonly FeedLayout[]; nextRound: number }
interface ActiveBurst {
  action: number;
  aimX: number;
  roundBase: number;
  startedRows: Set<number>;
}
const emptyMix = () => ({ gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 });
function emptyCombat(state: CombatState): CombatStepResult {
  return { state: structuredClone(state), delta: emptyTotals(), effects: [] };
}

class PusherEncounter implements Encounter {
  private phase: EncounterPhase = "loading";
  private paused = false;
  private error: string | null = null;
  private combat: CombatState;
  private feeds: EncounterFeeds;
  private entry: EncounterEntry;
  private aimX = 0;
  private chuteSettings: ChuteSettings = { ...DEFAULT_CHUTES };
  private tick = 0;
  private waveIndex = 0;
  private loadingTicks = 0;
  private loadingCollected = emptyMix();
  private loadingLost = emptyMix();
  private loadingDetonated = 0;
  private acceptedActions = 0;
  private acceptedRounds = 0;
  private interruptedRounds = 0;
  private completionSerial = 0;
  private scheduled: ScheduledDrops | null = null;
  private readonly dropSequence = createDropSequence();
  private activeBurst: ActiveBurst | null = null;
  private deferredFeedSync = false;
  private lastAdmission: RoundAdmission | null = null;
  private pendingAdmissions: RoundAdmission[] = [];
  private recentEffects: CombatStepResult[] = [];
  private disposed = false;

  constructor(readonly simulation: Simulation, private config: EncounterConfig, entry?: EncounterEntry) {
    this.entry = validateEntry(config, entry);
    this.combat = initialCombatState(config, this.entry);
    this.feeds = new EncounterFeeds(simulation.tuning.seed, this.entry.playerChutes, config.waves[0]!);
    simulation.setBombsActive(true);
    simulation.configureGizmo(this.entry.build?.gizmo ?? null);
  }

  step(): EncounterStep {
    if (this.disposed || this.paused || this.phase === "finished" || this.phase === "error") {
      return { events: [], gizmoEvents: [], combat: emptyCombat(this.combat), admissions: [], waveEvents: [] };
    }
    if (this.phase === "active") this.advanceScheduledDrops();
    const admissions = this.pendingAdmissions;
    this.pendingAdmissions = [];
    this.simulation.step();
    this.tick++;
    const nativeAdmissions = this.simulation.drainFeedAdmissions();
    if (nativeAdmissions.length) admissions.push(...this.processBurstAdmissions(nativeAdmissions));
    this.settleBurstSchedule();
    const events = this.simulation.drainEvents();
    const gizmoEvents = this.simulation.drainGizmoEvents();
    const wasLoading = this.phase === "loading";
    if (wasLoading) {
      this.loadingTicks++;
      for (const event of events) {
        if (event.kind === "collected") this.loadingCollected[event.type]++;
        else if (event.kind === "lost") this.loadingLost[event.type]++;
        else this.loadingDetonated++;
      }
    }
    const before = this.combat.enemies;
    const combat = resolveCombatStep(
      this.combat,
      events,
      this.config,
      this.entry.build,
      this.tick,
      gizmoEvents,
    );
    this.combat = combat.state;
    if (combat.effects.length) {
      this.recentEffects.push(structuredClone(combat));
      if (this.recentEffects.length > MAX_RECENT_EFFECTS) this.recentEffects.shift();
    }
    const waveEvents: WaveEvent[] = [];
    const dead = this.combat.enemies.filter((enemy) =>
      enemy.hp === 0 && before.find(({ id }) => id === enemy.id)!.hp > 0);
    if (dead.length) waveEvents.push({
      kind: "died",
      enemyIds: dead.map(({ id }) => id),
      waveIndex: this.waveIndex,
      tick: this.tick,
    });
    if (this.combat.playerHp === 0) this.finish();
    else if (this.combat.enemies.every(({ hp }) => hp === 0)) {
      if (this.waveIndex + 1 === this.config.waves.length) this.finish();
      else {
        this.drainNativeBurstAdmissions();
        this.interruptedRounds += this.pendingScheduledRounds();
        this.cancelDrops();
        this.waveIndex++;
        const next = this.config.waves[this.waveIndex]!;
        this.combat = { ...this.combat, result: null, enemies: enemyStates(next) };
        this.feeds.enterWave(next, this.waveIndex);
        waveEvents.push({
          kind: "entered",
          enemyIds: next.enemies.map(({ id }) => id),
          waveIndex: this.waveIndex,
          tick: this.tick,
        });
        this.syncFeed();
      }
    } else if (dead.length) {
      // Keep reserved offsets; only prune the deceased enemy's captured participation.
      if (this.scheduled) this.scheduled.layout = this.scheduled.layout.map((lane) =>
        dead.some(({ chuteId }) => chuteId === lane.id) ? { ...lane, enabled: false, preview: [] } : lane);
      this.syncFeed();
      this.settleBurstSchedule();
    }
    if (wasLoading && this.phase === "loading") this.advanceLoading();
    // The batch reports exactly the enemies it could hit, not unborn reinforcements.
    return {
      events: structuredClone(events),
      gizmoEvents: structuredClone(gizmoEvents),
      combat: structuredClone(combat),
      admissions: structuredClone(admissions),
      waveEvents,
    };
  }

  setAim(x: number, settings?: ChuteSettings): void {
    if (this.disposed || !Number.isFinite(x) || this.phase === "finished" || this.phase === "error") return;
    this.aimX = x;
    if (settings) this.chuteSettings = sanitizeChutes(settings, this.simulation.tuning);
    if (!this.scheduled) this.syncFeed();
  }

  drop(x: number, settings: ChuteSettings = this.chuteSettings): boolean {
    if (this.disposed || this.paused || this.phase !== "active" || this.scheduled || this.simulation.tuning.dropRate <= 0) return false;
    if (Number.isFinite(x)) this.aimX = x;
    this.chuteSettings = sanitizeChutes(settings, this.simulation.tuning);
    const layout = this.feeds.layout(this.combat.enemies, this.simulation.tuning, this.aimX, this.chuteSettings);
    const set: ScheduledDrops = { action: this.acceptedActions + 1, aimX: layout[0]!.x, layout, nextRound: 1 };
    this.scheduled = set;
    this.syncFeed();
    const accepted = this.dropSequence.start(this.chuteSettings.dropsPerAction,
      Math.ceil(this.chuteSettings.dropDelay * FIXED_HZ), this.tick, () => this.releaseRound(set));
    if (!accepted) { this.scheduled = null; return false; }
    this.acceptedActions++;
    this.settleBurstSchedule();
    return true;
  }

  cancelDrops(): void {
    this.drainNativeBurstAdmissions();
    this.dropSequence.cancel();
    this.scheduled = null;
    this.activeBurst = null;
    this.simulation.cancelFeedBurst();
    this.deferredFeedSync = true;
    if (!this.disposed && this.phase !== "finished" && this.phase !== "error") this.syncFeed();
  }
  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.paused = paused;
    if (paused) this.cancelDrops();
  }

  snapshot(): EncounterSnapshot {
    const enemies = this.combat.enemies;
    const remainingRounds = this.pendingScheduledRounds();
    return structuredClone({ phase: this.phase, result: this.combat.result,
      playerHp: this.combat.playerHp, playerMaxHp: this.config.playerMaxHp, enemies,
      combo: this.combat.combo, build: this.entry.build ?? null,
      frontEnemyId: enemies.find(({ hp }) => hp > 0)?.id ?? null,
      waveIndex: this.waveIndex, waveCount: this.config.waves.length,
      livingWaveHp: enemies.reduce((sum, { hp }) => sum + hp, 0), currency: this.combat.currency,
      acceptedActions: this.acceptedActions, acceptedRounds: this.acceptedRounds,
      queuedRounds: remainingRounds, remainingRounds,
      interruptedRounds: this.interruptedRounds, completionSerial: this.completionSerial, tick: this.tick,
      chuteSlots: this.feeds.slots(enemies), playerChutes: this.entry.playerChutes,
      chuteSettings: this.chuteSettings, feedStreams: this.feeds.snapshot(),
      config: this.config, totals: this.combat.totals, lastAdmission: this.lastAdmission,
      paused: this.paused, error: this.error,
      loading: { ticks: this.loadingTicks, collectedByType: this.loadingCollected, lostByType: this.loadingLost, detonated: this.loadingDetonated },
      recentEffects: this.recentEffects });
  }
  preview(): readonly FeedTray[] { return this.simulation.feedTrays(); }

  reset(tuning?: Partial<Tuning>, patch?: Partial<EncounterConfig>, entry?: EncounterEntry): void {
    if (this.disposed) return;
    const config = encounterConfig(this.config, patch);
    // Validate ownership before disposing the current native world.
    const validatedEntry = validateEntry(config, entry);
    this.simulation.cancelFeedBurst();
    this.simulation.reset(tuning, config);
    this.config = config;
    this.entry = validatedEntry;
    this.phase = "loading";
    this.error = null;
    this.combat = initialCombatState(config, this.entry);
    this.feeds = new EncounterFeeds(this.simulation.tuning.seed, this.entry.playerChutes, config.waves[0]!);
    this.aimX = 0;
    this.chuteSettings = { ...DEFAULT_CHUTES };
    this.tick = 0;
    this.waveIndex = 0;
    this.loadingTicks = 0;
    this.loadingCollected = emptyMix();
    this.loadingLost = emptyMix();
    this.loadingDetonated = 0;
    this.acceptedActions = 0;
    this.acceptedRounds = 0;
    this.interruptedRounds = 0;
    this.scheduled = null;
    this.dropSequence.cancel();
    this.activeBurst = null;
    this.deferredFeedSync = false;
    this.lastAdmission = null;
    this.pendingAdmissions = [];
    this.recentEffects = [];
    this.simulation.setBombsActive(true);
    this.simulation.configureGizmo(this.entry.build?.gizmo ?? null);
  }
  dispose(): void {
    if (this.disposed) return;
    this.cancelDrops();
    this.disposed = true;
    this.simulation.dispose();
  }

  private syncFeed(): void {
    if (this.phase !== "active") return;
    const captured = this.scheduled;
    const current = this.feeds.layout(this.combat.enemies, this.simulation.tuning,
      captured?.aimX ?? this.aimX, this.chuteSettings);
    const layout = captured ? current.map((lane) => ({ ...lane,
      x: captured.layout.find(({ id }) => id === lane.id)?.x ?? lane.x })) : current;
    this.simulation.setFeedLayout(layout);
  }
  private advanceScheduledDrops(): void {
    const scheduled = this.scheduled;
    if (!scheduled) return;
    this.dropSequence.advance(this.tick, () => this.releaseRound(scheduled));
    this.settleBurstSchedule();
  }

  private releaseRound(scheduled: ScheduledDrops): boolean | "waiting" {
    if (this.simulation.tuning.dropRate <= 0) return false;
    if (this.entry.build?.releaseMode === "dump") {
      if (!this.simulation.startFeedBurst()) return "waiting";
      this.activeBurst = {
        action: scheduled.action,
        aimX: scheduled.aimX,
        roundBase: scheduled.nextRound,
        startedRows: new Set(),
      };
      scheduled.nextRound += 5;
      return true;
    }
    const lanes = this.simulation.feedTrays().filter(({ enabled }) => enabled);
    const types = lanes.map(({ preview }) => preview[0]!);
    const ids = this.simulation.releaseFeed();
    if (!ids) return "waiting";
    const coins = ids.map((id, index) => ({
      id,
      chuteId: lanes[index]!.id,
      type: types[index]!,
    }));
    for (const coin of coins) this.feeds.consume(coin.chuteId, coin.type);
    const admission: RoundAdmission = {
      accepted: true,
      newRound: true,
      tick: this.tick,
      action: scheduled.action,
      round: scheduled.nextRound++,
      aimX: scheduled.aimX,
      coins,
    };
    this.lastAdmission = admission;
    this.pendingAdmissions.push(admission);
    this.commitRoundPressure();
    this.syncFeed();
    return true;
  }

  private drainNativeBurstAdmissions(): void {
    const nativeAdmissions = this.simulation.drainFeedAdmissions();
    if (nativeAdmissions.length === 0) return;
    if (!this.activeBurst) throw new Error("Native burst admission has no captured encounter action");
    this.pendingAdmissions.push(...this.processBurstAdmissions(nativeAdmissions));
  }

  private processBurstAdmissions(nativeAdmissions: readonly NativeFeedAdmission[]): RoundAdmission[] {
    const burst = this.activeBurst;
    if (!burst) throw new Error("Native burst admission has no captured encounter action");
    const byRow = new Map<number, NativeFeedAdmission[]>();
    for (const admission of nativeAdmissions) {
      if (!Number.isInteger(admission.row) || admission.row < 1 || admission.row > 5)
        throw new Error(`Native burst row out of range: ${admission.row}`);
      const row = byRow.get(admission.row);
      if (row) row.push(admission);
      else byRow.set(admission.row, [admission]);
    }
    const fragments: RoundAdmission[] = [];
    for (const [row, nativeCoins] of [...byRow].sort(([left], [right]) => left - right)) {
      const coins = nativeCoins.map(({ chuteId, id, type }) => ({ chuteId, id, type }));
      for (const coin of coins) this.feeds.consume(coin.chuteId, coin.type);
      const newRound = !burst.startedRows.has(row);
      if (newRound) {
        burst.startedRows.add(row);
        this.commitRoundPressure();
      }
      const fragment: RoundAdmission = {
        accepted: true,
        newRound,
        tick: this.tick,
        action: burst.action,
        round: burst.roundBase + row - 1,
        aimX: burst.aimX,
        coins,
      };
      fragments.push(fragment);
      this.lastAdmission = fragment;
    }
    this.syncFeed();
    return fragments;
  }

  private commitRoundPressure(): void {
    this.acceptedRounds++;
    this.combat = {
      ...this.combat,
      enemies: this.combat.enemies.map((enemy) => enemy.hp > 0
        ? { ...enemy, admittedRounds: enemy.admittedRounds + 1 }
        : enemy),
    };
    this.feeds.escalate(this.combat.enemies);
  }

  private settleBurstSchedule(): void {
    const burstBusy = this.simulation.feedTrays().some(({ burst }) => burst.phase !== "idle");
    if (this.activeBurst && !burstBusy) this.activeBurst = null;
    if (this.scheduled && this.dropSequence.remaining === 0 && !this.activeBurst && !burstBusy) {
      this.scheduled = null;
      this.deferredFeedSync = true;
    }
    if (this.deferredFeedSync && !burstBusy) {
      this.deferredFeedSync = false;
      this.syncFeed();
    }
  }

  private pendingScheduledRounds(): number {
    if (this.entry.build?.releaseMode !== "dump") return this.dropSequence.remaining;
    return this.dropSequence.remaining * 5 +
      (this.activeBurst ? 5 - this.activeBurst.startedRows.size : 0);
  }

  private finish(): void {
    this.drainNativeBurstAdmissions();
    this.interruptedRounds += this.pendingScheduledRounds();
    // Reconcile dead magazines while native hardware updates are still permitted.
    this.cancelDrops();
    this.simulation.cancelRain();
    this.phase = "finished";
    this.completionSerial++;
  }
  private advanceLoading(): void {
    if (this.loadingTicks < MIN_LOADING_TICKS) return;
    const periodTicks = Math.max(1, Math.round(this.simulation.tuning.period * FIXED_HZ));
    const isBoundary = (this.loadingTicks - MIN_LOADING_TICKS) % periodTicks === 0;
    const stats = this.simulation.stats();
    if (stats.pendingRain === 0 && stats.gizmos.pending === 0 &&
      (isBoundary || this.loadingTicks === MAX_LOADING_TICKS)) {
      this.phase = "active";
      this.syncFeed();
    } else if (this.loadingTicks >= MAX_LOADING_TICKS) {
      this.phase = "error";
      this.error = OPENING_ERROR;
      this.cancelDrops();
      this.simulation.cancelRain();
    }
  }
}

export async function createEncounter(tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>, entry?: EncounterEntry): Promise<Encounter> {
  const resolvedConfig = encounterConfig(undefined, config);
  const resolvedEntry = validateEntry(resolvedConfig, entry);
  const simulation = await createSimulation(tuning, resolvedConfig);
  return new PusherEncounter(simulation, resolvedConfig, resolvedEntry);
}
export { OPENING_ERROR };
export type { CombatEffect, CombatResult, CombatState, CombatStepResult, CombatTotals,
  Encounter, EncounterConfig, EncounterPhase, EncounterSnapshot, EncounterStep, FeedTray, RoundAdmission } from "./types";
