import type * as RAPIER from "@dimforge/rapier3d-compat";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedLayout } from "../src/combat/types";
import type { CoinType, CoinView, NativeFeedAdmission, Simulation } from "../src/contracts";
import { FEED_TRAY_COS, FEED_TRAY_SIN, getFeedTrayGeometry } from "../src/feed-geometry";
import { createSimulation } from "../src/simulation";
import { PLAYER_DROP_Z } from "../src/simulation/config";
import type { RapierWorld } from "../src/simulation/rapier-world";

const simulations: Simulation[] = [];
const bag: readonly CoinType[] = ["sword", "skull", "potion", "gold", "bomb"];

function lane(index: number, count: number, radius: number): FeedLayout {
  const playerSlots = [0, 1, -1];
  const enemySlots = [-2, 2, -3];
  const source = index < 3 ? "player" : "enemy";
  const ordinal = source === "player" ? index : index - 3;
  const slot = (source === "player" ? playerSlots : enemySlots)[ordinal]!;
  return {
    id: `${source}-${ordinal}`,
    ownerId: source === "player" ? "player" : `enemy-${ordinal}`,
    enabled: true,
    slot,
    x: (index - (count - 1) / 2) * (2 * radius + 0.02),
    source,
    preview: bag,
  };
}

async function create(lanes: number, radius = 0.32, thickness = 0.13): Promise<Simulation> {
  const simulation = await createSimulation({ density: 0, radius, thickness });
  simulations.push(simulation);
  simulation.setFeedLayout(Array.from({ length: lanes }, (_, index) => lane(index, lanes, radius)));
  return simulation;
}

function world(simulation: Simulation): RapierWorld {
  // Physical regressions intentionally inspect the concrete native adapter to verify identity.
  const fixture = simulation as unknown as { world: RapierWorld };
  return fixture.world;
}

function localZ(coin: CoinView, simulation: Simulation): number {
  return -(coin.position.y - simulation.tuning.dropHeight) * FEED_TRAY_SIN +
    (coin.position.z - PLAYER_DROP_Z) * FEED_TRAY_COS;
}

function advanceBurst(simulation: Simulation, count: number, maximumTicks = 3600): NativeFeedAdmission[] {
  const admissions: NativeFeedAdmission[] = [];
  for (let tick = 0; tick < maximumTicks && admissions.length < count; tick++) {
    simulation.step();
    admissions.push(...simulation.drainFeedAdmissions());
  }
  return admissions;
}

afterEach(() => {
  for (const simulation of simulations) simulation.dispose();
  simulations.length = 0;
});

describe("native five-row feed burst", () => {
  it("keeps the captured bodies, colliders, and velocities native until their real outlet crossing", async () => {
    const simulation = await create(1);
    const tray = simulation.feedTrays()[0]!;
    const captured = tray.coins.map((coin) => {
      const body = world(simulation).nativeBody(coin.id)!;
      return { coin, body, collider: body.collider(0), velocity: { ...body.linvel() } };
    });

    expect(simulation.startFeedBurst()).toBe(true);
    expect(simulation.stats()).toMatchObject({ spawned: 0, active: 0 });
    expect(tray.burst).toMatchObject({ phase: "emitting", trapRetracted: true });
    captured.forEach(({ coin, body, collider, velocity }) => {
      expect(world(simulation).nativeBody(coin.id)).toBe(body);
      expect(body.collider(0)).toBe(collider);
      expect(body.linvel()).toEqual(velocity);
    });

    const admissions = advanceBurst(simulation, 5);
    expect(admissions.map(({ row }) => row)).toEqual([1, 2, 3, 4, 5]);
    admissions.forEach((admission, index) => {
      expect(world(simulation).nativeBody(admission.id)).toBe(captured[index]!.body);
      expect(captured[index]!.body.collider(0)).toBe(captured[index]!.collider);
      expect(simulation.coins.get(admission.id)).toMatchObject({ type: bag[index] });
    });
    expect(simulation.stats().spawned).toBe(5);
  });

  it("preflights every enabled lane atomically and preserves all stock when one real exit is blocked", async () => {
    const simulation = await create(3);
    expect(simulation.drop(0)).toBe(true);
    const before = simulation.feedTrays().map((tray) => tray.coins.map(({ id }) => id));

    expect(simulation.startFeedBurst()).toBe(false);
    expect(simulation.feedTrays().map((tray) => tray.coins.map(({ id }) => id))).toEqual(before);
    expect(simulation.feedTrays().every(({ gateOpen, burst }) => !gateOpen && burst.phase === "idle")).toBe(true);
    expect(simulation.stats()).toMatchObject({ spawned: 1, active: 1 });
  });

  it("holds guided stock through a late real-corridor jam without admission or replacement", async () => {
    const simulation = await create(1);
    const tray = simulation.feedTrays()[0]!;
    const front = tray.coins[0]!;
    const frontBody = world(simulation).nativeBody(front.id)!;
    expect(simulation.startFeedBurst()).toBe(true);
    const blockerId = 10_000;
    expect(world(simulation).addCylinder(blockerId, {
      position: { x: front.position.x, y: front.position.y - 0.4, z: front.position.z },
      radius: front.radius,
      thickness: front.thickness,
    })).toBe(true);
    const blocker = world(simulation).nativeBody(blockerId)!;
    blocker.setGravityScale(0, true);
    blocker.lockTranslations(true, true);

    for (let tick = 0; tick < 30; tick++) simulation.step();
    expect(simulation.drainFeedAdmissions()).toEqual([]);
    expect(tray.coins[0]).toBe(front);
    expect(world(simulation).nativeBody(front.id)).toBe(frontBody);
    expect(tray.burst.cohort[0]).toMatchObject({ row: 1, admittedId: null });

    expect(world(simulation).removeCylinder(blockerId)).toBe(true);
    const [admission] = advanceBurst(simulation, 1);
    expect(admission).toMatchObject({ row: 1, type: front.type });
    expect(world(simulation).nativeBody(admission!.id)).toBe(frontBody);
  });

  it("recloses after admitted bodies clear the finite tray beyond its front edge", async () => {
    const simulation = await create(1);
    const tray = simulation.feedTrays()[0]!;
    expect(simulation.startFeedBurst()).toBe(true);
    const admissions = advanceBurst(simulation, 5);
    expect(tray.gateOpen).toBe(true);

    const bodies = admissions.map(({ id }, index) => {
      const body = world(simulation).nativeBody(id)!;
      body.setTranslation({ x: tray.x, y: 1.5, z: 0.5 + index * 0.7 }, true);
      body.setGravityScale(0, true);
      body.lockTranslations(true, true);
      return body;
    });
    simulation.step();
    simulation.drainFeedAdmissions();

    expect(tray.gateOpen).toBe(false);
    expect(tray.burst.trapRetracted).toBe(false);
    admissions.forEach(({ id }, index) =>
      expect(world(simulation).nativeBody(id)).toBe(bodies[index]));
  });

  it("cancels an unopened cohort without admissions or token/body replacement", async () => {
    const simulation = await create(2);
    const before = simulation.feedTrays().map((tray) => tray.coins.map((coin) => ({
      id: coin.id,
      body: world(simulation).nativeBody(coin.id),
    })));

    expect(simulation.startFeedBurst()).toBe(true);
    simulation.cancelFeedBurst();
    for (let tick = 0; tick < 120; tick++) simulation.step();

    expect(simulation.drainFeedAdmissions()).toEqual([]);
    expect(simulation.stats()).toMatchObject({ spawned: 0, active: 0 });
    simulation.feedTrays().forEach((tray, laneIndex) => {
      expect(tray.burst.phase).toBe("idle");
      expect(tray.gateOpen).toBe(false);
      expect(tray.coins.map(({ id }) => id)).toEqual(before[laneIndex]!.map(({ id }) => id));
      tray.coins.forEach((coin, index) =>
        expect(world(simulation).nativeBody(coin.id)).toBe(before[laneIndex]![index]!.body));
    });
  });

  it("refills one real hidden-rear cylinder at a time and settles five before accepting another cohort", async () => {
    const simulation = await create(1);
    expect(simulation.startFeedBurst()).toBe(true);
    expect(advanceBurst(simulation, 5)).toHaveLength(5);
    const geometry = getFeedTrayGeometry(
      simulation.tuning.radius,
      simulation.tuning.thickness,
      simulation.tuning.dropHeight,
    );
    const observed = new Set<number>();
    let previousCount = 0;
    for (let tick = 0; tick < 3600 && simulation.feedTrays()[0]!.burst.phase !== "idle"; tick++) {
      simulation.step();
      simulation.drainFeedAdmissions();
      // Wave transitions can cancel after the regular refill in the same tick.
      simulation.cancelFeedBurst();
      const coins = simulation.feedTrays()[0]!.coins;
      expect(coins.length - previousCount).toBeLessThanOrEqual(1);
      for (const coin of coins) {
        if (observed.has(coin.id)) continue;
        observed.add(coin.id);
        expect(localZ(coin, simulation)).toBeCloseTo(geometry.refillInsertionZ, 4);
      }
      previousCount = coins.length;
    }
    const tray = simulation.feedTrays()[0]!;
    expect(tray.burst.phase).toBe("idle");
    expect(tray.coins).toHaveLength(5);
    expect(simulation.startFeedBurst()).toBe(true);
  });

  it.each([
    { radius: 0.32, thickness: 0.13 },
    { radius: 0.24, thickness: 0.0975 },
  ])("admits exactly five rows across three player and three enemy lanes at $radius radius", async (tuning) => {
    const simulation = await create(6, tuning.radius, tuning.thickness);
    expect(simulation.startFeedBurst()).toBe(true);
    const admissions = advanceBurst(simulation, 30, 5400);

    expect(admissions).toHaveLength(30);
    for (let row = 1; row <= 5; row++) {
      const fragment = admissions.filter((admission) => admission.row === row);
      expect(fragment).toHaveLength(6);
      expect(new Set(fragment.map(({ chuteId }) => chuteId)).size).toBe(6);
    }
    expect(simulation.stats().spawned).toBe(30);
  });
});
