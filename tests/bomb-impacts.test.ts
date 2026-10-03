import * as RAPIER from "@dimforge/rapier3d-compat";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_ENCOUNTER_CONFIG } from "../src/combat/config";
import type { Vec3 } from "../src/contracts";
import { DEFAULT_TUNING } from "../src/simulation/config";
import { RapierWorld, type CoinImpact } from "../src/simulation/rapier-world";

const worlds: RapierWorld[] = [];

beforeAll(async () => {
  await RAPIER.init();
});

afterEach(() => {
  for (const world of worlds) world.dispose();
  worlds.length = 0;
});

function createWorld(): RapierWorld {
  const world = new RapierWorld(DEFAULT_TUNING);
  worlds.push(world);
  return world;
}

function addCoin(
  world: RapierWorld,
  id: number,
  position: Vec3,
  radius = DEFAULT_TUNING.radius,
  thickness = DEFAULT_TUNING.thickness,
): RAPIER.RigidBody {
  expect(world.addCylinder(id, { position, radius, thickness })).toBe(true);
  let body: RAPIER.RigidBody | undefined;
  world.forEachCoin((coinId, candidate) => {
    if (coinId === id) body = candidate;
  });
  if (!body) throw new Error("Missing admitted coin body");
  return body;
}

function advance(world: RapierWorld, ticks: number): CoinImpact[] {
  const impacts: CoinImpact[] = [];
  for (let tick = 0; tick < ticks; tick += 1) impacts.push(...world.step());
  return impacts;
}

function horizontalCoin(world: RapierWorld, id: number, x: number): RAPIER.RigidBody {
  const body = addCoin(world, id, { x, y: 10, z: 0 });
  body.setGravityScale(0, true);
  body.lockRotations(true, true);
  body.setEnabledTranslations(true, false, false, true);
  return body;
}

describe("real Rapier bomb impact inputs", () => {
  it("reports one landing contact, not repeated hits during seconds of rest", () => {
    const world = createWorld();
    const support = addCoin(world, 1, { x: 0, y: 0.065, z: 2 });
    support.lockTranslations(true, true);
    support.lockRotations(true, true);
    const falling = addCoin(world, 2, { x: 0, y: 0.5, z: 2 });
    falling.lockRotations(true, true);

    const impacts = advance(world, 300);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({ aId: 1, bId: 2, aBlast: null, bBlast: null });
    expect(impacts[0]!.closingSpeed).toBeGreaterThan(0.75);
    expect(falling.translation().y).toBeCloseTo(0.195, 2);
    world.clearBlastAssociations();
    expect(advance(world, 180)).toEqual([]);
  });

  it("samples incoming speed once and admits a new hit after real separation", () => {
    const world = createWorld();
    const left = horizontalCoin(world, 20, -0.5);
    const right = horizontalCoin(world, 10, 0.5);
    left.setLinvel({ x: 2, y: 0, z: 0 }, true);
    right.setLinvel({ x: -2, y: 0, z: 0 }, true);

    const first = advance(world, 20);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ aId: 10, bId: 20 });
    expect(first[0]!.closingSpeed).toBeCloseTo(4, 5);
    expect(Math.abs(left.linvel().x - right.linvel().x)).toBeLessThan(4);
    expect(advance(world, 60)).toEqual([]);

    left.setTranslation({ x: -1, y: 10, z: 0 }, true);
    right.setTranslation({ x: 1, y: 10, z: 0 }, true);
    left.setLinvel({ x: 0, y: 0, z: 0 }, true);
    right.setLinvel({ x: 0, y: 0, z: 0 }, true);
    expect(world.step()).toEqual([]);
    left.setLinvel({ x: 2, y: 0, z: 0 }, true);
    right.setLinvel({ x: -2, y: 0, z: 0 }, true);
    const second = advance(world, 40);
    expect(second).toHaveLength(1);
    expect(second[0]!.closingSpeed).toBeCloseTo(4, 5);
  });

  it("excludes machine contacts despite a real shelf landing", () => {
    const world = createWorld();
    const coin = addCoin(world, 1, { x: 0, y: 1, z: 2 });
    coin.lockRotations(true, true);
    expect(advance(world, 180)).toEqual([]);
    expect(coin.translation().y).toBeCloseTo(0.065, 2);
  });

  it("forgets removed pair membership when a replacement collider contacts", () => {
    const world = createWorld();
    const left = horizontalCoin(world, 1, -0.4);
    const right = horizontalCoin(world, 2, 0.4);
    left.setLinvel({ x: 2, y: 0, z: 0 }, true);
    expect(advance(world, 20)).toHaveLength(1);
    expect(world.removeCylinder(1)).toBe(true);
    expect(world.removeCylinder(1)).toBe(false);
    right.setTranslation({ x: 0.4, y: 10, z: 0 }, true);
    right.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const replacement = horizontalCoin(world, 1, -0.4);
    replacement.setLinvel({ x: 2, y: 0, z: 0 }, true);
    const impacts = advance(world, 20);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.closingSpeed).toBeCloseTo(2, 5);
  });

  it("copies latest nonzero blast attribution into a later physical impact", () => {
    const world = createWorld();
    const striker = horizontalCoin(world, 1, 0);
    horizontalCoin(world, 2, 1);
    world.applyRadialBlast({ x: -0.5, y: 10, z: 0 }, 1, 8, 100, 12);
    world.applyRadialBlast({ x: -0.5, y: 10, z: 0 }, 1, 2, 200, 13);
    world.applyRadialBlast({ x: -1, y: 10, z: 0 }, 1, 10, 300, 14);
    expect(striker.linvel().x).toBeGreaterThan(0);
    const impacts = advance(world, 30);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]).toMatchObject({
      aId: 1,
      bId: 2,
      aBlast: { rootId: 200, tick: 13 },
      bBlast: null,
    });
    expect(impacts[0]!.closingSpeed).toBeGreaterThan(0.75);
    world.removeCylinder(1);
    world.clearBlastAssociations();
    expect(impacts[0]!.aBlast).toEqual({ rootId: 200, tick: 13 });
  });

  it("clears attribution without reporting an existing contact as a new impact", () => {
    const world = createWorld();
    const left = horizontalCoin(world, 1, -0.4);
    const right = horizontalCoin(world, 2, 0.4);
    world.applyRadialBlast({ x: -0.4, y: 10, z: 0 }, 0.1, 1, 90, 5);
    world.clearBlastAssociations();
    left.setLinvel({ x: 2, y: 0, z: 0 }, true);
    right.setLinvel({ x: -2, y: 0, z: 0 }, true);
    const impacts = advance(world, 20);
    expect(impacts).toHaveLength(1);
    expect(impacts[0]!.aBlast).toBeNull();
    world.clearBlastAssociations();
    expect(advance(world, 180)).toEqual([]);
  });
});

describe("real radial blast impulses", () => {
  it("scales velocity radially, lifts exact-center bodies, and preserves identity", () => {
    const world = createWorld();
    const center = addCoin(world, 1, { x: 0, y: 10, z: 0 });
    const inside = addCoin(world, 2, { x: 1, y: 10, z: 0 });
    const boundary = addCoin(world, 3, { x: 2, y: 10, z: 0 });
    const outside = addCoin(world, 4, { x: 3, y: 10, z: 0 });
    for (const body of [center, inside, boundary, outside]) body.setGravityScale(0, true);
    world.step();
    const handles = [center, inside, boundary, outside].map((body) => body.handle);

    world.applyRadialBlast({ x: 0, y: 10, z: 0 }, 2, 3, 77, 9);
    expect(center.linvel().x).toBeCloseTo(0, 6);
    expect(center.linvel().y).toBeCloseTo(3, 5);
    expect(center.linvel().z).toBeCloseTo(0, 6);
    expect(inside.linvel().x).toBeCloseTo(1.5 / Math.hypot(1, 0.35), 5);
    expect(inside.linvel().y).toBeCloseTo((1.5 * 0.35) / Math.hypot(1, 0.35), 5);
    expect(boundary.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(outside.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(world.step()).toEqual([]);
    expect(center.translation().y).toBeGreaterThan(10);
    expect(inside.translation().x).toBeGreaterThan(1);
    expect(inside.translation().y).toBeGreaterThan(10);
    expect(boundary.translation()).toEqual({ x: 2, y: 10, z: 0 });
    expect(outside.translation()).toEqual({ x: 3, y: 10, z: 0 });
    const identities: Array<[number, number]> = [];
    world.forEachCoin((id, body) => identities.push([id, body.handle]));
    expect(identities).toEqual(handles.map((handle, index) => [index + 1, handle]));
  });

  it("moves the playable blast faster and beyond the registered study radius", () => {
    const registeredWorld = createWorld();
    const playableWorld = createWorld();
    const registeredNear = addCoin(registeredWorld, 1, { x: 1, y: 10, z: 0 });
    const registeredWide = addCoin(registeredWorld, 2, { x: 2, y: 10, z: 0 });
    const playableNear = addCoin(playableWorld, 1, { x: 1, y: 10, z: 0 });
    const playableWide = addCoin(playableWorld, 2, { x: 2, y: 10, z: 0 });
    for (const body of [registeredNear, registeredWide, playableNear, playableWide])
      body.setGravityScale(0, true);
    registeredWorld.step();
    playableWorld.step();

    registeredWorld.applyRadialBlast({ x: 0, y: 10, z: 0 }, 1.75, 3, 1, 1);
    playableWorld.applyRadialBlast(
      { x: 0, y: 10, z: 0 },
      DEFAULT_ENCOUNTER_CONFIG.bomb.blastRadius,
      DEFAULT_ENCOUNTER_CONFIG.bomb.blastDeltaSpeed,
      1,
      1,
    );
    const registeredNearSpeed = Math.hypot(
      registeredNear.linvel().x,
      registeredNear.linvel().y,
      registeredNear.linvel().z,
    );
    const playableNearSpeed = Math.hypot(
      playableNear.linvel().x,
      playableNear.linvel().y,
      playableNear.linvel().z,
    );
    expect(playableNearSpeed).toBeGreaterThan(registeredNearSpeed * 2.5);
    expect(registeredWide.linvel()).toEqual({ x: 0, y: 0, z: 0 });
    expect(Math.hypot(playableWide.linvel().x, playableWide.linvel().y, playableWide.linvel().z)).toBeGreaterThan(0.5);

    registeredWorld.step();
    playableWorld.step();
    expect(playableNear.translation().x - 1).toBeGreaterThan(
      (registeredNear.translation().x - 1) * 2.5,
    );
    expect(playableWide.translation().x).toBeGreaterThan(2);
  });

  it("imparts the same delta speed across different weights and thicknesses", () => {
    const world = createWorld();
    const light = addCoin(world, 1, { x: -1, y: 10, z: 0 });
    const thickHeavy = addCoin(
      world,
      2,
      { x: 1, y: 10, z: 0 },
      DEFAULT_TUNING.radius,
      DEFAULT_TUNING.thickness * 2,
    );
    thickHeavy.collider(0).setDensity(DEFAULT_TUNING.coinWeight * 4);
    thickHeavy.recomputeMassPropertiesFromColliders();
    expect(thickHeavy.mass()).toBeCloseTo(light.mass() * 8, 5);
    world.applyRadialBlast({ x: 0, y: 10, z: 0 }, 2, 3, 1, 1);
    expect(Math.hypot(...Object.values(light.linvel()))).toBeCloseTo(1.5, 5);
    expect(Math.hypot(...Object.values(thickHeavy.linvel()))).toBeCloseTo(1.5, 5);
  });
});
