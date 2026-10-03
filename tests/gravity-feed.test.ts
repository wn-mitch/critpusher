import type * as RAPIER from "@dimforge/rapier3d-compat";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedLayout } from "../src/combat/types";
import type { CoinType, CoinView, Simulation, Tuning } from "../src/contracts";
import { FEED_TRAY_COS, FEED_TRAY_SIN, FEED_TRAY_ROTATION, getFeedTrayGeometry } from "../src/feed-geometry";
import { createSimulation } from "../src/simulation";
import { PLAYER_DROP_Z } from "../src/simulation/config";
import type { RapierWorld } from "../src/simulation/rapier-world";
import type { CoinLifecycle } from "../src/simulation/lifecycle";

const simulations: Simulation[] = [];
const types: CoinType[] = ["bomb", "sword", "gold", "diamond", "potion"];

async function create(tuning: Partial<Tuning> = {}): Promise<Simulation> {
  const simulation = await createSimulation({ density: 0, ...tuning });
  simulations.push(simulation);
  return simulation;
}

function native(simulation: Simulation, id: number): RAPIER.RigidBody {
  const runtime = simulation as unknown as { world: RapierWorld };
  const body = runtime.world.nativeBody(id);
  expect(body).toBeDefined();
  return body!;
}

type LaneOptions = Partial<Pick<FeedLayout, "id" | "ownerId" | "enabled" | "slot" | "source">>;

function lane(x = 0, preview: readonly CoinType[] = types, options: LaneOptions = {}): FeedLayout {
  const source = options.source ?? "player";
  const slot = options.slot ?? 0;
  return {
    id: options.id ?? `${source}-${slot}`,
    ownerId: options.ownerId ?? `${source}-owner`,
    enabled: options.enabled ?? true,
    slot,
    x,
    source,
    preview,
  };
}

function feedLayout(count: number, spacing: number, preview: readonly CoinType[] = types): FeedLayout[] {
  const playerSlots = [0, 1, -1];
  const enemySlots = [-2, 2, -3];
  return Array.from({ length: count }, (_, index) => {
    const source = index < playerSlots.length ? "player" : "enemy";
    const sourceIndex = source === "player" ? index : index - playerSlots.length;
    const slot = (source === "player" ? playerSlots : enemySlots)[sourceIndex]!;
    return lane((index - (count - 1) / 2) * spacing, preview, {
      id: `${source}-${sourceIndex}`,
      ownerId: source === "player" ? "player-owner" : `enemy-owner-${sourceIndex}`,
      slot,
      source,
    });
  });
}

function localZ(coin: CoinView, simulation: Simulation): number {
  return -(coin.position.y - simulation.tuning.dropHeight) * FEED_TRAY_SIN +
    (coin.position.z - PLAYER_DROP_Z) * FEED_TRAY_COS;
}

function advance(simulation: Simulation, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) simulation.step();
}

function nextRelease(simulation: Simulation, maximumTicks = 900): number[] {
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    const released = simulation.releaseFeed();
    if (released) return released;
    simulation.step();
  }
  throw new Error(`native feeder did not become ready after ${maximumTicks} physical steps`);
}

function expectConserved(simulation: Simulation): void {
  const stats = simulation.stats();
  expect(stats.spawned).toBe(stats.active + stats.collected + stats.detonated + stats.lost);
}

afterEach(() => {
  for (const simulation of simulations) simulation.dispose();
  simulations.length = 0;
});

describe("native gravity-fed supply", () => {
  it("adopts the actual loaded cylinder and collider, without counting supply or arming its bomb", async () => {
    const simulation = await create();
    simulation.setFeedLayout([lane()]);
    simulation.setBombsActive(true);
    const tray = simulation.feedTrays()[0]!;
    const stock = [...tray.coins];
    const bodies = stock.map((coin) => native(simulation, coin.id));
    const firstHandle = bodies[0]!.handle;
    const firstCollider = bodies[0]!.collider(0);
    const g = getFeedTrayGeometry(simulation.tuning.radius, simulation.tuning.thickness, simulation.tuning.dropHeight);
    stock.forEach((coin, index) => {
      expect(coin.id).toBeLessThan(0);
      expect(localZ(coin, simulation)).toBeCloseTo(-index * g.spacing, 6);
      expect(coin.radius).toBe(simulation.tuning.radius);
      expect(coin.thickness).toBe(simulation.tuning.thickness);
    });
    advance(simulation, 60);
    expect(simulation.stats()).toMatchObject({ active: 0, spawned: 0, collected: 0, detonated: 0, lost: 0 });
    expect(simulation.drainEvents()).toEqual([]);
    const released = nextRelease(simulation);
    const before = { ...bodies[0]!.translation() };
    expect(released).toHaveLength(1);
    const id = released[0]!;
    expect(id).toBeGreaterThan(0);
    expect(native(simulation, id)).toBe(bodies[0]);
    expect(native(simulation, id).handle).toBe(firstHandle);
    expect(native(simulation, id).collider(0)).toBe(firstCollider);
    expect(simulation.coins.get(id)).toMatchObject({ type: "bomb", bombHits: 0, position: before });
    expect(tray.coins.map((coin) => coin.id)).toEqual(stock.slice(1).map((coin) => coin.id));
    expect(tray.gateOpen).toBe(true);
    advance(simulation, 6);
    expect(simulation.coins.get(id)!.position.y).toBeLessThan(before.y - 0.005);
    expect(simulation.coins.get(id)!.bombHits).toBe(0);
    expectConserved(simulation);
  });

  it("keeps every upper body in place at consumption and replenishes only behind the cover", async () => {
    const simulation = await create();
    simulation.setFeedLayout([lane()]);
    const originals = [...simulation.feedTrays()[0]!.coins];
    const survivors = originals.slice(1).map((coin) => ({
      coin, body: native(simulation, coin.id), position: { ...coin.position },
      velocity: { ...native(simulation, coin.id).linvel() },
    }));
    expect(simulation.releaseFeed()).not.toBeNull();
    const shifted: CoinType[] = [...types.slice(1), "skull"];
    simulation.setFeedLayout([lane(0, shifted)]);
    const tray = simulation.feedTrays()[0]!;
    expect(tray.coins).toHaveLength(5);
    survivors.forEach(({ coin, body, position, velocity }, index) => {
      expect(tray.coins[index]).toBe(coin);
      expect(native(simulation, coin.id)).toBe(body);
      expect(coin.position).toEqual(position);
      expect(body.translation()).toEqual(position);
      expect(body.linvel()).toEqual(velocity);
    });
    const replacement = tray.coins[4]!;
    const geometry = getFeedTrayGeometry(simulation.tuning.radius, simulation.tuning.thickness, simulation.tuning.dropHeight);
    expect(replacement.id).not.toBe(originals[0]!.id);
    expect(localZ(replacement, simulation)).toBeCloseTo(-5 * geometry.spacing, 6);
    expect(localZ(replacement, simulation) + replacement.radius).toBeLessThan(geometry.coverFrontZ);
    const snapshot = tray.coins.map((coin) => coin.id);
    for (let read = 0; read < 20; read += 1) {
      expect(simulation.feedTrays()[0]).toBe(tray);
      expect(simulation.feedTrays()[0]!.coins.map((coin) => coin.id)).toEqual(snapshot);
      expect(simulation.releaseFeed()).toBeNull();
    }
    expect(simulation.stats().spawned).toBe(1);
    const nextBefore = { ...survivors[0]!.position };
    const second = nextRelease(simulation);
    expect(native(simulation, second[0]!)).toBe(survivors[0]!.body);
    expect(simulation.coins.get(second[0]!)!.position.y).toBeLessThan(nextBefore.y - 0.1);
    expect(simulation.coins.get(second[0]!)!.position.z).toBeGreaterThan(nextBefore.z + 0.1);
    expect(simulation.stats().spawned).toBe(2);
    expectConserved(simulation);
  });

  it("does not advance supply without gravity, then lets that same stock slide when gravity returns", async () => {
    const simulation = await create();
    simulation.setFeedLayout([lane()]);
    expect(simulation.releaseFeed()).not.toBeNull();
    simulation.setFeedLayout([lane(0, [...types.slice(1), "skull"])]);
    const stock = simulation.feedTrays()[0]!.coins.map((coin) => ({
      coin, body: native(simulation, coin.id), z: localZ(coin, simulation),
    }));
    for (const { body } of stock) body.setGravityScale(0, true);
    advance(simulation, 120);
    expect(simulation.feedTrays()[0]!.gateOpen).toBe(false);
    for (const { coin, z } of stock) expect(localZ(coin, simulation)).toBeCloseTo(z, 4);
    expect(simulation.releaseFeed()).toBeNull();
    expect(simulation.stats().spawned).toBe(1);
    for (const { body } of stock) {
      body.setGravityScale(1, true);
      body.wakeUp();
    }
    const [id] = nextRelease(simulation);
    expect(native(simulation, id!)).toBe(stock[0]!.body);
    expect(localZ(simulation.coins.get(id!)!, simulation)).toBeCloseTo(0, 1);
  });

  it.each([1, 2, 3, 4, 5, 6])("waits atomically for all %i enabled lanes, including a moving last lane", async (count) => {
    const simulation = await create();
    const spacing = 2 * simulation.tuning.radius + 0.02;
    simulation.setFeedLayout(feedLayout(count, spacing).reverse());
    const trays = simulation.feedTrays();
    const loaded = trays.map((tray) => tray.coins.map((coin) => coin.id));
    const last = native(simulation, trays[count - 1]!.coins[0]!.id);
    last.setLinvel({ x: 0, y: -1, z: 1 }, true);
    const before = simulation.stats();
    expect(simulation.releaseFeed()).toBeNull();
    expect(trays.map((tray) => tray.coins.map((coin) => coin.id))).toEqual(loaded);
    expect(trays.every((tray) => !tray.gateOpen)).toBe(true);
    expect(simulation.stats()).toMatchObject({ spawned: before.spawned, active: before.active, lost: before.lost });
    last.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const ids = simulation.releaseFeed()!;
    expect(ids).toHaveLength(count);
    ids.forEach((id, index) => expect(simulation.coins.get(id)!.position.x).toBeCloseTo(trays[index]!.x, 6));
    expect(trays.map((tray) => tray.coins.map((coin) => coin.id))).toEqual(loaded.map((ids) => ids.slice(1)));
    expect(simulation.releaseFeed()).toBeNull();
    expect(simulation.stats().spawned).toBe(count);
    expectConserved(simulation);
  });

  it("rejects malformed or oversized layouts before mutating native trays", async () => {
    const simulation = await create();
    const valid = feedLayout(2, 1);
    simulation.setFeedLayout(valid);
    const trays = [...simulation.feedTrays()];
    const stock = trays.flatMap((tray) => tray.coins.map((coin) => ({
      coin,
      body: native(simulation, coin.id),
      collider: native(simulation, coin.id).collider(0),
    })));
    const invalidType = ["invalid", ...types.slice(1)] as unknown as readonly CoinType[];
    const fourthPlayer = Array.from({ length: 4 }, (_, index) =>
      lane(index, types, { id: `player-${index}`, ownerId: "player-owner", slot: index }));
    const seventh = lane(4, types, {
      id: "enemy-extra",
      ownerId: "enemy-extra",
      slot: -4,
      source: "enemy",
    });
    const invalidLayouts: readonly (readonly FeedLayout[])[] = [
      [{ ...valid[0]!, id: " " }],
      [valid[0]!, { ...valid[1]!, id: valid[0]!.id }],
      [{ ...valid[0]!, ownerId: "" }],
      [{ ...valid[0]!, slot: Number.NaN }],
      [{ ...valid[0]!, x: Number.POSITIVE_INFINITY }],
      [{ ...valid[0]!, preview: types.slice(0, 4) }],
      [{ ...valid[0]!, preview: invalidType }],
      [{ ...valid[0]!, enabled: false }],
      fourthPlayer,
      [...feedLayout(6, 1), seventh],
    ];

    for (const invalid of invalidLayouts) {
      expect(() => simulation.setFeedLayout(invalid)).toThrow();
      expect([...simulation.feedTrays()]).toEqual(trays);
      stock.forEach(({ coin, body, collider }) => {
        expect(native(simulation, coin.id)).toBe(body);
        expect(body.collider(0)).toBe(collider);
      });
    }
  });

  it("preserves surviving tray, stock body, and collider identities when another lane is removed", async () => {
    const simulation = await create();
    const originalLayout = feedLayout(3, 1);
    simulation.setFeedLayout(originalLayout);
    const originalTrays = [...simulation.feedTrays()];
    const survivors = originalTrays.slice(1).map((tray) => ({
      tray,
      stock: tray.coins.map((coin) => ({
        coin,
        body: native(simulation, coin.id),
        collider: native(simulation, coin.id).collider(0),
      })),
    }));
    const removed = originalTrays[0]!.coins.map((coin) => ({
      id: coin.id,
      body: native(simulation, coin.id),
    }));

    simulation.setFeedLayout(originalLayout.slice(1).map((entry) => ({ ...entry, x: entry.x + 0.2 })));

    expect(simulation.feedTrays()).toHaveLength(2);
    survivors.forEach(({ tray, stock }, trayIndex) => {
      expect(simulation.feedTrays()[trayIndex]).toBe(tray);
      stock.forEach(({ coin, body, collider }) => {
        expect(native(simulation, coin.id)).toBe(body);
        expect(body.collider(0)).toBe(collider);
      });
    });
    const runtime = simulation as unknown as { world: RapierWorld };
    removed.forEach(({ id, body }) => {
      expect(runtime.world.nativeBody(id)).toBeUndefined();
      expect(body.isValid()).toBe(false);
    });
  });

  it("shutters disabled enemy stock without removing admitted board coins and refills on re-enable", async () => {
    const simulation = await create();
    const spacing = 2 * simulation.tuning.radius + 0.02;
    const enemy = lane(-spacing / 2, types, {
      id: "enemy-lane",
      ownerId: "enemy-owner",
      slot: -2,
      source: "enemy",
    });
    simulation.setFeedLayout([enemy]);
    const tray = simulation.feedTrays()[0]!;
    const stock = [...tray.coins];
    const removedStock = stock.slice(1).map((coin) => ({
      id: coin.id,
      body: native(simulation, coin.id),
    }));
    const [admittedId] = simulation.releaseFeed()!;
    const admittedBody = native(simulation, admittedId!);
    const admittedCollider = admittedBody.collider(0);
    expect(tray.gateOpen).toBe(true);

    const disabled = { ...enemy, enabled: false, preview: [] };
    simulation.setFeedLayout([disabled]);

    expect(simulation.feedTrays()[0]).toBe(tray);
    expect(tray).toMatchObject({
      id: enemy.id,
      ownerId: enemy.ownerId,
      slot: enemy.slot,
      enabled: false,
      preview: [],
      coins: [],
    });
    // The just-admitted coin still occupies the aperture, so the gate stays open.
    expect(tray.gateOpen).toBe(true);
    expect(native(simulation, admittedId!)).toBe(admittedBody);
    expect(admittedBody.collider(0)).toBe(admittedCollider);
    expect(simulation.coins.has(admittedId!)).toBe(true);
    expect(simulation.stats()).toMatchObject({ spawned: 1, active: 1 });
    const runtime = simulation as unknown as { world: RapierWorld };
    removedStock.forEach(({ id, body }) => {
      expect(runtime.world.nativeBody(id)).toBeUndefined();
      expect(body.isValid()).toBe(false);
    });
    expect(simulation.releaseFeed()).toBeNull();

    const player = lane(spacing / 2, types, { id: "player-lane", ownerId: "player-owner", slot: 0 });
    simulation.setFeedLayout([disabled, player]);
    const released = simulation.releaseFeed();
    expect(released).toHaveLength(1);
    expect(simulation.coins.get(released![0]!)!.position.x).toBeCloseTo(player.x, 6);
    simulation.setFeedLayout([enemy, player]);
    const enabledEnemy = simulation.feedTrays().find((candidate) => candidate.id === enemy.id)!;
    expect(enabledEnemy).toBe(tray);
    expect(enabledEnemy.enabled).toBe(true);
    expect(enabledEnemy.preview).toEqual(types);
    // The admitted coins must fall clear of the larger stock envelope before refill installs.
    for (let tick = 0; tick < 900 && enabledEnemy.coins.length === 0; tick += 1) simulation.step();
    expect(enabledEnemy.coins).toHaveLength(5);
    expect(enabledEnemy.coins.every((coin) => coin.id < 0)).toBe(true);
    expect(enabledEnemy.gateOpen).toBe(false);
    expectConserved(simulation);
  });

  it("retains lane identity fields when native tray geometry is resized", async () => {
    const simulation = await create();
    const layout = [
      lane(-0.4, types, { id: "player-lane", ownerId: "player-owner", slot: 1 }),
      lane(0.4, [], {
        id: "enemy-lane",
        ownerId: "enemy-owner",
        enabled: false,
        slot: -2,
        source: "enemy",
      }),
    ];
    simulation.setFeedLayout(layout);
    const runtime = simulation as unknown as { world: RapierWorld };

    runtime.world.feeder.configure({
      ...simulation.tuning,
      radius: 0.24,
      thickness: 0.0975,
    });

    expect(simulation.feedTrays().map(({ id, ownerId, enabled, slot, source, preview }) =>
      ({ id, ownerId, enabled, slot, source, preview }))).toEqual(layout.map(
      ({ id, ownerId, enabled, slot, source, preview }) => ({ id, ownerId, enabled, slot, source, preview }),
    ));
    expect(simulation.feedTrays()[0]!.coins).toHaveLength(5);
    expect(simulation.feedTrays()[0]!.coins.every((coin) =>
      coin.radius === 0.24 && coin.thickness === 0.0975)).toBe(true);
    expect(simulation.feedTrays()[1]!.coins).toEqual([]);
    expect(simulation.feedTrays()[1]!.gateOpen).toBe(false);
  });

  it("does not consume any lane when a board body obstructs one actual exit", async () => {
    const simulation = await create();
    const spacing = 2 * simulation.tuning.radius + 0.02;
    simulation.setFeedLayout(feedLayout(3, spacing));
    expect(simulation.drop(0)).toBe(true);
    const loaded = simulation.feedTrays().map((tray) => tray.coins.map((coin) => coin.id));
    const before = simulation.stats();
    expect(simulation.releaseFeed()).toBeNull();
    expect(simulation.stats()).toMatchObject({ spawned: before.spawned, active: before.active, lost: before.lost });
    expect(simulation.feedTrays().map((tray) => tray.coins.map((coin) => coin.id))).toEqual(loaded);
    expect(simulation.feedTrays().every((tray) => !tray.gateOpen)).toBe(true);
  });

  it("defers stock installation when a coin is admitted at the same x before stepping", async () => {
    const simulation = await create();
    // The dropped coin is a not-yet-stepped board occupant at the lane x.
    expect(simulation.drop(0)).toBe(true);
    simulation.setFeedLayout([lane(0)]);
    const tray = simulation.feedTrays()[0]!;
    expect(tray.gateOpen).toBe(true);
    expect(tray.coins).toHaveLength(0);
    // Once the dropped coin clears the envelope, the deferred stock installs and settles.
    for (let tick = 0; tick < 600 && tray.coins.length === 0; tick += 1) simulation.step();
    expect(tray.coins).toHaveLength(5);
    expect(tray.gateOpen).toBe(false);
    expectConserved(simulation);
  });

  it("keeps the gate open while a same-tick board coin occupies the floor aperture", async () => {
    const simulation = await create();
    const enemy = lane(0, types, {
      id: "enemy-lane",
      ownerId: "enemy-owner",
      slot: -2,
      source: "enemy",
    });
    simulation.setFeedLayout([enemy]);
    const tray = simulation.feedTrays()[0]!;
    const runtime = simulation as unknown as { world: RapierWorld };
    const feeder = runtime.world.feeder as unknown as {
      trays: { view: { id: string }; floor: RAPIER.Collider }[];
    };
    const [admittedId] = simulation.releaseFeed()!;
    expect(tray.gateOpen).toBe(true);
    // Park a not-yet-stepped board coin inside the floor aperture, then disable the tray.
    const floorPosition = { ...feeder.trays[0]!.floor.translation() };
    const blockerId = 10_000;
    expect(runtime.world.addCylinder(blockerId, {
      position: floorPosition,
      radius: simulation.tuning.radius,
      thickness: simulation.tuning.thickness,
    })).toBe(true);
    const blocker = native(simulation, blockerId);
    blocker.setGravityScale(0, true);
    blocker.lockTranslations(true, true);
    simulation.setFeedLayout([{ ...enemy, enabled: false, preview: [] }]);
    expect(tray.gateOpen).toBe(true);
    expect(tray.coins).toHaveLength(0);
    // Removing the blocker lets the gate close once the aperture is clear.
    expect(runtime.world.removeCylinder(blockerId)).toBe(true);
    for (let tick = 0; tick < 600 && tray.gateOpen; tick += 1) simulation.step();
    expect(tray.gateOpen).toBe(false);
    expect(simulation.coins.has(admittedId!)).toBe(true);
    expectConserved(simulation);
  });

  it.each([
    { radius: 0.32, thickness: 0.13 },
    { radius: 0.05, thickness: 0.02 },
    { radius: 0.05, thickness: 0.4 },
    { radius: 0.75, thickness: 0.02 },
    { radius: 0.75, thickness: 0.4 },
  ].flatMap((tuning) => [1, 2, 3, 4, 5, 6].map((lanes) => ({ ...tuning, lanes }))))("closes safely and repeats with $lanes minimum-spaced lanes at radius $radius / thickness $thickness", async ({ lanes, ...tuning }) => {
    const simulation = await create(tuning);
    const feeder = (simulation as unknown as { world: RapierWorld }).world.feeder as unknown as {
      trays: {
        view: { id: string };
        floor: RAPIER.Collider;
        frontFloor: RAPIER.Collider;
        stop: RAPIER.Collider;
      }[];
    };
    let preview = [...types];
    const layout = () => feedLayout(lanes, 2 * tuning.radius + 0.02, preview);
    simulation.setFeedLayout(layout());
    advance(simulation, 720);
    for (let round = 0; round < 4; round += 1) {
      const bodies = simulation.feedTrays().map((tray) => native(simulation, tray.coins[0]!.id));
      const ids = nextRelease(simulation, tuning.radius === 0.32 ? 144 : 900);
      ids.forEach((id, index) => expect(native(simulation, id)).toBe(bodies[index]));
      preview = [...preview.slice(1), types[round % types.length]!];
      simulation.setFeedLayout(layout());
      const trays = simulation.feedTrays();
      const wasOpen = trays.map((tray) => tray.gateOpen);
      for (let tick = 0; tick < 300 && trays.some((tray) => tray.gateOpen); tick += 1) {
        simulation.step();
        for (let index = 0; index < trays.length; index += 1) {
          if (!wasOpen[index] || trays[index]!.gateOpen) continue;
          wasOpen[index] = false;
          const admitted = simulation.coins.get(ids[index]!);
          if (!admitted) continue;
          const collider = native(simulation, admitted.id).collider(0);
          const hardware = feeder.trays.find(({ view }) => view.id === trays[index]!.id)!;
          for (const surface of [hardware.floor, hardware.frontFloor, hardware.stop]) {
            expect(surface.isEnabled()).toBe(true);
            expect(collider.shape.intersectsShape(
              collider.translation(), collider.rotation(),
              surface.shape, surface.translation(), surface.rotation(),
            )).toBe(false);
          }
        }
      }
      expect(trays.every((tray) => !tray.gateOpen)).toBe(true);
      for (const tray of trays) {
        expect(tray.coins).toHaveLength(5);
        expect(new Set(tray.coins.map((coin) => coin.id)).size).toBe(5);
      }
      expect(simulation.stats().spawned).toBe((round + 1) * lanes);
      expectConserved(simulation);
    }
  });

  it("releases a genuinely sleeping high-friction coin with a friction-only change", async () => {
    const simulation = await create({ friction: 2 });
    simulation.setFeedLayout([lane()]);
    const runtime = simulation as unknown as { world: RapierWorld; lifecycle: CoinLifecycle };
    const geometry = getFeedTrayGeometry(simulation.tuning.radius, simulation.tuning.thickness, simulation.tuning.dropHeight);
    const rearSlotZ = -5 * geometry.spacing;
    // The spare rear position provides a real inclined floor, without a stock rail.
    const coin = runtime.lifecycle.spawn({
      x: 0,
      y: simulation.tuning.dropHeight - rearSlotZ * FEED_TRAY_SIN,
      z: PLAYER_DROP_Z + rearSlotZ * FEED_TRAY_COS,
    }, FEED_TRAY_ROTATION, simulation.tuning.radius, simulation.tuning.thickness, "gold");
    expect(runtime.world.addCylinder(coin.id, coin)).toBe(true);
    const body = native(simulation, coin.id);
    const collider = body.collider(0);
    advance(simulation, 360);
    expect(body.isSleeping()).toBe(true);
    const before = { ...body.translation() };
    const mass = body.mass();
    simulation.configure({ friction: 0.1 });
    expect(body.isSleeping()).toBe(false);
    expect(body.collider(0)).toBe(collider);
    expect(body.mass()).toBe(mass);
    advance(simulation, 20);
    expect(body.translation().z).toBeGreaterThan(before.z + 0.02);
    expect(body.translation().y).toBeLessThan(before.y - 0.02);
    expectConserved(simulation);
  });

  it("refreshes contact materials without manufacturing new coin contact starts", async () => {
    const simulation = await create();
    const runtime = simulation as unknown as { world: RapierWorld };
    for (const [id, x] of [[1, 0], [2, 0.63]] as const) {
      expect(runtime.world.addCylinder(id, {
        position: { x, y: 10, z: 0 }, radius: 0.32, thickness: 0.13,
      })).toBe(true);
      const body = native(simulation, id);
      body.setGravityScale(0, true);
      body.lockTranslations(true, true);
    }
    expect(runtime.world.step()).toHaveLength(1);
    expect(runtime.world.step()).toEqual([]);
    runtime.world.updateFriction(0.1);
    expect(runtime.world.step()).toEqual([]);
  });

  it("moves only the loaded assembly and applies live mass/friction without recreating bodies", async () => {
    const simulation = await create();
    simulation.setFeedLayout([lane()]);
    const [id] = simulation.releaseFeed()!;
    const board = native(simulation, id!);
    const boardPose = { ...board.translation() };
    const shifted: CoinType[] = [...types.slice(1), "skull"];
    simulation.setFeedLayout([lane(0, shifted)]);
    const stock = simulation.feedTrays()[0]!.coins.map((coin) => ({
      coin, body: native(simulation, coin.id), position: { ...coin.position },
      mass: native(simulation, coin.id).mass(),
    }));
    const boardMass = board.mass();
    simulation.setFeedLayout([lane(1.25, shifted)]);
    simulation.configure({ dropHeight: 4, coinWeight: 2, friction: 0.31 });
    expect(board.translation()).toEqual(boardPose);
    expect(board.mass()).toBeCloseTo(boardMass * 2, 6);
    for (const { coin, body, position, mass } of stock) {
      expect(native(simulation, coin.id)).toBe(body);
      expect(coin.position.x).toBeCloseTo(position.x + 1.25, 6);
      expect(coin.position.y).toBeCloseTo(position.y + 1, 6);
      expect(coin.position.z).toBeCloseTo(position.z, 6);
      expect(body.mass()).toBeCloseTo(mass * 2, 6);
      expect(body.collider(0).friction()).toBeCloseTo(0.31, 6);
    }
    simulation.reset({ radius: 0.75, thickness: 0.4 });
    expect(simulation.feedTrays()).toEqual([]);
    expect(simulation.stats()).toMatchObject({ active: 0, spawned: 0, lost: 0 });
    simulation.setFeedLayout([lane()]);
    expect(simulation.feedTrays()[0]!.coins.map((coin) => [coin.radius, coin.thickness])).toEqual(
      Array.from({ length: 5 }, () => [0.75, 0.4]),
    );
    simulation.dispose();
    expect(simulation.feedTrays()).toEqual([]);
    expect(simulation.releaseFeed()).toBeNull();
  });
});
