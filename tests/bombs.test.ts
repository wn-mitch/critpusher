import * as RAPIER from "@dimforge/rapier3d-compat";
import { describe, expect, it } from "vitest";
import { GOLD_ONLY_MIX } from "../src/combat/config";
import type { CoinType, CoinView, Simulation, Vec3 } from "../src/contracts";
import { DEFAULT_TUNING, createSimulation } from "../src/simulation";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";

type SimulationRuntime = {
  world: RapierWorld;
  lifecycle: CoinLifecycle;
};

function runtime(simulation: Simulation): SimulationRuntime {
  return simulation as unknown as SimulationRuntime;
}

function addCoin(
  simulation: Simulation,
  type: CoinType,
  position: Vec3,
): CoinView {
  const { lifecycle, world } = runtime(simulation);
  const coin = lifecycle.spawn(
    position,
    { x: 0, y: 0, z: 0, w: 1 },
    simulation.tuning.radius,
    simulation.tuning.thickness,
    type,
  );
  expect(world.addCylinder(coin.id, coin)).toBe(true);
  return coin;
}

function setVelocity(
  simulation: Simulation,
  id: number,
  velocity: Vec3,
): void {
  let found = false;
  runtime(simulation).world.forEachCoin((coinId, body) => {
    if (coinId !== id) return;
    body.setLinvel(velocity, true);
    found = true;
  });
  expect(found).toBe(true);
}


async function bombSimulation(): Promise<Simulation> {
  return createSimulation(
    { ...DEFAULT_TUNING, density: 0, friction: 0 },
    {
      openingMix: GOLD_ONLY_MIX,
      bomb: {
        hitThreshold: 1,
        minClosingSpeed: 0.1,
        blastRadius: 1.75,
        blastDeltaSpeed: 3,
      },
    },
  );
}

describe("bomb resolution through the real Rapier simulation", () => {
  it("resolves collection and loss before a same-tick impact can arm a bomb", async () => {
    await RAPIER.init();

    for (const terminal of [
      { bomb: { x: 0, y: -1, z: 4.1 }, kind: "collected" },
      { bomb: { x: 0, y: -1, z: 3.1 }, kind: "lost" },
    ] as const) {
      const simulation = await bombSimulation();
      try {
        const bomb = addCoin(simulation, "bomb", terminal.bomb);
        const striker = addCoin(simulation, "sword", {
          x: 0,
          y: -1,
          z: terminal.bomb.z - 0.6,
        });
        setVelocity(simulation, striker.id, { x: 0, y: 0, z: 6 });
        simulation.setBombsActive(true);

        simulation.step();
        const events = simulation.drainEvents();
        expect(events).toContainEqual(
          expect.objectContaining({ id: bomb.id, kind: terminal.kind }),
        );
        expect(events.some((event) => event.kind === "detonated")).toBe(false);
        expect(simulation.coins.has(bomb.id)).toBe(false);
        expect(simulation.stats().detonated).toBe(0);
      } finally {
        simulation.dispose();
      }
    }
  });

  it("detonates simultaneous bomb-bomb threshold crossings once each", async () => {
    await RAPIER.init();
    const simulation = await bombSimulation();
    try {
      const first = addCoin(simulation, "bomb", { x: 0, y: 0.3, z: 1 });
      const second = addCoin(simulation, "bomb", { x: 0, y: 0.3, z: 1.6 });
      setVelocity(simulation, first.id, { x: 0, y: 0, z: 6 });
      simulation.setBombsActive(true);

      simulation.step();
      expect(
        simulation
          .drainEvents()
          .filter((event) => event.kind === "detonated")
          .map((event) => event.id)
          .sort((left, right) => left - right),
      ).toEqual([first.id, second.id]);
      expect(simulation.stats()).toMatchObject({
        active: 0,
        spawned: 2,
        detonated: 2,
        collected: 0,
        lost: 0,
      });

      simulation.step();
      expect(simulation.drainEvents()).toEqual([]);
    } finally {
      simulation.dispose();
    }
  });

  it("requires a secondary physical blast impact rather than direct radius hits", async () => {
    await RAPIER.init();
    const simulation = await bombSimulation();
    try {
      const source = addCoin(simulation, "bomb", { x: 0, y: 0.3, z: 0 });
      const striker = addCoin(simulation, "sword", { x: 0, y: 0.3, z: -0.6 });
      const shuttle = addCoin(simulation, "sword", { x: 0.7, y: 0.3, z: 0 });
      const target = addCoin(simulation, "bomb", { x: 1.4, y: 0.3, z: 0 });
      setVelocity(simulation, striker.id, { x: 0, y: 0, z: 6 });
      simulation.setBombsActive(true);

      simulation.step();
      const events = simulation.drainEvents();
      expect(
        events.filter((event) => event.kind === "detonated"),
      ).toEqual([expect.objectContaining({ id: source.id })]);
      expect(simulation.coins.get(target.id)?.bombHits).toBe(0);
      let shuttleVelocityX: number | undefined;
      runtime(simulation).world.forEachCoin((coinId, body) => {
        if (coinId === shuttle.id) shuttleVelocityX = body.linvel().x;
      });
      expect(shuttleVelocityX).toBeGreaterThan(0);

      for (
        let tick = 0;
        tick < 12 && simulation.coins.has(target.id);
        tick += 1
      ) {
        simulation.step();
        events.push(...simulation.drainEvents());
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          id: target.id,
          kind: "detonated",
          chainRootId: source.id,
          blastAssociated: true,
        }),
      );
    } finally {
      simulation.dispose();
    }
  });

  it("does not arm an already-resting contact when bombs are activated", async () => {
    await RAPIER.init();
    const simulation = await bombSimulation();
    try {
      const bomb = addCoin(simulation, "bomb", { x: 0, y: 0.3, z: 1 });
      addCoin(simulation, "sword", { x: 0, y: 0.3, z: 1.6 });

      for (let tick = 0; tick < 180; tick += 1) simulation.step();
      simulation.setBombsActive(true);
      for (let tick = 0; tick < 180; tick += 1) simulation.step();

      expect(simulation.coins.get(bomb.id)?.bombHits).toBe(0);
      expect(
        simulation.drainEvents().filter((event) => event.kind === "detonated"),
      ).toEqual([]);
    } finally {
      simulation.dispose();
    }
  });
});
