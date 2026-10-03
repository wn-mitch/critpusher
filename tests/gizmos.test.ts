import { afterEach, describe, expect, it } from "vitest";
import * as RAPIER from "@dimforge/rapier3d-compat";
import type { GizmoDefinition, GizmoView, Simulation, Tuning, Vec3 } from "../src/contracts";
import { deriveSeed, randomFactory } from "../src/random";
import { createSimulation } from "../src/simulation";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";
import { MACHINE_GEOMETRY } from "../src/machine-geometry";
import type { RainDrop } from "../src/simulation/rain";

const bell: GizmoDefinition = { kind: "bell", radius: 0.38, density: 1.5, payout: 3 };
const identity = { x: 0, y: 0, z: 0, w: 1 };
const simulations: Simulation[] = [];
interface NativeFixture { world: RapierWorld; lifecycle: CoinLifecycle }
function fixture(simulation: Simulation): NativeFixture {
  // Native-only boundary fixtures exercise actual shapes, collisions, and removals.
  const native = simulation as unknown as NativeFixture;
  return native;
}
async function create(tuning: Partial<Tuning> = {}): Promise<Simulation> {
  const simulation = await createSimulation({ density: 0, ...tuning });
  simulations.push(simulation);
  return simulation;
}
function spawnPosition(seed: number): Vec3 {
  const random = randomFactory(deriveSeed(seed, 0, 0x47495a4d));
  return { x: random() * 6 - 3, y: 2, z: random() * 2 + 0.5 };
}
function onlyBell(simulation: Simulation): GizmoView {
  expect(simulation.gizmos.size).toBe(1);
  return [...simulation.gizmos.values()][0]!;
}
function conserved(simulation: Simulation): void {
  const stats = simulation.stats();
  expect(stats.gizmos.spawned).toBe(stats.gizmos.active + stats.gizmos.collected + stats.gizmos.lost);
  expect(stats.spawned).toBe(stats.active + stats.collected + stats.lost + stats.detonated);
}
afterEach(() => {
  for (const simulation of simulations) simulation.dispose();
  simulations.length = 0;
});

describe("separate native bell lifecycle", () => {
  it("spawns the seeded sphere before rain, with real mass and independently updated friction", async () => {
    const simulation = await create({ seed: 42, density: 40, friction: 0.25 });
    simulation.configureGizmo(bell);
    expect(simulation.stats().gizmos).toEqual({ spawned: 0, active: 0, collected: 0, lost: 0, pending: 1 });
    simulation.step();
    const mascot = onlyBell(simulation);
    const native = fixture(simulation);
    const body = native.world.nativeBody(mascot.id)!;
    const expected = spawnPosition(42);
    expect(mascot.position.x).toBeCloseTo(expected.x, 5);
    expect(mascot.position.z).toBeCloseTo(expected.z, 5);
    expect(mascot.position.y).toBeLessThan(2);
    expect(body.collider(0).shape.type).toBe(RAPIER.ShapeType.Ball);
    expect(body.collider(0).shape).toMatchObject({ radius: 0.38 });
    expect(body.mass()).toBeCloseTo(4 / 3 * Math.PI * 0.38 ** 3 * 1.5, 5);
    expect(body.collider(0).friction()).toBeCloseTo(0.25);
    expect(mascot.id).toBeGreaterThan(0);
    for (const coin of simulation.coins.values()) expect(coin.id).toBeGreaterThan(mascot.id);
    expect(simulation.coins.has(mascot.id)).toBe(false);
    const originalMass = body.mass();
    simulation.configure({ friction: 0.7, coinWeight: 2 });
    expect(body.collider(0).friction()).toBeCloseTo(0.7);
    expect(body.mass()).toBeCloseTo(originalMass, 6);
    conserved(simulation);
  });

  it("uses exact sphere admission against fixed surfaces, unstepped stock, and newly added spheres", async () => {
    const simulation = await create();
    const native = fixture(simulation);
    expect(native.world.canAddSphere({ x: 0, y: 0, z: 2 }, 0.38)).toBe(false);
    expect(native.world.canAddSphere({ x: MACHINE_GEOMETRY.sideWallX, y: 1, z: 2 }, 0.38)).toBe(false);
    simulation.setFeedLayout([{ id: "player", ownerId: "player", source: "player", slot: 0, x: 0, enabled: true,
      preview: ["sword", "gold", "potion", "bomb", "sword"] }]);
    const stock = simulation.feedTrays()[0]!.coins[0]!;
    expect(native.world.canAddSphere(stock.position, 0.38)).toBe(false);
    const sphere: GizmoView = { ...bell, id: native.lifecycle.allocateId(), position: { x: 2, y: 2, z: 2 }, rotation: identity };
    expect(native.world.addSphere(sphere)).toBe(true);
    expect(native.world.canAddSphere(sphere.position, 0.38)).toBe(false);
    expect(native.world.canAddCylinders([{ ...sphere.position, rotation: identity }], 0.32, 0.13)).toBe(false);
    // This flat coin is inside a sphere-based cylinder bound, but its actual shape is clear.
    expect(native.world.canAddCylinders([{ x: 2, y: 2.5, z: 2, rotation: identity }], 0.32, 0.13)).toBe(true);
    expect(native.world.removeSphere(sphere.id)).toBe(true);
    expect(native.world.removeSphere(sphere.id)).toBe(false);
  });

  it("retries blocked seeded admission without consuming IDs or counting a failed spawn", async () => {
    const simulation = await create({ seed: 7 });
    const native = fixture(simulation);
    const blocker = native.lifecycle.spawn(spawnPosition(7), identity, 0.32, 0.13, "gold");
    native.world.addCylinder(blocker.id, blocker);
    const body = native.world.nativeBody(blocker.id)!;
    body.lockTranslations(true, true);
    body.lockRotations(true, true);
    simulation.configureGizmo(bell);
    simulation.step();
    expect(simulation.stats().gizmos).toEqual({ spawned: 0, active: 0, collected: 0, lost: 0, pending: 1 });
    body.setTranslation({ x: 4, y: 2, z: 2 }, true);
    simulation.step();
    const mascot = onlyBell(simulation);
    expect(mascot.id).toBe(blocker.id + 1);
    expect(simulation.stats().gizmos.pending).toBe(0);
    conserved(simulation);
  });

  it("defers overlapping rain until the first-tick sphere's real shape clears", async () => {
    const simulation = await create({ seed: 113, density: 1 });
    // A single controlled rain entry exercises the pre-broadphase admission ordering.
    const rainFixture = simulation as unknown as { rain: RainDrop[] };
    rainFixture.rain = [{ type: "gold", releaseTick: 0, pose: { ...spawnPosition(113), rotation: identity } }];
    simulation.configureGizmo(bell);
    simulation.step();
    expect(simulation.stats()).toMatchObject({ spawned: 0, pendingRain: 1, gizmos: { spawned: 1, pending: 0 } });
    const mascot = onlyBell(simulation);
    fixture(simulation).world.nativeBody(mascot.id)!.setTranslation({ x: 4, y: 2, z: 2 }, true);
    simulation.step();
    expect(simulation.stats()).toMatchObject({ spawned: 1, pendingRain: 0 });
    expect([...simulation.coins.values()][0]!.type).toBe("gold");
    conserved(simulation);
  });

  it("stops spawn retries at the loading bound while exposing the unresolved pending spawn", async () => {
    const simulation = await create({ seed: 19 });
    const native = fixture(simulation);
    const blocker = native.lifecycle.spawn(spawnPosition(19), identity, 0.32, 0.13, "gold");
    native.world.addCylinder(blocker.id, blocker);
    const body = native.world.nativeBody(blocker.id)!;
    body.lockTranslations(true, true);
    body.lockRotations(true, true);
    simulation.configureGizmo(bell);
    for (let tick = 0; tick < 1440; tick++) simulation.step();
    body.setTranslation({ x: 4, y: 2, z: 2 }, true);
    simulation.step();
    expect(simulation.stats().gizmos).toEqual({ spawned: 0, active: 0, collected: 0, lost: 0, pending: 1 });
  });

  it("receives native contacts and radial impulses but cannot arm a bomb", async () => {
    const simulation = await create();
    const native = fixture(simulation);
    simulation.configureGizmo(bell);
    simulation.setBombsActive(true);
    simulation.step();
    const mascot = onlyBell(simulation);
    const sphereBody = native.world.nativeBody(mascot.id)!;
    sphereBody.setTranslation({ x: 0, y: 1.5, z: 2 }, true);
    sphereBody.setLinvel({ x: 0, y: -3, z: 0 }, true);
    const bomb = native.lifecycle.spawn({ x: 0, y: 0.7, z: 2 }, identity, 0.32, 0.13, "bomb");
    native.world.addCylinder(bomb.id, bomb);
    const bombBody = native.world.nativeBody(bomb.id)!;
    bombBody.lockTranslations(true, true);
    bombBody.lockRotations(true, true);
    for (let tick = 0; tick < 45; tick++) simulation.step();
    expect(bomb.bombHits).toBe(0);
    expect(simulation.stats().detonated).toBe(0);
    expect(sphereBody.translation().y).toBeGreaterThan(1.05);
    expect(sphereBody.translation().y).toBeLessThan(1.2);
    sphereBody.setTranslation({ x: 1, y: 1.2, z: 2 }, true);
    sphereBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    native.world.applyRadialBlast({ x: 0, y: 1.2, z: 2 }, simulation.config.bomb.blastRadius,
      simulation.config.bomb.blastDeltaSpeed, bomb.id, 46);
    expect(sphereBody.linvel().x).toBeGreaterThan(0.1);
    expect(sphereBody.linvel().y).toBeGreaterThan(0.1);
    conserved(simulation);
  });

  it.each(["collected", "lost"] as const)("resolves %s once, keeps IDs monotonic, and returns only after reset", async (outcome) => {
    const simulation = await create({ seed: 71 });
    simulation.configureGizmo(bell);
    simulation.step();
    const mascot = onlyBell(simulation);
    const native = fixture(simulation);
    const position = outcome === "collected"
      ? { x: 0, y: MACHINE_GEOMETRY.collectionY - 0.2, z: simulation.tuning.shelfFront + 0.5 }
      : { x: MACHINE_GEOMETRY.lostHalfWidth + 1, y: 1, z: 2 };
    native.world.nativeBody(mascot.id)!.setTranslation(position, true);
    simulation.step();
    const events = simulation.drainGizmoEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject(outcome === "collected"
      ? { id: mascot.id, type: "bell", kind: "collected", currency: 3 }
      : { id: mascot.id, type: "bell", kind: "lost", reason: "out-of-bounds" });
    expect(simulation.drainEvents()).toEqual([]);
    expect(native.world.nativeBody(mascot.id)).toBeUndefined();
    simulation.configureGizmo(bell);
    for (let tick = 0; tick < 10; tick++) simulation.step();
    expect(simulation.drainGizmoEvents()).toEqual([]);
    expect(simulation.gizmos.size).toBe(0);
    expect(simulation.stats().spawned).toBe(0);
    conserved(simulation);
    simulation.reset({ density: 0 });
    expect(simulation.stats().gizmos).toEqual({ spawned: 0, active: 0, collected: 0, lost: 0, pending: 0 });
    simulation.configureGizmo(bell);
    simulation.step();
    const next = onlyBell(simulation);
    expect(next.id).toBeGreaterThan(mascot.id);
    expect(next.position.x).toBeCloseTo(spawnPosition(71).x, 5);
    expect(simulation.drop(0)).toBe(true);
    expect([...simulation.coins.keys()][0]).toBeGreaterThan(next.id);
    simulation.dispose();
    simulation.dispose();
    expect(simulation.gizmos.size).toBe(0);
    expect(simulation.drainGizmoEvents()).toEqual([]);
    conserved(simulation);
  });

  it("clears a live mascot at the world boundary and requires fresh encounter configuration", async () => {
    const simulation = await create({ seed: 307 });
    simulation.configureGizmo(bell);
    simulation.step();
    const mascot = onlyBell(simulation);
    const priorWorld = fixture(simulation).world;
    simulation.reset();
    expect(priorWorld.nativeBody(mascot.id)).toBeUndefined();
    expect(fixture(simulation).world).not.toBe(priorWorld);
    expect(simulation.gizmos.size).toBe(0);
    expect(simulation.drainGizmoEvents()).toEqual([]);
    simulation.configureGizmo(bell);
    simulation.step();
    expect(onlyBell(simulation).id).toBeGreaterThan(mascot.id);
    conserved(simulation);
  });

  it("removes an invalid native pose without publishing a nonfinite event position", async () => {
    const simulation = await create();
    simulation.configureGizmo(bell);
    simulation.step();
    const mascot = onlyBell(simulation);
    const native = fixture(simulation);
    const body = native.world.nativeBody(mascot.id)!;
    body.setTranslation({ x: Number.NaN, y: 1, z: 2 }, true);
    // Exercise the native sync boundary without asking Rapier to solve an invalid world.
    const sync = simulation as unknown as { syncGizmo(id: number, body: RAPIER.RigidBody): void };
    sync.syncGizmo(mascot.id, body);
    expect(simulation.drainGizmoEvents()).toEqual([{ id: mascot.id, type: "bell", kind: "lost", reason: "invalid-pose", position: mascot.position }]);
    expect(native.world.nativeBody(mascot.id)).toBeUndefined();
    conserved(simulation);
  });
});
