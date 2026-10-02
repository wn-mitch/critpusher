import { afterEach, describe, expect, it } from "vitest";
import type { Simulation } from "../src/contracts";
import { createSimulation } from "../src/simulation";
import { PLAYER_DROP_Z } from "../src/simulation/config";

const simulations: Simulation[] = [];

async function simulationWith(
  tuning: Parameters<typeof createSimulation>[0] = {},
): Promise<Simulation> {
  const simulation = await createSimulation({ density: 0, ...tuning });
  simulations.push(simulation);
  return simulation;
}

function advance(simulation: Simulation, steps: number): void {
  for (let index = 0; index < steps; index += 1) simulation.step();
}

function expectConserved(simulation: Simulation): void {
  const stats = simulation.stats();
  expect(stats.spawned).toBe(stats.active + stats.collected + stats.lost);
}

afterEach(() => {
  for (const simulation of simulations) simulation.dispose();
  simulations.length = 0;
});

describe("atomic physical chute releases", () => {
  it("releases a flat three-coin stack bottom-to-top at the exact chute pose", async () => {
    const simulation = await simulationWith({ dropRate: 30 });

    const ids = simulation.releaseChutes([{ x: 1.25, count: 3 }]);

    expect(ids).toEqual([1, 2, 3]);
    expect(
      ids!.map((id) => {
        const coin = simulation.coins.get(id)!;
        return [coin.position.x, coin.position.y, coin.position.z];
      }),
    ).toEqual([
      [1.25, simulation.tuning.dropHeight, PLAYER_DROP_Z],
      [
        1.25,
        simulation.tuning.dropHeight + simulation.tuning.thickness + 0.02,
        PLAYER_DROP_Z,
      ],
      [
        1.25,
        simulation.tuning.dropHeight + 2 * (simulation.tuning.thickness + 0.02),
        PLAYER_DROP_Z,
      ],
    ]);
    expect(simulation.releaseChutes([{ x: -1, count: 1 }])).toBeNull();
    expectConserved(simulation);
  });

  it("preflights every chute and preserves state and cooldown on refusal", async () => {
    const simulation = await simulationWith({ dropRate: 30 });
    const before = simulation.stats();

    expect(
      simulation.releaseChutes([
        { x: 0, count: 1 },
        { x: 4.9, count: 1 },
      ]),
    ).toBeNull();
    expect(
      simulation.releaseChutes([
        { x: 0, count: 3 },
        { x: 0, count: 3 },
      ]),
    ).toBeNull();
    expect(simulation.coins.size).toBe(0);
    expect(simulation.stats()).toMatchObject({
      active: before.active,
      spawned: before.spawned,
      collected: before.collected,
      lost: before.lost,
    });

    expect(simulation.releaseChutes([{ x: 0, count: 1 }])).toEqual([1]);
    advance(simulation, 2);
    const occupied = simulation.stats();

    expect(simulation.releaseChutes([{ x: 0, count: 1 }])).toBeNull();
    expect(simulation.stats()).toMatchObject({
      active: occupied.active,
      spawned: occupied.spawned,
      collected: occupied.collected,
      lost: occupied.lost,
    });
    expect(simulation.releaseChutes([{ x: 1, count: 1 }])).toEqual([2]);
    expectConserved(simulation);
  });

  it("uses full coin thickness when enforcing the cabinet top", async () => {
    const simulation = await simulationWith({
      dropHeight: 3.47,
      dropRate: 30,
      thickness: 0.4,
    });

    expect(simulation.releaseChutes([{ x: 0, count: 3 }])).toBeNull();
    expect(simulation.stats()).toMatchObject({
      active: 0,
      spawned: 0,
      lost: 0,
    });

    simulation.configure({ dropHeight: 3.45 });
    expect(simulation.releaseChutes([{ x: 0, count: 3 }])).toEqual([1, 2, 3]);
  });

  it("allows scheduler-owned cadence without bypassing shape checks or explicit intervals", async () => {
    const simulation = await simulationWith({ dropRate: 1 });
    expect(simulation.releaseChutes([{ x: -2, count: 1 }])).toEqual([1]);
    expect(simulation.releaseChutes([{ x: 0, count: 1 }])).toBeNull();
    expect(simulation.releaseChutes([{ x: 0, count: 1 }], 0)).toEqual([2]);
    expect(simulation.releaseChutes([{ x: 0, count: 1 }], 0)).toBeNull();
    expect(simulation.releaseChutes([{ x: 2, count: 1 }], 2)).toBeNull();
    advance(simulation, 1);
    expect(simulation.releaseChutes([{ x: 2, count: 1 }], 2)).toBeNull();
    advance(simulation, 1);
    expect(simulation.releaseChutes([{ x: 2, count: 1 }], 2)).toEqual([3]);
    expectConserved(simulation);
  });

  it("rejects invalid intervals and preserves disabled dropping with a zero override", async () => {
    const simulation = await simulationWith();
    for (const interval of [-1, 0.5, NaN, Infinity]) {
      expect(
        simulation.releaseChutes([{ x: 0, count: 1 }], interval),
      ).toBeNull();
    }
    expect(simulation.releaseChutes([{ x: 0, count: 1 }], 0)).toEqual([1]);
    simulation.configure({ dropRate: 0 });
    expect(simulation.releaseChutes([{ x: 2, count: 1 }], 0)).toBeNull();
    expect(simulation.stats().spawned).toBe(1);
  });

  it("spawns three independent flanking stacks and keeps them finite and conserved", async () => {
    const simulation = await simulationWith({ dropRate: 30 });
    const chutes = [
      { x: -1, count: 3 },
      { x: 0, count: 3 },
      { x: 1, count: 3 },
    ] as const;
    const ids = simulation.releaseChutes(chutes);

    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(new Set(ids!).size).toBe(9);
    for (let chute = 0; chute < chutes.length; chute += 1) {
      for (let level = 0; level < 3; level += 1) {
        const coin = simulation.coins.get(ids![chute * 3 + level]!)!;
        expect(coin.position.x).toBe(chutes[chute]!.x);
        expect(coin.position.y).toBe(
          simulation.tuning.dropHeight +
            level * (simulation.tuning.thickness + 0.02),
        );
        expect(coin.position.z).toBe(PLAYER_DROP_Z);
      }
    }

    for (let step = 0; step < 300; step += 1) {
      simulation.step();
      for (const coin of simulation.coins.values()) {
        expect(Number.isFinite(coin.position.x)).toBe(true);
        expect(Number.isFinite(coin.position.y)).toBe(true);
        expect(Number.isFinite(coin.position.z)).toBe(true);
        expect(Number.isFinite(coin.rotation.x)).toBe(true);
        expect(Number.isFinite(coin.rotation.y)).toBe(true);
        expect(Number.isFinite(coin.rotation.z)).toBe(true);
        expect(Number.isFinite(coin.rotation.w)).toBe(true);
      }
      expectConserved(simulation);
    }
    expect(simulation.stats().spawned).toBe(9);
  });
});
