import type { EncounterStep } from "../src/combat/types";
import type { Run, RunSnapshot } from "../src/run/types";
import { INTER_ENCOUNTER_HEAL, VICTORY_REWARD } from "../src/run/catalog";
import { PhysicalEvidence, stableStats } from "./combat-evidence";
import { canonicalJson, digest } from "./combat-protocol";

/** IDs are process-lifetime counters, not random state. Preserve allocation order, not offsets. */
export class RunIdentity {
  private readonly physical = new Map<number, number>();
  private readonly stock = new Map<number, number>();
  constructor(private readonly serialBaseline: number) {}
  private id(value: number): number {
    const table = value < 0 ? this.stock : this.physical;
    if (!Number.isSafeInteger(value) || value === 0) throw new Error(`Invalid physical identity ${value}`);
    let normalized = table.get(value);
    if (normalized === undefined) {
      normalized = (table.size + 1) * (value < 0 ? -1 : 1);
      table.set(value, normalized);
    }
    return normalized;
  }
  observe(run: Run, step?: EncounterStep): void {
    const positive = [...run.simulation.coins.keys(), ...run.simulation.gizmos.keys(), ...(step?.events.map((event) => event.id) ?? []), ...(step?.gizmoEvents.map((event) => event.id) ?? [])];
    const negative: number[] = [];
    for (const tray of run.encounter.preview()) {
      negative.push(...tray.coins.map((coin) => coin.id));
      for (const member of tray.burst.cohort) {
        negative.push(member.stockId);
        if (member.admittedId !== null) positive.push(member.admittedId);
      }
    }
    for (const id of positive.sort((a, b) => a - b)) this.id(id);
    for (const id of negative.sort((a, b) => b - a)) this.id(id);
  }
  normalize<T>(value: T): T {
    const visit = (item: unknown, key: string): unknown => {
      if (typeof item === "number") {
        if (["id", "stockId", "admittedId", "chainRootId"].includes(key)) return this.id(item);
        if (key === "completionSerial" || key === "serial") return item - this.serialBaseline;
      }
      if (Array.isArray(item)) return item.map((child) => visit(child, ""));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).filter(([name]) => name !== "physicsMs")
        .map(([name, child]) => [name, visit(child, name)]));
      return item;
    };
    return visit(value, "") as T;
  }
}

export function physicalState(run: Run): unknown {
  return { coins: [...run.simulation.coins.values()].sort((a, b) => a.id - b.id),
    gizmos: [...run.simulation.gizmos.values()].sort((a, b) => a.id - b.id),
    stats: stableStats(run.simulation.stats()), tuning: run.simulation.tuning,
    feeds: run.encounter.preview(), streams: run.encounter.snapshot().feedStreams };
}
export function tickState(run: Run): unknown {
  const snapshot = run.snapshot();
  const { recentEffects: _history, ...encounter } = snapshot.encounter;
  return { ...snapshot, encounter, stats: stableStats(run.simulation.stats()), feeds: run.encounter.preview(), gizmos: [...run.simulation.gizmos.values()] };
}

export class RunEvidence {
  private readonly physical = new PhysicalEvidence();
  private readonly positiveKinds = new Map<number, "coin" | "gizmo">();
  private readonly gizmos = new Set<number>();
  private readonly terminalGizmos = new Set<number>();
  private collected = 0;
  private lost = 0;
  private gizmoPaid = 0;
  private readonly rows = new Set<string>();
  private acceptedRounds = 0;
  private previous: RunSnapshot;
  constructor(run: Run) { this.previous = run.snapshot(); }
  private remember(id: number, kind: "coin" | "gizmo"): void {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Admitted coin/gizmo IDs must be positive integers");
    const known = this.positiveKinds.get(id);
    if (known && known !== kind) throw new Error(`Coin/gizmo identity collision: ${id}`);
    this.positiveKinds.set(id, kind);
  }
  inspect(run: Run, step: EncounterStep): void {
    this.physical.inspect(run.simulation, step.events, step.combat, step.admissions);
    for (const id of run.simulation.coins.keys()) this.remember(id, "coin");
    for (const event of step.events) this.remember(event.id, "coin");
    for (const gizmo of run.simulation.gizmos.values()) {
      this.remember(gizmo.id, "gizmo");
      if (this.terminalGizmos.has(gizmo.id)) throw new Error("Terminal gizmo remained active");
      if (![...Object.values(gizmo.position), ...Object.values(gizmo.rotation)].every(Number.isFinite)) throw new Error("Nonfinite gizmo pose");
      this.gizmos.add(gizmo.id);
    }
    let paid = 0;
    for (const event of step.gizmoEvents) {
      this.remember(event.id, "gizmo");
      this.gizmos.add(event.id);
      if (this.terminalGizmos.has(event.id)) throw new Error("Duplicate gizmo terminal event");
      this.terminalGizmos.add(event.id);
      if (run.simulation.gizmos.has(event.id)) throw new Error("Resolved gizmo remained active");
      if (!Object.values(event.position).every(Number.isFinite)) throw new Error("Nonfinite gizmo terminal pose");
      if (event.kind === "collected") {
        if (event.currency !== 3) throw new Error("Bell collection payout must be exactly three");
        paid += event.currency;
        this.collected++;
      } else {
        if (event.reason !== "out-of-bounds") throw new Error(`Invalid gizmo removal: ${event.reason}`);
        this.lost++;
      }
    }
    this.gizmoPaid += paid;
    const stats = run.simulation.stats().gizmos;
    if (stats.spawned !== this.gizmos.size || stats.active !== run.simulation.gizmos.size || stats.collected !== this.collected || stats.lost !== this.lost ||
      stats.spawned !== stats.active + stats.collected + stats.lost || this.gizmos.size > 1 || this.gizmoPaid !== this.collected * 3)
      throw new Error("Separate gizmo conservation/payout failed");
    for (const fragment of step.admissions) {
      const key = `${fragment.action}/${fragment.round}`;
      if (fragment.newRound === this.rows.has(key)) throw new Error("Admission fragment has inconsistent newRound identity");
      if (fragment.newRound) { this.rows.add(key); this.acceptedRounds++; }
    }
    const next = run.snapshot();
    if (next.encounter.acceptedRounds !== this.acceptedRounds) throw new Error("Accepted rounds disagree with first-fragment evidence");
    const services = next.completionServices.slice(this.previous.completionServices.length);
    if (services.length > 1) throw new Error("Completion serviced more than once per tick");
    let reward = 0;
    for (const service of services) {
      if (next.completionServices.filter((other) => other.serial === service.serial).length !== 1 || service.encounterIndex !== next.encounterIndex)
        throw new Error("Duplicate or misplaced completion service");
      const victory = next.encounter.result === "victory";
      reward = victory ? VICTORY_REWARD : 0;
      if (service.reward !== reward) throw new Error("Incorrect completion payout");
      const healing = victory && next.encounterIndex + 1 < next.encounterCount;
      if (healing !== (service.recovery !== null)) throw new Error("Recovery applied outside an ordinary victory");
      if (service.recovery && (service.recovery.offered !== INTER_ENCOUNTER_HEAL ||
        service.recovery.used !== Math.min(INTER_ENCOUNTER_HEAL, next.maxHp - next.encounter.playerHp) ||
        service.recovery.used + service.recovery.wasted !== service.recovery.offered)) throw new Error("Recovery accounting diverged");
    }
    const coinCurrency = step.combat.effects.reduce((total, effect) => total + effect.currency, 0);
    if (step.combat.delta.currencyGained !== coinCurrency + paid) throw new Error("Coin/gizmo batch payout diverged");
    const earned = coinCurrency + paid + reward;
    if (next.earnedCurrency - this.previous.earnedCurrency !== earned || next.currency - this.previous.currency !== earned)
      throw new Error("Run currency does not equal coin, gizmo, and completion evidence");
    if (next.currency !== next.earnedCurrency - next.spentCurrency) throw new Error("Run earned/spent currency conservation failed");
    this.previous = next;
  }
}

export function assertTerminalFrozen(run: Run): void {
  if (run.snapshot().phase === "encounter") return;
  const before = canonicalJson({ snapshot: run.snapshot(), physical: physicalState(run) });
  for (let repeat = 0; repeat < 2; repeat++) {
    const step = run.step();
    if (step.events.length || step.gizmoEvents.length || step.admissions.length || step.waveEvents.length || step.combat.effects.length)
      throw new Error("Terminal run emitted new events");
    if (run.drop(0)) throw new Error("Terminal run accepted an action");
  }
  if (canonicalJson({ snapshot: run.snapshot(), physical: physicalState(run) }) !== before) throw new Error("Terminal run changed state or serviced completion twice");
}
export function physicalDigest(run: Run, identity: RunIdentity): string {
  return digest(identity.normalize({ run: run.snapshot(), physical: physicalState(run) }));
}
