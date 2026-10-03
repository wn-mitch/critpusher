import { afterEach, describe, expect, it } from "vitest";
import { COIN_TYPES, type CoinType, type Simulation, type Tuning } from "../src/contracts";
import { DEFAULT_ENCOUNTER_CONFIG, GOLD_ONLY_MIX, simulationConfig } from "../src/combat/config";
import type { CoinMix, SimulationConfig } from "../src/combat/types";
import { createSimulation, DEFAULT_TUNING } from "../src/simulation";
import { planRain } from "../src/simulation/rain";

const simulations: Simulation[] = [];
const equalMix: CoinMix = { gold: 1, diamond: 1, sword: 1, skull: 1, potion: 1, bomb: 1 };

async function simulationWith(
  patch: Partial<Tuning>,
  config?: Partial<SimulationConfig>,
): Promise<Simulation> {
  const simulation = await createSimulation(patch, config);
  simulations.push(simulation);
  return simulation;
}

function countTypes(coins: Iterable<{ type: CoinType }>): Record<CoinType, number> {
  const counts: Record<CoinType, number> = { gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 };
  for (const coin of coins) counts[coin.type] += 1;
  return counts;
}

function drainRain(simulation: Simulation): void {
  for (let step = 0; step < 1_200 && simulation.stats().pendingRain > 0; step++) {
    simulation.step();
  }
  expect(simulation.stats().pendingRain).toBe(0);
}

function snapshot(simulation: Simulation) {
  return [...simulation.coins.values()].map(({ id: _id, ...coin }) => ({
    ...coin,
    position: { ...coin.position },
    rotation: { ...coin.rotation },
  }));
}

afterEach(() => {
  for (const simulation of simulations) simulation.dispose();
  simulations.length = 0;
});

describe("mixed opening pile", () => {
  it.each([
    { density: 3, mix: equalMix, expected: { gold: 1, diamond: 1, sword: 1, skull: 0, potion: 0, bomb: 0 } },
    { density: 7, mix: equalMix, expected: { gold: 2, diamond: 1, sword: 1, skull: 1, potion: 1, bomb: 1 } },
    { density: 17, mix: GOLD_ONLY_MIX, expected: { gold: 17, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 } },
    { density: 0, mix: equalMix, expected: { gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 } },
  ])("allocates exact largest-remainder quotas for $density coins", ({ density, mix, expected }) => {
    expect(countTypes(planRain({ ...DEFAULT_TUNING, density }, mix))).toEqual(expected);
  });

  it("normalizes relative weights without changing allocations", () => {
    const mix = DEFAULT_ENCOUNTER_CONFIG.openingMix;
    const scaled = Object.fromEntries(COIN_TYPES.map(type => [type, mix[type] * 3])) as CoinMix;
    expect(planRain(DEFAULT_TUNING, scaled)).toEqual(planRain(DEFAULT_TUNING, mix));
  });

  it("repeats type and geometry assignments while isolating the mix stream", () => {
    const tuning = { ...DEFAULT_TUNING, density: 48, seed: 71 };
    const first = planRain(tuning, DEFAULT_ENCOUNTER_CONFIG.openingMix);
    const second = planRain(tuning, DEFAULT_ENCOUNTER_CONFIG.openingMix);
    const differentSeed = planRain({ ...tuning, seed: 72 }, DEFAULT_ENCOUNTER_CONFIG.openingMix);
    const differentMix = planRain(tuning, GOLD_ONLY_MIX);

    expect(second).toEqual(first);
    expect(differentSeed.map(({ type }) => type)).not.toEqual(first.map(({ type }) => type));
    expect(differentSeed.map(({ pose }) => pose)).not.toEqual(first.map(({ pose }) => pose));
    expect(differentMix.map(({ pose, releaseTick }) => ({ pose, releaseTick }))).toEqual(
      first.map(({ pose, releaseTick }) => ({ pose, releaseTick })),
    );
  });

  it("preserves exact types through deferred physical rain admissions", async () => {
    const simulation = await simulationWith({ density: 300, seed: 13 });
    const plan = planRain(simulation.tuning, simulation.config.openingMix);
    let sawDeferredAdmission = false;
    for (let tick = 0; tick < 1_200 && simulation.stats().pendingRain > 0; tick++) {
      simulation.step();
      const due = plan.filter(({ releaseTick }) => releaseTick <= tick).length;
      if (simulation.stats().spawned < due) sawDeferredAdmission = true;
    }

    const stats = simulation.stats();
    expect(sawDeferredAdmission).toBe(true);
    expect(stats.pendingRain).toBe(0);
    expect(stats.spawned).toBe(300);
    expect(countTypes([...simulation.coins.values(), ...simulation.drainEvents()])).toEqual(countTypes(plan));
    expect(stats.spawned).toBe(stats.active + stats.collected + stats.lost + stats.detonated);
    expect(stats.collected).toBe(Object.values(stats.collectedByType).reduce((sum, count) => sum + count, 0));
    expect(stats.detonated).toBe(0);
    expect([...simulation.coins.values()].every(coin => coin.bombHits === 0)).toBe(true);
  });

  it("rebuilds seeded physics on reset without reusing IDs or changing geometry with the mix", async () => {
    const tuning = { density: 48, seed: 71 };
    const first = await simulationWith(tuning);
    const sameSeed = await simulationWith(tuning);
    const allGold = await simulationWith(tuning, { openingMix: GOLD_ONLY_MIX });
    drainRain(first);
    drainRain(sameSeed);
    drainRain(allGold);
    const original = snapshot(first);
    const highestId = Math.max(...first.coins.keys(), ...first.drainEvents().map(event => event.id));

    expect(snapshot(sameSeed)).toEqual(original);
    expect(snapshot(allGold).map(({ type: _type, ...geometry }) => geometry)).toEqual(
      original.map(({ type: _type, ...geometry }) => geometry),
    );
    expect(countTypes([...allGold.coins.values(), ...allGold.drainEvents()])).toEqual({
      gold: 48, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0,
    });
    expect(allGold.stats().collected).toBe(allGold.stats().collectedByType.gold);

    first.reset();
    drainRain(first);
    expect(snapshot(first)).toEqual(original);
    expect([...first.coins.keys(), ...first.drainEvents().map(event => event.id)].every(id => id > highestId)).toBe(true);
  });

  it("retains domain config on reset and replaces whole nested values only when supplied", async () => {
    const bomb = { hitThreshold: 5, minClosingSpeed: 1, blastRadius: 2, blastDeltaSpeed: 4 };
    const simulation = await simulationWith({ density: 96, seed: 31 }, { openingMix: GOLD_ONLY_MIX, bomb });
    simulation.step();
    simulation.configure({ friction: 0.7 });
    expect(simulation.config).toEqual({ openingMix: GOLD_ONLY_MIX, bomb });
    simulation.reset({ density: 9 });
    expect(simulation.config).toEqual({ openingMix: GOLD_ONLY_MIX, bomb });
    expect(simulation.stats()).toMatchObject({ pendingRain: 9, spawned: 0, collected: 0, lost: 0, detonated: 0 });
    expect(simulation.stats().collectedByType).toEqual(countTypes([]));
    expect(simulation.drainEvents()).toEqual([]);
    drainRain(simulation);
    expect(countTypes([...simulation.coins.values(), ...simulation.drainEvents()])).toEqual({
      gold: 9, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0,
    });

    simulation.reset(undefined, { openingMix: equalMix });
    drainRain(simulation);
    expect(simulation.config.bomb).toEqual(bomb);
    expect(countTypes([...simulation.coins.values(), ...simulation.drainEvents()])).toEqual({
      gold: 2, diamond: 2, sword: 2, skull: 1, potion: 1, bomb: 1,
    });
  });

  it.each(COIN_TYPES)("admits explicit %s chute types in input/level order", async type => {
    const simulation = await simulationWith({ density: 0 });
    const ids = simulation.releaseChutes([{ x: -1, count: 2, type }, { x: 1, count: 1 }]);
    expect(ids).toEqual([1, 2, 3]);
    expect(ids!.map(id => simulation.coins.get(id)!.type)).toEqual([type, type, "sword"]);
    expect(ids!.map(id => simulation.coins.get(id)!.bombHits)).toEqual([0, 0, 0]);
  });

  it("rejects a malformed explicit type before spawning any part of a round", async () => {
    const simulation = await simulationWith({ density: 0 });
    expect(simulation.releaseChutes([
      { x: -1, count: 1, type: "gold" },
      { x: 1, count: 1, type: "invalid" as CoinType },
    ])).toBeNull();
    expect(simulation.stats()).toMatchObject({ spawned: 0, active: 0, lost: 0 });
    expect(simulation.drainEvents()).toEqual([]);
    expect(simulation.releaseChutes([{ x: 0, count: 1 }])).toEqual([1]);
  });
});

describe("domain configuration validation", () => {
  it.each([
    { gold: 100 },
    { ...equalMix, gold: -1 },
    { ...equalMix, gold: NaN },
    { ...equalMix, gold: Infinity },
    { gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 },
    null,
  ])("rejects malformed whole opening mixes: %j", openingMix => {
    const patch = { openingMix } as unknown as Partial<SimulationConfig>;
    expect(() => simulationConfig(undefined, patch)).toThrow();
    expect(() => planRain({ ...DEFAULT_TUNING, density: 0 }, openingMix as CoinMix)).toThrow();
  });

  it.each([
    { hitThreshold: 3 },
    { ...DEFAULT_ENCOUNTER_CONFIG.bomb, hitThreshold: 0 },
    { ...DEFAULT_ENCOUNTER_CONFIG.bomb, hitThreshold: 11 },
    { ...DEFAULT_ENCOUNTER_CONFIG.bomb, hitThreshold: 2.5 },
    { ...DEFAULT_ENCOUNTER_CONFIG.bomb, minClosingSpeed: NaN },
    { ...DEFAULT_ENCOUNTER_CONFIG.bomb, blastRadius: 0 },
    { ...DEFAULT_ENCOUNTER_CONFIG.bomb, blastDeltaSpeed: Infinity },
    null,
  ])("rejects malformed whole bomb configs: %j", bomb => {
    expect(() => simulationConfig(undefined, { bomb } as unknown as Partial<SimulationConfig>)).toThrow();
  });

  it("rejects invalid construction and preserves the running machine after invalid reset", async () => {
    const invalid = { openingMix: { gold: 100 } } as Partial<SimulationConfig>;
    await expect(createSimulation({ density: 0 }, invalid)).rejects.toThrow();
    const simulation = await simulationWith({ density: 0 });
    const ids = simulation.releaseChutes([{ x: 0, count: 1, type: "bomb" }]);
    const before = snapshot(simulation);
    const config = { openingMix: { ...simulation.config.openingMix }, bomb: { ...simulation.config.bomb } };
    expect(() => simulation.reset({ density: 100 }, invalid)).toThrow();
    expect(snapshot(simulation)).toEqual(before);
    expect(simulation.config).toEqual(config);
    expect(simulation.tuning.density).toBe(0);
    expect([...simulation.coins.keys()]).toEqual(ids);
    simulation.step();
    expect(simulation.stats()).toMatchObject({ spawned: 1, active: 1, pendingRain: 0 });
  });
});
