import { COIN_TYPES, type CoinEvent, type CoinType, type Simulation, type SimulationStats } from "../src/contracts";
import type {
  CombatEffect,
  CombatStepResult,
  Encounter,
  EncounterConfig,
  EncounterSnapshot,
  FeedTray,
  RoundAdmission,
} from "../src/combat/types";
import type { ChuteStreamSnapshot } from "../src/combat/feed";
import type { FightLedgerEntry, TypeCounts } from "./combat-contracts";
import { digest } from "./combat-protocol";

export const CYCLE_TICKS = 144;
export const FIXED_HZ = 60;

export function emptyTypeCounts(): TypeCounts {
  return { gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 };
}

export function stableStats(stats: SimulationStats): Omit<SimulationStats, "physicsMs"> {
  const { physicsMs: _physicsMs, ...stable } = stats;
  return stable;
}

/**
 * Tracks every physical identity and terminal event. After each real physics
 * tick it proves per-type and four-way conservation. Accounted out-of-bounds
 * losses are valid, but invalid poses and spawn failures are fatal evidence.
 */
export class PhysicalEvidence {
  private readonly types = new Map<number, CoinType>();
  private readonly resolved = new Set<number>();
  private readonly nativeTypes = new Map<number, { chuteId: string; type: CoinType }>();
  private readonly nativeChuteIds = new Set<string>();
  private readonly admitted = new Set<number>();
  private readonly spawned = emptyTypeCounts();
  private readonly collected = emptyTypeCounts();
  private readonly lost = emptyTypeCounts();
  private readonly detonated = emptyTypeCounts();
  private readonly active = emptyTypeCounts();

  private remember(id: number, type: CoinType): void {
    const known = this.types.get(id);
    if (known !== undefined && known !== type)
      throw new Error(`Coin ${id} changed type from ${known} to ${type}`);
    if (known === undefined) {
      this.types.set(id, type);
      this.spawned[type] += 1;
    }
  }

  inspect(
    simulation: Simulation,
    events: readonly CoinEvent[],
    combat: CombatStepResult,
    admissions: readonly RoundAdmission[],
  ): void {
    const active = this.active;
    for (const type of COIN_TYPES) active[type] = 0;

    const chuteIds = new Set<string>();
    const activeNativeIds = new Set<number>();
    for (const tray of simulation.feedTrays()) {
      if (chuteIds.has(tray.id)) throw new Error(`Duplicate native feed ID: ${tray.id}`);
      chuteIds.add(tray.id);
      this.nativeChuteIds.add(tray.id);
      for (const coin of tray.coins) {
        if (activeNativeIds.has(coin.id) || simulation.coins.has(coin.id))
          throw new Error(`Duplicate native feed coin ID: ${coin.id}`);
        activeNativeIds.add(coin.id);
        const known = this.nativeTypes.get(coin.id);
        if (known && (known.chuteId !== tray.id || known.type !== coin.type))
          throw new Error(`Native feed coin ${coin.id} changed identity`);
        if (!known) this.nativeTypes.set(coin.id, { chuteId: tray.id, type: coin.type });
        if (
          !Number.isFinite(coin.position.x) ||
          !Number.isFinite(coin.position.y) ||
          !Number.isFinite(coin.position.z) ||
          !Number.isFinite(coin.rotation.x) ||
          !Number.isFinite(coin.rotation.y) ||
          !Number.isFinite(coin.rotation.z) ||
          !Number.isFinite(coin.rotation.w)
        ) throw new Error(`Native feed coin ${coin.id} has a nonfinite physical pose`);
      }
    }

    for (const coin of simulation.coins.values()) {
      if (this.resolved.has(coin.id)) throw new Error(`Resolved coin ${coin.id} remained active`);
      this.remember(coin.id, coin.type);
      active[coin.type] += 1;
      if (
        !Number.isFinite(coin.position.x) ||
        !Number.isFinite(coin.position.y) ||
        !Number.isFinite(coin.position.z) ||
        !Number.isFinite(coin.rotation.x) ||
        !Number.isFinite(coin.rotation.y) ||
        !Number.isFinite(coin.rotation.z) ||
        !Number.isFinite(coin.rotation.w) ||
        !Number.isFinite(coin.radius) ||
        !Number.isFinite(coin.thickness) ||
        !Number.isFinite(coin.bombHits)
      ) throw new Error(`Coin ${coin.id} has a nonfinite physical pose`);
    }

    for (const event of events) {
      this.remember(event.id, event.type);
      if (this.resolved.has(event.id)) throw new Error(`Duplicate physical resolution for coin ${event.id}`);
      this.resolved.add(event.id);
      if (
        !Number.isFinite(event.position.x) ||
        !Number.isFinite(event.position.y) ||
        !Number.isFinite(event.position.z)
      ) throw new Error(`Coin ${event.id} has a nonfinite terminal pose`);
      if (event.kind === "collected") this.collected[event.type] += 1;
      else if (event.kind === "detonated") this.detonated[event.type] += 1;
      else {
        this.lost[event.type] += 1;
        if (event.reason === "spawn-failed") throw new Error(`Coin ${event.id} failed to spawn`);
        if (event.reason === "invalid-pose") throw new Error(`Coin ${event.id} reached an invalid pose`);
        if (combat.effects.some((effect) => effect.id === event.id))
          throw new Error(`Lost coin ${event.id} produced a gameplay effect`);
      }
    }

    for (const admission of admissions) {
      for (const coin of admission.coins) {
        if (!this.nativeChuteIds.has(coin.chuteId))
          throw new Error(`Admission references unknown native feed ${coin.chuteId}`);
        if (this.admitted.has(coin.id))
          throw new Error(`Coin ${coin.id} was admitted more than once`);
        this.admitted.add(coin.id);
        if (this.types.get(coin.id) !== coin.type)
          throw new Error(`Admitted coin ${coin.id} is missing from physical evidence`);
      }
    }

    let effectRemoved = 0;
    let effectDiscarded = 0;
    for (const effect of combat.effects) {
      if (!Number.isFinite(effect.enemyDamage) || !Number.isFinite(effect.discardedDamage) ||
        effect.enemyDamage < 0 || effect.discardedDamage < 0)
        throw new Error(`Combat effect ${effect.id} has invalid damage evidence`);
      const hitIds = new Set<string>();
      let removed = 0;
      for (const hit of effect.enemyHits) {
        if (!hit.enemyId || hitIds.has(hit.enemyId) || !Number.isFinite(hit.damage) || hit.damage <= 0)
          throw new Error(`Combat effect ${effect.id} has invalid enemy-hit evidence`);
        hitIds.add(hit.enemyId);
        removed += hit.damage;
      }
      if (removed + effect.discardedDamage !== effect.enemyDamage)
        throw new Error(`Combat effect ${effect.id} damage evidence does not balance`);
      effectRemoved += removed;
      effectDiscarded += effect.discardedDamage;
    }
    if (effectRemoved !== combat.delta.enemyHpRemoved ||
      effectDiscarded !== combat.delta.discardedDamage)
      throw new Error("Combat batch damage evidence disagrees with its totals");

    const stats = simulation.stats();
    if (
      !Number.isFinite(stats.time) ||
      !Number.isFinite(stats.active) ||
      !Number.isFinite(stats.sleeping) ||
      !Number.isFinite(stats.spawned) ||
      !Number.isFinite(stats.collected) ||
      !Number.isFinite(stats.detonated) ||
      !Number.isFinite(stats.lost) ||
      !Number.isFinite(stats.pendingRain) ||
      !Number.isFinite(stats.physicsMs) ||
      !Number.isFinite(stats.pusherZ) ||
      !Number.isFinite(stats.phase)
    ) throw new Error("Simulation statistics contain a nonfinite value");
    let activeTotal = 0;
    let collected = 0;
    let lost = 0;
    let detonated = 0;
    for (const type of COIN_TYPES) {
      if (!Number.isFinite(stats.collectedByType[type]))
        throw new Error("Simulation statistics contain a nonfinite value");
      const accounted = active[type] + this.collected[type] + this.lost[type] + this.detonated[type];
      if (this.spawned[type] !== accounted)
        throw new Error(`Physical ${type} conservation failed: ${this.spawned[type]} != ${accounted}`);
      if (stats.collectedByType[type] !== this.collected[type])
        throw new Error(`Collected ${type} counter disagrees with terminal evidence`);
      activeTotal += active[type];
      collected += this.collected[type];
      lost += this.lost[type];
      detonated += this.detonated[type];
    }
    if (stats.active !== simulation.coins.size || stats.active !== activeTotal)
      throw new Error("Active physical counter disagrees with the coin map");
    if (stats.spawned !== this.types.size || stats.collected !== collected || stats.lost !== lost || stats.detonated !== detonated)
      throw new Error("Physical terminal counters disagree with event evidence");
    if (stats.spawned !== stats.active + stats.collected + stats.lost + stats.detonated)
      throw new Error("Four-way physical conservation failed");
  }

  spawnedByType(): TypeCounts {
    return { ...this.spawned };
  }

  nativeFeedIds(): number[] {
    return [...this.nativeTypes.keys()].sort((left, right) => left - right);
  }
}

function copyConfig(config: EncounterConfig): EncounterConfig {
  return {
    ...config,
    openingMix: { ...config.openingMix },
    bomb: { ...config.bomb },
    waves: config.waves.map((wave) => ({
      ...wave,
      enemies: wave.enemies.map((enemy) => ({ ...enemy, bag: [...enemy.bag] })),
    })),
  };
}

function copyAdmission(admission: RoundAdmission | null): RoundAdmission | null {
  return admission && { ...admission, coins: admission.coins.map((coin) => ({ ...coin })) };
}

function copyEffect(effect: CombatEffect): CombatEffect {
  return {
    ...effect,
    position: { ...effect.position },
    enemyHits: effect.enemyHits.map((hit) => ({ ...hit })),
  };
}

function copyCombat(combat: CombatStepResult): CombatStepResult {
  return {
    state: {
      ...combat.state,
      enemies: combat.state.enemies.map((enemy) => ({ ...enemy })),
      totals: { ...combat.state.totals },
    },
    delta: { ...combat.delta },
    effects: combat.effects.map(copyEffect),
  };
}

export function stableFeed(trays: readonly FeedTray[]): FeedTray[] {
  return trays.map((tray) => ({
    ...tray,
    preview: [...tray.preview],
    burst: { ...tray.burst, cohort: tray.burst.cohort.map((member) => ({ ...member })) },
    coins: tray.coins.map((coin) => ({
      ...coin,
      position: { ...coin.position },
      rotation: { ...coin.rotation },
    })),
  }));
}

export function stableFeedStreams(streams: readonly ChuteStreamSnapshot[]): ChuteStreamSnapshot[] {
  return streams.map((stream) => ({
    ...stream,
    bag: [...stream.bag],
    queue: [...stream.queue],
  }));
}

export function initialFightDigest(encounter: Encounter): string {
  const snapshot = encounter.snapshot();
  const coins = [...encounter.simulation.coins.values()]
    .sort((left, right) => left.id - right.id)
    .map((coin) => ({
      ...coin,
      position: { ...coin.position },
      rotation: { ...coin.rotation },
    }));
  return digest({
    physical: {
      coins,
      tuning: { ...encounter.simulation.tuning },
      stats: stableStats(encounter.simulation.stats()),
    },
    encounter: stableSnapshot(snapshot),
    feed: stableFeed(encounter.preview()),
  });
}

function stableSnapshot(snapshot: EncounterSnapshot): EncounterSnapshot {
  return {
    ...snapshot,
    enemies: snapshot.enemies.map((enemy) => ({ ...enemy })),
    chuteSlots: snapshot.chuteSlots.map((slot) => ({ ...slot })),
    playerChutes: snapshot.playerChutes.map((chute) => ({ ...chute, bag: [...chute.bag] })),
    chuteSettings: { ...snapshot.chuteSettings },
    feedStreams: stableFeedStreams(snapshot.feedStreams),
    config: copyConfig(snapshot.config),
    totals: { ...snapshot.totals },
    lastAdmission: copyAdmission(snapshot.lastAdmission),
    loading: {
      ...snapshot.loading,
      collectedByType: { ...snapshot.loading.collectedByType },
      lostByType: { ...snapshot.loading.lostByType },
    },
    recentEffects: snapshot.recentEffects.map(copyCombat),
  };
}

/**
 * The ledger is sparse: an omitted tick is implicitly an empty event/effect
 * tick. `metrics.finalTick` closes that implicit range. Every terminal event,
 * combat effect, admission fragment, and wave event is retained, including
 * loading and waiting ticks.
 */
export function simulationFightDigest(
  initialDigest: string,
  ledger: readonly FightLedgerEntry[],
  final: EncounterSnapshot,
  finalFeed: readonly FeedTray[],
  physicalFinal: SimulationStats,
  result: string | null,
): string {
  return digest({
    initialDigest,
    ledger,
    final: stableSnapshot(final),
    finalFeed: stableFeed(finalFeed),
    physicalFinal: stableStats(physicalFinal),
    result,
  });
}
