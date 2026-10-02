import * as RAPIER from "@dimforge/rapier3d-compat";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUNING,
  classifyCoinPosition,
  createSimulation,
} from "../src/simulation";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";
import type { CollectionEvent, Simulation, Tuning } from "../src/contracts";

function advance(simulation: Simulation, steps: number): void {
  for (let index = 0; index < steps; index += 1) simulation.step();
}

function drainRain(simulation: Simulation, limit = 2_000): void {
  for (let index = 0; index < limit; index += 1) {
    if (simulation.stats().pendingRain === 0) return;
    simulation.step();
  }
  expect(simulation.stats().pendingRain).toBe(0);
}

function expectConservation(simulation: Simulation): void {
  const stats = simulation.stats();
  expect(stats.spawned).toBe(stats.active + stats.collected + stats.lost);
  expect(stats.pendingRain).toBeGreaterThanOrEqual(0);
}

function stateWithoutIds(
  simulation: Simulation,
): Array<Record<string, number>> {
  return [...simulation.coins.values()].map((coin) => ({
    x: Number(coin.position.x.toFixed(8)),
    y: Number(coin.position.y.toFixed(8)),
    z: Number(coin.position.z.toFixed(8)),
    qx: Number(coin.rotation.x.toFixed(8)),
    qy: Number(coin.rotation.y.toFixed(8)),
    qz: Number(coin.rotation.z.toFixed(8)),
    qw: Number(coin.rotation.w.toFixed(8)),
    radius: coin.radius,
    thickness: coin.thickness,
  }));
}

async function simulationWith(tuning: Partial<Tuning>): Promise<Simulation> {
  const simulation = await createSimulation({ ...DEFAULT_TUNING, ...tuning });
  drainRain(simulation);
  return simulation;
}

describe("physical simulation lifecycle", () => {
  it("starts with conserved counters, including staged rain", async () => {
    const simulation = await createSimulation({
      ...DEFAULT_TUNING,
      density: 24,
    });

    expectConservation(simulation);
    drainRain(simulation);
    advance(simulation, 120);
    expectConservation(simulation);

    simulation.dispose();
  });

  it("resets counters idempotently while keeping coin identities monotonic", async () => {
    const simulation = await simulationWith({ density: 8, seed: 11 });
    const firstIds = [...simulation.coins.keys()];
    const largestFirstId = Math.max(...firstIds);

    simulation.reset();
    drainRain(simulation);
    const resetStats = simulation.stats();
    const secondIds = [...simulation.coins.keys()];
    expect(resetStats.collected).toBe(0);
    expect(resetStats.lost).toBe(0);
    expect(resetStats.spawned).toBe(resetStats.active);
    expect(secondIds.every((id) => id > largestFirstId)).toBe(true);

    const stateAfterFirstReset = stateWithoutIds(simulation);
    simulation.reset();
    drainRain(simulation);
    expect(stateWithoutIds(simulation)).toEqual(stateAfterFirstReset);
    expectConservation(simulation);

    simulation.dispose();
  });

  it("repeats a seeded pile deterministically", async () => {
    const first = await simulationWith({ density: 18, seed: 2026 });
    const second = await simulationWith({ density: 18, seed: 2026 });

    advance(first, 1);
    advance(second, 1);
    expect(stateWithoutIds(first)).toEqual(stateWithoutIds(second));
    expect(first.stats().active).toBe(second.stats().active);
    expect(first.stats().spawned).toBe(second.stats().spawned);

    first.dispose();
    second.dispose();
  });

  it("rebuilds the same deterministic state after reseeding", async () => {
    const tuning = { density: 12, seed: 17 };
    const simulation = await simulationWith(tuning);
    simulation.reset({ seed: 91 });
    drainRain(simulation);

    const fresh = await simulationWith({ ...tuning, seed: 91 });
    expect(stateWithoutIds(simulation)).toEqual(stateWithoutIds(fresh));

    simulation.dispose();
    fresh.dispose();
  });

  it("caps drops by simulation time and admits a later drop", async () => {
    const simulation = await simulationWith({ density: 0, dropRate: 2 });

    expect(simulation.drop(0)).toBe(true);
    expect(simulation.drop(0)).toBe(false);
    advance(simulation, 29);
    expect(simulation.drop(0)).toBe(false);
    advance(simulation, 3);
    expect(simulation.drop(0)).toBe(true);

    simulation.dispose();
  });

  it("places back-row drops above support with the same admission cadence", async () => {
    const simulation = await simulationWith({
      density: 0,
      dropRate: 30,
      stroke: 0,
    });

    expect(simulation.drop(0, "back-row")).toBe(true);
    const first = [...simulation.coins.values()][0]!;
    expect(first.position).toMatchObject({
      x: 0,
      z: -3.15,
    });
    expect(first.position.y).toBeCloseTo(
      0.6 + simulation.tuning.thickness / 2 + 0.02,
      8,
    );
    expect(first.rotation).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(simulation.drop(0, "back-row")).toBe(false);

    advance(simulation, 2);
    expect(simulation.drop(0, "back-row")).toBe(true);
    const coins = [...simulation.coins.values()];
    const second = coins.find((coin) => coin.id !== first.id)!;
    const centerDistance = Math.hypot(
      first.position.x - second.position.x,
      first.position.y - second.position.y,
      first.position.z - second.position.z,
    );
    const boundingRadius = Math.hypot(
      simulation.tuning.radius,
      simulation.tuning.thickness / 2,
    );
    expect(centerDistance).toBeGreaterThanOrEqual(
      boundingRadius * 2 + 0.02 - 1e-7,
    );
    expectConservation(simulation);

    simulation.dispose();
  });

  it("rejects a back-row stack at top containment without consuming admission", async () => {
    const simulation = await simulationWith({
      density: 0,
      dropRate: 30,
      radius: 0.75,
      thickness: 0.4,
      stroke: 0,
    });

    expect(simulation.drop(0, "back-row")).toBe(true);
    advance(simulation, 2);
    expect(simulation.drop(0, "back-row")).toBe(true);
    advance(simulation, 2);
    expect(simulation.drop(0, "back-row")).toBe(false);
    expect(simulation.drop(3, "back-row")).toBe(true);
    expect(simulation.stats().spawned).toBe(3);
    expectConservation(simulation);

    simulation.dispose();
  });

  it("contains a sustained default-rate feed at the side and rear", async () => {
    const simulation = await simulationWith({
      density: 0,
      dropRate: DEFAULT_TUNING.dropRate,
      dropHeight: DEFAULT_TUNING.dropHeight,
      friction: DEFAULT_TUNING.friction,
      stroke: DEFAULT_TUNING.stroke,
      period: DEFAULT_TUNING.period,
    });

    for (let step = 0; step < 900; step += 1) {
      simulation.drop(step % 2 === 0 ? -4.4 : 4.4);
      simulation.step();
    }

    const stats = simulation.stats();
    expect(stats.spawned).toBeGreaterThan(50);
    expect(stats.lost).toBe(0);
    expectConservation(simulation);
    expect(stats.spawned).toBe(stats.active + stats.collected);

    simulation.dispose();
  });

  it.each([150, 300, 500, 1_000])(
    "keeps a %i-coin starting rain conserved and finite",
    async (density) => {
      const simulation = await simulationWith({ density, seed: 7 });
      advance(simulation, 180);

      expect(simulation.stats().spawned).toBe(density);
      for (const coin of simulation.coins.values()) {
        expect(Number.isFinite(coin.position.x)).toBe(true);
        expect(Number.isFinite(coin.position.y)).toBe(true);
        expect(Number.isFinite(coin.position.z)).toBe(true);
        expect(Number.isFinite(coin.rotation.x)).toBe(true);
        expect(Number.isFinite(coin.rotation.y)).toBe(true);
        expect(Number.isFinite(coin.rotation.z)).toBe(true);
        expect(Number.isFinite(coin.rotation.w)).toBe(true);
        expect(Math.abs(coin.position.y)).toBeLessThan(20);
      }
      expectConservation(simulation);
      simulation.dispose();
    },
    30_000,
  );

  it("applies live stroke and period to physical pusher movement", async () => {
    const simulation = await simulationWith({ density: 0 });

    simulation.configure({ stroke: 0, period: 1 });
    advance(simulation, 15);
    expect(simulation.stats().pusherZ).toBeCloseTo(-3, 5);

    simulation.configure({ stroke: 2, period: 1 });
    advance(simulation, 15);
    const moved = simulation.stats();
    expect(moved.pusherZ).toBeCloseTo(-1, 5);
    expect(moved.phase).toBeCloseTo(0.5, 5);

    simulation.dispose();
  });

  it("drains one physically collected coin exactly once", async () => {
    await RAPIER.init();
    const world = new RapierWorld(DEFAULT_TUNING);
    const lifecycle = new CoinLifecycle();
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    const frontCoin = lifecycle.spawn(
      { x: 0, y: 0.2, z: 4.5 },
      rotation,
      DEFAULT_TUNING.radius,
      DEFAULT_TUNING.thickness,
    );
    const lostCoin = lifecycle.spawn(
      { x: 0, y: -1, z: 3.5 },
      rotation,
      DEFAULT_TUNING.radius,
      DEFAULT_TUNING.thickness,
    );
    expect(world.addCylinder(frontCoin.id, frontCoin)).toBe(true);
    expect(world.addCylinder(lostCoin.id, lostCoin)).toBe(true);

    const events: CollectionEvent[] = [];
    let frontYBeforeCrossing = frontCoin.position.y;
    for (let step = 0; step < 120 && lifecycle.active > 0; step += 1) {
      world.step();
      world.forEachCoin((id, body) => {
        const position = body.translation();
        const bodyRotation = body.rotation();
        const resolution = classifyCoinPosition(
          position,
          DEFAULT_TUNING.shelfFront,
        );
        if (!resolution) {
          if (id === frontCoin.id) frontYBeforeCrossing = position.y;
          lifecycle.update(id, position, bodyRotation);
          return;
        }

        if (resolution === "collected") lifecycle.collect(id, position);
        else lifecycle.lose(id, position);
        world.removeCylinder(id);
      });
      events.push(...lifecycle.drainEvents());
    }

    expect(events).toEqual([
      {
        id: lostCoin.id,
        kind: "lost",
        faction: "ally",
        position: expect.objectContaining({
          y: expect.any(Number),
          z: expect.any(Number),
        }),
      },
      {
        id: frontCoin.id,
        kind: "collected",
        faction: "ally",
        position: expect.objectContaining({
          y: expect.any(Number),
          z: expect.any(Number),
        }),
      },
    ]);
    const collected = events[1];
    expect(frontYBeforeCrossing).toBeGreaterThanOrEqual(-0.45);
    expect(collected?.position.y).toBeLessThan(-0.45);
    expect(collected?.position.z).toBeGreaterThan(4);
    expect(lifecycle.coins.has(frontCoin.id)).toBe(false);
    expect(lifecycle.coins.has(lostCoin.id)).toBe(false);
    expect(lifecycle.stats()).toEqual({
      active: 0,
      spawned: 2,
      collected: 1,
      allyCollected: 1,
      enemyCollected: 0,
      lost: 1,
    });

    world.step();
    expect(lifecycle.drainEvents()).toEqual([]);
    expect(world.removeCylinder(frontCoin.id)).toBe(false);
    expect(world.removeCylinder(lostCoin.id)).toBe(false);
    expect(lifecycle.collect(frontCoin.id)).toBe(false);
    expect(lifecycle.lose(lostCoin.id)).toBe(false);
    expect(lifecycle.stats()).toEqual({
      active: 0,
      spawned: 2,
      collected: 1,
      allyCollected: 1,
      enemyCollected: 0,
      lost: 1,
    });

    world.dispose();
  });

  it("collects at a shortened front while preserving the fixed rear shelf", async () => {
    await RAPIER.init();
    const shelfFront = 2.5;
    const world = new RapierWorld({ ...DEFAULT_TUNING, shelfFront });
    const lifecycle = new CoinLifecycle();
    const rotation = { x: 0, y: 0, z: 0, w: 1 };
    const frontCoin = lifecycle.spawn(
      { x: 0, y: 0.2, z: 3 },
      rotation,
      DEFAULT_TUNING.radius,
      DEFAULT_TUNING.thickness,
    );
    const rearCoin = lifecycle.spawn(
      { x: 0, y: 0.3, z: -3.65 },
      rotation,
      DEFAULT_TUNING.radius,
      DEFAULT_TUNING.thickness,
    );
    expect(world.addCylinder(frontCoin.id, frontCoin)).toBe(true);
    expect(world.addCylinder(rearCoin.id, rearCoin)).toBe(true);

    const events: CollectionEvent[] = [];
    for (let step = 0; step < 180; step += 1) {
      world.step();
      world.forEachCoin((id, body) => {
        const position = body.translation();
        const resolution = classifyCoinPosition(position, shelfFront);
        if (resolution === "collected") lifecycle.collect(id, position);
        else if (resolution === "lost") lifecycle.lose(id, position);
        else lifecycle.update(id, position, body.rotation());
        if (resolution) world.removeCylinder(id);
      });
      events.push(...lifecycle.drainEvents());
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: frontCoin.id,
      kind: "collected",
      position: { z: expect.any(Number) },
    });
    expect(events[0]!.position.z).toBeGreaterThan(shelfFront);
    expect(lifecycle.coins.has(rearCoin.id)).toBe(true);
    const supportedRear = lifecycle.coins.get(rearCoin.id)!;
    expect(supportedRear.position.z).toBeGreaterThan(-4);
    expect(supportedRear.position.y).toBeGreaterThan(-0.45);
    expect(lifecycle.drainEvents()).toEqual([]);

    world.dispose();
  });

  it("resolves one lost coin once and clears it on reset", () => {
    const lifecycle = new CoinLifecycle();
    const coin = lifecycle.spawn(
      { x: 0, y: 0.5, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      0.32,
      0.13,
    );
    const lostPosition = { x: 0.25, y: -9, z: 0 };

    expect(lifecycle.lose(coin.id, lostPosition)).toBe(true);
    expect(lifecycle.lose(coin.id, lostPosition)).toBe(false);
    expect(lifecycle.collect(coin.id, lostPosition)).toBe(false);
    expect(lifecycle.coins.has(coin.id)).toBe(false);
    expect(lifecycle.drainEvents()).toEqual([
      { id: coin.id, kind: "lost", faction: "ally", position: lostPosition },
    ]);
    expect(lifecycle.drainEvents()).toEqual([]);
    expect(lifecycle.stats()).toEqual({
      active: 0,
      spawned: 1,
      collected: 0,
      allyCollected: 0,
      enemyCollected: 0,
      lost: 1,
    });
    expect(lifecycle.stats().spawned).toBe(
      lifecycle.stats().active +
        lifecycle.stats().collected +
        lifecycle.stats().lost,
    );

    lifecycle.reset();
    expect(lifecycle.drainEvents()).toEqual([]);
    expect(lifecycle.stats()).toEqual({
      active: 0,
      spawned: 0,
      collected: 0,
      allyCollected: 0,
      enemyCollected: 0,
      lost: 0,
    });
    const nextCoin = lifecycle.spawn(
      { x: 0, y: 0.5, z: 0 },
      { x: 0, y: 0, z: 0, w: 1 },
      0.32,
      0.13,
    );
    expect(nextCoin.id).toBeGreaterThan(coin.id);
  });

  it("applies live tuning immediately and shape tuning on reset", async () => {
    const simulation = await simulationWith({
      density: 4,
      radius: 0.25,
      thickness: 0.1,
    });
    const oldRadius = [...simulation.coins.values()][0]?.radius;
    const oldThickness = [...simulation.coins.values()][0]?.thickness;

    simulation.configure({
      friction: 0.91,
      stroke: 2.2,
      period: 3.2,
      dropHeight: 4.2,
      shelfFront: 2.5,
      dropRate: 4,
      radius: 0.47,
      thickness: 0.19,
      density: 6,
      seed: 99,
    });
    expect(simulation.tuning.friction).toBeCloseTo(0.91);
    expect(simulation.tuning.stroke).toBeCloseTo(2.2);
    expect(simulation.tuning.period).toBeCloseTo(3.2);
    expect(simulation.tuning.dropHeight).toBeCloseTo(4.2);
    expect(simulation.tuning.dropRate).toBeCloseTo(4);
    expect(simulation.tuning.shelfFront).toBe(DEFAULT_TUNING.shelfFront);
    expect(simulation.tuning.radius).toBeCloseTo(0.25);
    expect(simulation.tuning.thickness).toBeCloseTo(0.1);
    expect(simulation.tuning.density).toBe(4);
    expect(simulation.tuning.seed).toBe(1337);
    expect(simulation.drop(99)).toBe(true);
    const droppedId = Math.max(...simulation.coins.keys());
    const dropped = simulation.coins.get(droppedId);
    expect(dropped?.position).toMatchObject({ x: 4.4, y: 4.2 });
    expect(
      [...simulation.coins.values()].every((coin) => coin.radius === oldRadius),
    ).toBe(true);
    expect(
      [...simulation.coins.values()].every(
        (coin) => coin.thickness === oldThickness,
      ),
    ).toBe(true);

    simulation.reset({
      radius: 0.47,
      thickness: 0.19,
      density: 6,
      seed: 99,
      shelfFront: 2.5,
    });
    drainRain(simulation);
    expect(simulation.tuning.radius).toBeCloseTo(0.47);
    expect(simulation.tuning.thickness).toBeCloseTo(0.19);
    expect(simulation.tuning.shelfFront).toBeCloseTo(2.5);
    expect(simulation.tuning.density).toBe(6);
    expect(simulation.tuning.seed).toBe(99);
    expect(
      [...simulation.coins.values()].every((coin) => coin.radius === 0.47),
    ).toBe(true);
    expect(
      [...simulation.coins.values()].every((coin) => coin.thickness === 0.19),
    ).toBe(true);

    simulation.dispose();
  });

  it("sanitizes hostile tuning values at the public boundary", async () => {
    const simulation = await createSimulation({
      seed: Number.POSITIVE_INFINITY,
      density: Number.NaN,
      radius: Number.NEGATIVE_INFINITY,
      thickness: Number.POSITIVE_INFINITY,
      friction: Number.NaN,
      stroke: Number.POSITIVE_INFINITY,
      period: Number.NEGATIVE_INFINITY,
      shelfFront: Number.NaN,
      dropHeight: Number.NaN,
      dropRate: Number.POSITIVE_INFINITY,
    });

    const tuning = simulation.tuning;
    for (const value of Object.values(tuning))
      expect(Number.isFinite(value)).toBe(true);
    expect(Number.isInteger(tuning.seed)).toBe(true);
    expect(Number.isInteger(tuning.density)).toBe(true);
    expect(tuning.density).toBeGreaterThanOrEqual(0);
    expect(tuning.density).toBeLessThanOrEqual(1000);
    expect(tuning.shelfFront).toBe(DEFAULT_TUNING.shelfFront);
    simulation.reset({ density: 0, shelfFront: -99 });
    expect(simulation.tuning.shelfFront).toBe(2.5);
    simulation.reset({ shelfFront: 99 });
    expect(simulation.tuning.shelfFront).toBe(4);
    simulation.dispose();
  });

  it("is safe to dispose repeatedly", async () => {
    const simulation = await simulationWith({ density: 0 });
    expect(() => {
      simulation.dispose();
      simulation.dispose();
    }).not.toThrow();
  });
});
