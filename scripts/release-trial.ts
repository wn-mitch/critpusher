import { createHash } from "node:crypto";
import { createSimulation } from "../src/simulation/index";
import type { CollectionEvent, Simulation } from "../src/contracts";
import { createLaneObserver } from "../src/experiments/lanes";
import { chooseRuleAction } from "../src/experiments/rule-policy";
import {
  SOLVER_LANE_CENTERS,
  type RecentRelease,
  type SolverAction,
  type SolverDecision,
  type SolverPolicy,
  type SolverState,
} from "../src/experiments/solver-contracts";
import { createJevPolicy } from "./jev-policy";

export type ReleasePolicy = "center" | "random" | "rule" | "jev";
export type ReleasePattern = "sequential" | "stack" | "flanks";

export interface ReleaseTrial {
  seed: number;
  density: number;
  stroke: number;
  shelfFront: number;
  mode: "chute" | "back-row";
  policy: ReleasePolicy;
  coinsPerRelease: number;
  releases: number;
  pattern?: ReleasePattern;
  spacing?: number;
  enemyCoins?: number;
}

export interface CollectionBreakdown {
  player: number;
  enemy: number;
  starting: number;
}

export interface ReleaseWindow {
  index: number;
  startTick: number;
  endTick: number;
  observation: SolverState;
  decision: SolverDecision;
  chutePositions: number[];
  playerChutePositions: number[];
  enemyChutePositions: number[];
  accepted: number;
  acceptedPlayer: number;
  acceptedEnemy: number;
  collected: number;
  collections: CollectionBreakdown;
  idleCollected: number;
  enemyOnlyCollected: number;
  enemyOnlyCollections: CollectionBreakdown;
  totalMinusEnemyOnly: number;
  waitingCollected: number;
  idleWaitingCollected: number;
  enemyOnlyWaitingCollected: number;
  firstPayoutTick: number | null;
}

export interface ReleaseResult extends ReleaseTrial {
  pattern: ReleasePattern;
  spacing: number;
  windows: ReleaseWindow[];
  initialDigest: string;
  warmupCollected: number;
  settledActive: number;
  accepted: number;
  acceptedPlayer: number;
  acceptedEnemy: number;
  collected: number;
  collections: CollectionBreakdown;
  idleCollected: number;
  enemyOnlyCollected: number;
  enemyOnlyCollections: CollectionBreakdown;
  totalMinusEnemyOnly: number;
  hitCount: number;
  enemyOnlyHitCount: number;
  hitCountMinusEnemyOnly: number;
  enemyOnlyHitRate: number;
  active: number;
  peakActive: number;
  elapsedSeconds: number;
  inputTokens: number;
  outputTokens: number;
}

const WARMUP_TICKS = 720;
const CYCLE_TICKS = 144;
const BURST_INTERVAL_TICKS = 10;

export function validateAction(action: SolverAction): void {
  if (
    !Number.isInteger(action.lane) ||
    action.lane < 0 ||
    action.lane >= SOLVER_LANE_CENTERS.length ||
    !Number.isInteger(action.waitQuarters) ||
    action.waitQuarters < 0 ||
    action.waitQuarters > 3
  )
    throw new Error("Solver returned an invalid lane or quarter-cycle wait");
}

function addCollections(
  target: CollectionBreakdown,
  source: CollectionBreakdown,
): void {
  target.player += source.player;
  target.enemy += source.enemy;
  target.starting += source.starting;
}

function totalCollections(collections: CollectionBreakdown): number {
  return collections.player + collections.enemy + collections.starting;
}

function candidateAimXs(pattern: ReleasePattern, spacing: number): number[] {
  if (pattern !== "flanks") return [...SOLVER_LANE_CENTERS];
  const extent = Math.min(4, 4.4 - spacing);
  if (extent < 0)
    throw new Error("Flank spacing leaves no valid center chute position");
  return SOLVER_LANE_CENTERS.map((x) => (x / 4) * extent);
}

function validateTrial(
  trial: ReleaseTrial,
  pattern: ReleasePattern,
  spacing: number,
): void {
  if (
    !Number.isInteger(trial.coinsPerRelease) ||
    trial.coinsPerRelease < 1 ||
    !Number.isInteger(trial.releases) ||
    trial.releases < 1
  )
    throw new Error("Invalid release count or burst size");
  if (pattern === "sequential") {
    if (trial.coinsPerRelease > 6)
      throw new Error("Invalid release count or burst size");
    return;
  }
  if (trial.mode !== "chute")
    throw new Error("Stack and flank patterns require chute mode");
  if (trial.coinsPerRelease !== 1 && trial.coinsPerRelease !== 3)
    throw new Error("Stack and flank player releases require 1 or 3 coins");
  if (pattern === "flanks" && (!Number.isFinite(spacing) || spacing <= 0))
    throw new Error("Flank spacing must be a positive finite number");
  if (pattern === "flanks" && trial.enemyCoins !== 1 && trial.enemyCoins !== 3)
    throw new Error("Flank enemy releases require 1 or 3 coins per flank");
}

export async function runReleaseTrial(
  trial: ReleaseTrial,
): Promise<ReleaseResult> {
  const pattern = trial.pattern ?? "sequential";
  const spacing = trial.spacing ?? 1.5;
  validateTrial(trial, pattern, spacing);
  const aims = candidateAimXs(pattern, spacing);
  const tuning = {
    seed: trial.seed,
    density: trial.density,
    stroke: trial.stroke,
    shelfFront: trial.shelfFront,
    radius: 0.32,
    thickness: 0.13,
    coinWeight: 1,
    friction: 0.58,
    period: 2.4,
    dropHeight: 3.5,
    dropRate: 6,
  };
  const simulation = await createSimulation(tuning);
  let idle: Simulation | undefined;
  let enemyOnly: Simulation | undefined;
  try {
    idle = await createSimulation(tuning);
    if (pattern === "flanks") enemyOnly = await createSimulation(tuning);
    const observer = createLaneObserver();
    const resolved = new Map<Simulation, Set<number>>([
      [simulation, new Set()],
      [idle, new Set()],
    ]);
    if (enemyOnly) resolved.set(enemyOnly, new Set());
    let tick = 0;
    let peakActive = 0;

    const drain = (world: Simulation): CollectionEvent[] => {
      const events = world.drainEvents();
      const seen = resolved.get(world)!;
      for (const event of events) {
        if (seen.has(event.id))
          throw new Error("Duplicate physical resolution");
        if (event.kind === "lost")
          throw new Error("Physical coin loss invalidates this trial");
        seen.add(event.id);
      }
      const stats = world.stats();
      if (stats.spawned !== stats.active + stats.collected + stats.lost)
        throw new Error("Physical conservation failed");
      return events;
    };
    const step = () => {
      simulation.step();
      idle!.step();
      enemyOnly?.step();
      tick++;
      const events = drain(simulation);
      const idleEvents = drain(idle!);
      const enemyOnlyEvents = enemyOnly ? drain(enemyOnly) : [];
      observer.record(events);
      peakActive = Math.max(peakActive, simulation.stats().active);
      return { events, idleEvents, enemyOnlyEvents };
    };
    for (let i = 0; i < WARMUP_TICKS; i++) step();
    for (const world of [simulation, idle, enemyOnly]) {
      if (world?.stats().pendingRain)
        throw new Error("Opening load incomplete at trial start");
    }
    const initialPile = JSON.stringify([...simulation.coins.values()]);
    const initialDigest = createHash("sha256")
      .update(initialPile)
      .digest("hex");
    for (const world of [idle, enemyOnly]) {
      if (world && initialPile !== JSON.stringify([...world.coins.values()]))
        throw new Error("Control starts from a different initial pile");
    }
    const warmupCollected = simulation.stats().collected;
    const settledActive = simulation.stats().active;
    const starting = new Set(simulation.coins.keys());
    const enemyStarting = new Set(enemyOnly?.coins.keys() ?? []);
    const playerIds = new Set<number>();
    const enemyIds = new Set<number>();
    const controlEnemyIds = new Set<number>();

    const classify = (
      events: readonly CollectionEvent[],
      player: ReadonlySet<number>,
      enemy: ReadonlySet<number>,
      initial: ReadonlySet<number>,
    ): CollectionBreakdown => {
      const out = { player: 0, enemy: 0, starting: 0 };
      for (const event of events) {
        if (player.has(event.id)) out.player++;
        else if (enemy.has(event.id)) out.enemy++;
        else if (initial.has(event.id)) out.starting++;
        else throw new Error(`Resolved coin ${event.id} has no source label`);
      }
      return out;
    };

    observer.reset();
    observer.observe(simulation);
    let randomState = (trial.seed ^ 0x73ac1e) >>> 0;
    const policy: SolverPolicy =
      trial.policy === "jev"
        ? createJevPolicy({ maxRequests: trial.releases })
        : trial.policy === "rule"
          ? chooseRuleAction
          : () => {
              randomState =
                (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
              return {
                action: {
                  lane:
                    trial.policy === "center"
                      ? 2
                      : Math.floor((randomState / 4294967296) * 5),
                  waitQuarters: 0,
                },
              };
            };
    const windows: ReleaseWindow[] = [];
    const recent: RecentRelease[] = [];
    const allCollections = { player: 0, enemy: 0, starting: 0 };
    const allEnemyOnlyCollections = { player: 0, enemy: 0, starting: 0 };
    const noPlayerIds = new Set<number>();
    for (let index = 0; index < trial.releases; index++) {
      const observation: SolverState = {
        board: observer.observe(simulation),
        releaseCoins: trial.coinsPerRelease,
        feed: trial.mode,
        recent: recent.map((r) => ({ ...r, action: { ...r.action } })),
        pattern,
        candidateAimXs: aims,
        enemyCoins: pattern === "flanks" ? trial.enemyCoins! : 0,
        spacing,
      };
      const decision = await policy(observation);
      validateAction(decision.action);
      let waitingCollected = 0;
      let idleWaitingCollected = 0;
      let enemyOnlyWaitingCollected = 0;
      const waitTicks = (decision.action.waitQuarters * CYCLE_TICKS) / 4;
      for (let i = 0; i < waitTicks; i++) {
        const events = step();
        waitingCollected += events.events.length;
        idleWaitingCollected += events.idleEvents.length;
        enemyOnlyWaitingCollected += events.enemyOnlyEvents.length;
        addCollections(
          allCollections,
          classify(events.events, playerIds, enemyIds, starting),
        );
        addCollections(
          allEnemyOnlyCollections,
          classify(
            events.enemyOnlyEvents,
            noPlayerIds,
            controlEnemyIds,
            enemyStarting,
          ),
        );
      }

      const center = aims[decision.action.lane]!;
      const chutePositions =
        pattern === "flanks"
          ? [center - spacing, center, center + spacing]
          : [center];
      const playerChutePositions = [center];
      const enemyChutePositions =
        pattern === "flanks" ? [center - spacing, center + spacing] : [];
      const startTick = tick;
      let acceptedPlayer = 0;
      let acceptedEnemy = 0;
      const collections = { player: 0, enemy: 0, starting: 0 };
      const enemyOnlyCollections = { player: 0, enemy: 0, starting: 0 };
      let idleCollected = 0;
      let firstPayoutTick: number | null = null;

      for (let offset = 0; offset < CYCLE_TICKS; offset++) {
        if (pattern === "sequential") {
          if (
            offset % BURST_INTERVAL_TICKS === 0 &&
            acceptedPlayer < trial.coinsPerRelease
          ) {
            if (!simulation.drop(center, trial.mode))
              throw new Error(
                `Rejected burst coin ${acceptedPlayer + 1}/${trial.coinsPerRelease} at release ${index + 1}, lane ${decision.action.lane}, tick ${tick} (${trial.mode}); invalid release budget`,
              );
            let id = -1;
            for (const coinId of simulation.coins.keys())
              if (coinId > id) id = coinId;
            playerIds.add(id);
            acceptedPlayer++;
          }
        } else if (offset === 0) {
          const chutes =
            pattern === "stack"
              ? [{ x: center, count: trial.coinsPerRelease }]
              : [
                  {
                    x: center - spacing,
                    count: trial.enemyCoins!,
                    faction: "enemy" as const,
                  },
                  { x: center, count: trial.coinsPerRelease },
                  {
                    x: center + spacing,
                    count: trial.enemyCoins!,
                    faction: "enemy" as const,
                  },
                ];
          const ids = simulation.releaseChutes(chutes);
          if (!ids)
            throw new Error(`Atomic chute release ${index + 1} was rejected`);
          if (pattern === "stack") {
            ids.forEach((id) => playerIds.add(id));
            acceptedPlayer = ids.length;
          } else {
            const flank = trial.enemyCoins!;
            ids.slice(0, flank).forEach((id) => enemyIds.add(id));
            ids
              .slice(flank, flank + trial.coinsPerRelease)
              .forEach((id) => playerIds.add(id));
            ids
              .slice(flank + trial.coinsPerRelease)
              .forEach((id) => enemyIds.add(id));
            acceptedPlayer = trial.coinsPerRelease;
            acceptedEnemy = flank * 2;
            const controlIds = enemyOnly!.releaseChutes([
              { x: center - spacing, count: flank, faction: "enemy" },
              { x: center + spacing, count: flank, faction: "enemy" },
            ]);
            if (!controlIds)
              throw new Error(
                `Matching enemy-only release ${index + 1} was rejected`,
              );
            controlIds.forEach((id) => controlEnemyIds.add(id));
            if (controlIds.length !== acceptedEnemy)
              throw new Error("Enemy-only control input budget mismatch");
          }
          if (ids.length !== trial.coinsPerRelease + acceptedEnemy)
            throw new Error("Incomplete atomic release budget");
        }

        const events = step();
        const batch = classify(events.events, playerIds, enemyIds, starting);
        addCollections(collections, batch);
        idleCollected += events.idleEvents.length;
        const enemyBatch = classify(
          events.enemyOnlyEvents,
          noPlayerIds,
          controlEnemyIds,
          enemyStarting,
        );
        addCollections(enemyOnlyCollections, enemyBatch);
        addCollections(allCollections, batch);
        addCollections(allEnemyOnlyCollections, enemyBatch);
        if (events.events.length && firstPayoutTick === null)
          firstPayoutTick = tick - startTick;
      }
      if (acceptedPlayer !== trial.coinsPerRelease)
        throw new Error("Incomplete player release budget");
      const accepted = acceptedPlayer + acceptedEnemy;
      const collected = totalCollections(collections);
      const enemyOnlyCollected = totalCollections(enemyOnlyCollections);
      windows.push({
        index,
        startTick,
        endTick: tick,
        observation,
        decision,
        chutePositions,
        playerChutePositions,
        enemyChutePositions,
        accepted,
        acceptedPlayer,
        acceptedEnemy,
        collected,
        collections,
        idleCollected,
        enemyOnlyCollected,
        enemyOnlyCollections,
        totalMinusEnemyOnly: collected - enemyOnlyCollected,
        waitingCollected,
        idleWaitingCollected,
        enemyOnlyWaitingCollected,
        firstPayoutTick,
      });
      recent.push({ action: decision.action, coins: accepted, collected });
      if (recent.length > 6) recent.shift();
    }

    const collections = allCollections;
    const enemyOnlyCollections = allEnemyOnlyCollections;
    const collected = totalCollections(collections);
    const enemyOnlyCollected = totalCollections(enemyOnlyCollections);
    return {
      ...trial,
      pattern,
      spacing,
      windows,
      initialDigest,
      warmupCollected,
      settledActive,
      accepted: windows.reduce((n, w) => n + w.accepted, 0),
      acceptedPlayer: windows.reduce((n, w) => n + w.acceptedPlayer, 0),
      acceptedEnemy: windows.reduce((n, w) => n + w.acceptedEnemy, 0),
      collected,
      collections,
      idleCollected: idle.stats().collected - warmupCollected,
      enemyOnlyCollected,
      enemyOnlyCollections,
      hitCount: windows.filter((window) => window.collected > 0).length,
      enemyOnlyHitCount: windows.filter(
        (window) => window.enemyOnlyCollected > 0,
      ).length,
      hitCountMinusEnemyOnly:
        windows.filter((window) => window.collected > 0).length -
        windows.filter((window) => window.enemyOnlyCollected > 0).length,
      totalMinusEnemyOnly: collected - enemyOnlyCollected,
      enemyOnlyHitRate:
        windows.filter((window) => window.enemyOnlyCollected > 0).length /
        windows.length,
      active: simulation.stats().active,
      peakActive,
      elapsedSeconds: (tick - WARMUP_TICKS) / 60,
      inputTokens: windows.reduce(
        (n, w) => n + (w.decision.inputTokens ?? 0),
        0,
      ),
      outputTokens: windows.reduce(
        (n, w) => n + (w.decision.outputTokens ?? 0),
        0,
      ),
    };
  } finally {
    simulation.dispose();
    idle?.dispose();
    enemyOnly?.dispose();
  }
}

/** Nonoverlapping windows: waiting payouts cannot buy a successful release. */
export function summarizeReleases(
  windows: readonly Pick<
    ReleaseWindow,
    "collected" | "idleCollected" | "accepted"
  >[],
) {
  if (!windows.length)
    throw new Error("Cannot summarize an empty release cohort");
  let longestDry = 0;
  let dry = 0;
  for (const window of windows) {
    dry = window.collected ? 0 : dry + 1;
    longestDry = Math.max(longestDry, dry);
  }
  const hitCount = windows.filter((w) => w.collected > 0).length;
  const collected = windows.reduce((n, w) => n + w.collected, 0);
  const accepted = windows.reduce((n, w) => n + w.accepted, 0);
  return {
    releases: windows.length,
    hitCount,
    hitRate: hitCount / windows.length,
    meetsTarget: hitCount / windows.length >= 0.9,
    idleHitRate:
      windows.filter((w) => w.idleCollected > 0).length / windows.length,
    excessWindows: windows.filter((w) => w.collected > w.idleCollected).length,
    collected,
    collectedPerCoin: collected / accepted,
    additionalCollections: windows.reduce(
      (n, w) => n + w.collected - w.idleCollected,
      0,
    ),
    longestDry,
  };
}
