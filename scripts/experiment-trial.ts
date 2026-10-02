import { createHash } from "node:crypto";
import { createSimulation } from "../src/simulation/index";
import { FIXED_DT } from "../src/simulation/config";
import { selectTargets, TARGET_LANES } from "../src/experiments/targets";
import type { CollectionEvent } from "../src/contracts";

export type Strategy =
  "none" | "center" | "target" | "opposite" | "alternating" | "random";
export interface Trial {
  variant: string;
  seed: number;
  density: number;
  stroke: number;
  shelfFront: number;
  mode: "chute" | "back-row";
  strategy: Strategy;
  lane: number;
  phase: number;
  drops: number;
  interval: number;
}

export interface Result extends Trial {
  accepted: number;
  rejected: number;
  setupCollected: number;
  setupLost: number;
  settledActive: number;
  collected: number;
  feedingCollected: number;
  idleTailCollected: number;
  firstPayoutDrop: number | null;
  firstPayoutSeconds: number | null;
  paidDropWindows: number;
  longestDry: number;
  bursts: number[];
  targetCount: number;
  targetCollected: number;
  firstTargetDrop: number | null;
  localAdvance: number | null;
  targetPayouts: Array<{ id: number; tick: number; drop: number }>;
  lost: number;
  active: number;
  peakActive: number;
  pendingRain: number;
  payoutDigest: string;
  targets: Array<{ id: number; x: number; z: number }>;
  payouts: Array<{ id: number; tick: number; x: number; z: number }>;
}

export const SETTLE_TICKS = 720;
export const TAIL_TICKS = 288;
const LOCAL_PROBE_TICKS = 432;

function randomFactory(seed: number): () => number {
  let state = (seed ^ 0x51f15e) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export async function runTrial(trial: Trial): Promise<Result> {
  // Pin every physical input instead of inheriting a subsequently tuned default.
  const simulation = await createSimulation({
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
  });
  const seen = new Set<number>();
  function drain(): CollectionEvent[] {
    const events = simulation.drainEvents();
    for (const event of events) {
      if (seen.has(event.id))
        throw new Error(`Duplicate resolution: ${event.id}`);
      seen.add(event.id);
    }
    const s = simulation.stats();
    if (s.spawned !== s.active + s.collected + s.lost)
      throw new Error("Coin conservation failed");
    return events;
  }
  try {
    for (let tick = 0; tick < SETTLE_TICKS + trial.phase; tick++) {
      simulation.step();
      drain();
    }
    const start = simulation.stats();
    if (start.pendingRain !== 0)
      throw new Error("Trial started before all rain was admitted");
    const selected = selectTargets(simulation.coins, trial.shelfFront);
    const targets = new Map<number, { x: number; z: number }>();
    for (const [id, lane] of selected) {
      const coin = simulation.coins.get(id);
      if (lane === trial.lane && coin)
        targets.set(id, { x: coin.position.x, z: coin.position.z });
    }
    const random = randomFactory(trial.seed);
    const payoutSlots = Array<boolean>(trial.drops).fill(false);
    const targetPayouts: Array<{ id: number; tick: number; drop: number }> = [];
    const payouts: Array<{ id: number; tick: number; x: number; z: number }> =
      [];
    const bursts: number[] = [];
    let burstStart = -1;
    let burstLast = -1;
    let burstCount = 0;
    let accepted = 0;
    let rejected = 0;
    let peakActive = start.active;
    let localAdvance: number | null = null;
    const feedingTicks = trial.drops * trial.interval;
    const totalTicks = feedingTicks + TAIL_TICKS;
    for (let tick = 0; tick < totalTicks; tick++) {
      if (
        tick < feedingTicks &&
        tick % trial.interval === 0 &&
        trial.strategy !== "none"
      ) {
        const slot = tick / trial.interval;
        let x = 0;
        if (trial.strategy === "target") x = TARGET_LANES[trial.lane]!;
        if (trial.strategy === "opposite") x = -TARGET_LANES[trial.lane]!;
        if (trial.strategy === "alternating") x = TARGET_LANES[slot % 3]!;
        if (trial.strategy === "random") x = (random() * 2 - 1) * 4;
        if (simulation.drop(x, trial.mode)) accepted++;
        else rejected++;
      }
      simulation.step();
      const events = drain();
      if (
        burstCount > 0 &&
        (tick - burstLast >= 39 || tick - burstStart >= 180)
      ) {
        bursts.push(burstCount);
        burstCount = 0;
      }
      for (const event of events) {
        if (event.kind !== "collected") continue;
        if (burstCount === 0) burstStart = tick;
        burstLast = tick;
        burstCount++;
        payouts.push({
          id: event.id,
          tick,
          x: event.position.x,
          z: event.position.z,
        });
        if (tick < feedingTicks)
          payoutSlots[Math.floor(tick / trial.interval)] = true;
        if (targets.has(event.id))
          targetPayouts.push({
            id: event.id,
            tick,
            drop: Math.min(trial.drops, Math.floor(tick / trial.interval) + 1),
          });
      }
      peakActive = Math.max(peakActive, simulation.stats().active);
      if (tick + 1 === LOCAL_PROBE_TICKS && targets.size) {
        let advance = 0;
        for (const [id, initial] of targets) {
          const coin = simulation.coins.get(id);
          if (coin) advance += coin.position.z - initial.z;
          else if (targetPayouts.some((event) => event.id === id))
            advance += trial.shelfFront - initial.z;
        }
        localAdvance = advance / targets.size;
      }
      if (tick % 144 === 0)
        for (const coin of simulation.coins.values()) {
          if (
            ![
              coin.position.x,
              coin.position.y,
              coin.position.z,
              coin.rotation.x,
              coin.rotation.y,
              coin.rotation.z,
              coin.rotation.w,
            ].every(Number.isFinite)
          )
            throw new Error("Nonfinite physical body");
        }
    }
    if (burstCount) bursts.push(burstCount);
    let dry = 0;
    let longestDry = 0;
    for (const paid of payoutSlots) {
      dry = paid ? 0 : dry + 1;
      longestDry = Math.max(longestDry, dry);
    }
    const end = simulation.stats();
    return {
      ...trial,
      accepted,
      rejected,
      setupCollected: start.collected,
      setupLost: start.lost,
      settledActive: start.active,
      collected: payouts.length,
      feedingCollected: payouts.filter((event) => event.tick < feedingTicks)
        .length,
      idleTailCollected: payouts.filter((event) => event.tick >= feedingTicks)
        .length,
      firstPayoutDrop: payouts.length
        ? Math.min(
            trial.drops,
            Math.floor(payouts[0]!.tick / trial.interval) + 1,
          )
        : null,
      firstPayoutSeconds: payouts.length
        ? (payouts[0]!.tick + 1) * FIXED_DT
        : null,
      paidDropWindows: payoutSlots.filter(Boolean).length,
      longestDry,
      bursts,
      targetCount: targets.size,
      targetCollected: targetPayouts.length,
      firstTargetDrop: targetPayouts[0]?.drop ?? null,
      localAdvance,
      targetPayouts,
      lost: end.lost - start.lost,
      active: end.active,
      peakActive,
      pendingRain: end.pendingRain,
      payoutDigest: createHash("sha256")
        .update(JSON.stringify(payouts))
        .digest("hex"),
      targets: [...targets].map(([id, position]) => ({ id, ...position })),
      payouts,
    };
  } finally {
    simulation.dispose();
  }
}
