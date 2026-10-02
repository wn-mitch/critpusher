import { afterEach, describe, expect, it } from "vitest";
import type { CoinFaction, Simulation, Tuning } from "../src/contracts";
import { createSimulation, DEFAULT_TUNING } from "../src/simulation";
import { sanitizeTuning } from "../src/simulation/config";
import { planRain } from "../src/simulation/rain";

const simulations: Simulation[] = [];

async function simulationWith(patch: Partial<Tuning>): Promise<Simulation> {
  const simulation = await createSimulation(patch);
  simulations.push(simulation);
  return simulation;
}

function countFactions(coins: Iterable<{ faction: CoinFaction }>) {
  const counts: Record<CoinFaction, number> = { ally: 0, enemy: 0, dud: 0 };
  for (const coin of coins) counts[coin.faction] += 1;
  return counts;
}

function drainRain(simulation: Simulation): void {
  for (
    let step = 0;
    step < 1_200 && simulation.stats().pendingRain > 0;
    step++
  ) {
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
    {
      density: 300,
      enemy: 40,
      dud: 20,
      expected: { ally: 120, enemy: 120, dud: 60 },
    },
    {
      density: 17,
      enemy: 40,
      dud: 20,
      expected: { ally: 7, enemy: 7, dud: 3 },
    },
    { density: 3, enemy: 50, dud: 50, expected: { ally: 0, enemy: 2, dud: 1 } },
    { density: 17, enemy: 0, dud: 0, expected: { ally: 17, enemy: 0, dud: 0 } },
    {
      density: 17,
      enemy: 100,
      dud: 100,
      expected: { ally: 0, enemy: 17, dud: 0 },
    },
    {
      density: 17,
      enemy: -10,
      dud: 300,
      expected: { ally: 0, enemy: 0, dud: 17 },
    },
    {
      density: 17,
      enemy: 33.3,
      dud: 12.5,
      expected: { ally: 9, enemy: 6, dud: 2 },
    },
    {
      density: 17,
      enemy: NaN,
      dud: Infinity,
      expected: { ally: 7, enemy: 7, dud: 3 },
    },
    { density: 0, enemy: 0, dud: 100, expected: { ally: 0, enemy: 0, dud: 0 } },
  ])(
    "bounds rounded quotas for $density coins, $enemy% enemy and $dud% dud",
    ({ density, enemy, dud, expected }) => {
      const tuning = sanitizeTuning(DEFAULT_TUNING, {
        density,
        openingEnemyPercent: enemy,
        openingDudPercent: dud,
      });
      expect(tuning.openingEnemyPercent).toBeGreaterThanOrEqual(0);
      expect(tuning.openingDudPercent).toBeGreaterThanOrEqual(0);
      expect(
        tuning.openingEnemyPercent + tuning.openingDudPercent,
      ).toBeLessThanOrEqual(100);
      expect(countFactions(planRain(tuning))).toEqual(expected);
    },
  );

  it("repeats faction and geometry assignments while changing the shuffle with the seed", () => {
    const tuning = { ...DEFAULT_TUNING, density: 48, seed: 71 };
    const first = planRain(tuning);
    const second = planRain(tuning);
    const differentSeed = planRain({ ...tuning, seed: 72 });
    const differentMix = planRain({
      ...tuning,
      openingEnemyPercent: 0,
      openingDudPercent: 100,
    });

    expect(second).toEqual(first);
    expect(differentSeed.map(({ faction }) => faction)).not.toEqual(
      first.map(({ faction }) => faction),
    );
    expect(differentSeed.map(({ pose }) => pose)).not.toEqual(
      first.map(({ pose }) => pose),
    );
    expect(
      differentMix.map(({ pose, releaseTick }) => ({ pose, releaseTick })),
    ).toEqual(first.map(({ pose, releaseTick }) => ({ pose, releaseTick })));
  });

  it("preserves exact factions through deferred physical rain admissions", async () => {
    const simulation = await simulationWith({ density: 300, seed: 13 });
    const plan = planRain(simulation.tuning);
    let sawDeferredAdmission = false;
    for (
      let tick = 0;
      tick < 1_200 && simulation.stats().pendingRain > 0;
      tick++
    ) {
      simulation.step();
      const due = plan.filter(({ releaseTick }) => releaseTick <= tick).length;
      if (simulation.stats().spawned < due) sawDeferredAdmission = true;
    }

    const stats = simulation.stats();
    expect(sawDeferredAdmission).toBe(true);
    expect(stats.pendingRain).toBe(0);
    expect(stats.spawned).toBe(300);
    expect(
      countFactions([
        ...simulation.coins.values(),
        ...simulation.drainEvents(),
      ]),
    ).toEqual({ ally: 120, enemy: 120, dud: 60 });
    expect(stats.spawned).toBe(stats.active + stats.collected + stats.lost);
    expect(stats.collected).toBe(
      stats.allyCollected + stats.enemyCollected + stats.dudCollected,
    );
  });

  it("rebuilds identical physical faction assignments on reset and leaves geometry unchanged by the mix", async () => {
    const tuning = { density: 48, seed: 71 };
    const first = await simulationWith(tuning);
    const sameSeed = await simulationWith(tuning);
    const allDuds = await simulationWith({
      ...tuning,
      openingEnemyPercent: 0,
      openingDudPercent: 100,
    });
    drainRain(first);
    drainRain(sameSeed);
    drainRain(allDuds);
    const original = snapshot(first);

    expect(snapshot(sameSeed)).toEqual(original);
    expect(
      snapshot(allDuds).map(({ faction: _faction, ...geometry }) => geometry),
    ).toEqual(original.map(({ faction: _faction, ...geometry }) => geometry));
    expect(
      countFactions([...allDuds.coins.values(), ...allDuds.drainEvents()]),
    ).toEqual({ ally: 0, enemy: 0, dud: 48 });
    expect(allDuds.stats()).toMatchObject({
      allyCollected: 0,
      enemyCollected: 0,
    });
    expect(allDuds.stats().collected).toBe(allDuds.stats().dudCollected);

    first.reset();
    drainRain(first);
    expect(snapshot(first)).toEqual(original);
  });

  it("ignores live mix edits and replaces an in-flight mix only on reset", async () => {
    const simulation = await simulationWith({ density: 96, seed: 31 });
    simulation.step();
    const before = snapshot(simulation);
    simulation.configure({ openingEnemyPercent: 0, openingDudPercent: 100 });
    expect(simulation.tuning).toMatchObject({
      openingEnemyPercent: 40,
      openingDudPercent: 20,
    });
    expect(snapshot(simulation)).toEqual(before);
    drainRain(simulation);
    expect(
      countFactions([
        ...simulation.coins.values(),
        ...simulation.drainEvents(),
      ]),
    ).toEqual({ ally: 39, enemy: 38, dud: 19 });

    simulation.reset({ density: 96 });
    simulation.step();
    simulation.reset({
      density: 9,
      openingEnemyPercent: 0,
      openingDudPercent: 100,
    });
    expect(simulation.stats()).toMatchObject({
      pendingRain: 9,
      spawned: 0,
      collected: 0,
      allyCollected: 0,
      enemyCollected: 0,
      dudCollected: 0,
      lost: 0,
    });
    expect(simulation.drainEvents()).toEqual([]);
    drainRain(simulation);
    expect(countFactions(simulation.coins.values())).toEqual({
      ally: 0,
      enemy: 0,
      dud: 9,
    });
    expect(simulation.stats().spawned).toBe(9);
  });

  it("accepts dud chute coins without assigning them to either side", async () => {
    const simulation = await simulationWith({ density: 0 });
    const ids = simulation.releaseChutes([{ x: 0, count: 3, faction: "dud" }]);
    expect(ids).toEqual([1, 2, 3]);
    expect(countFactions(simulation.coins.values())).toEqual({
      ally: 0,
      enemy: 0,
      dud: 3,
    });
  });
});
