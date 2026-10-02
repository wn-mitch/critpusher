import * as RAPIER from "@dimforge/rapier3d-compat";
import { describe, expect, it } from "vitest";
import { createSimulation, DEFAULT_TUNING } from "../src/simulation";
import { RapierWorld } from "../src/simulation/rapier-world";

describe("coin weight", () => {
  it("scales existing and new coin mass and inertia, not geometry or velocity", async () => {
    await RAPIER.init();
    const world = new RapierWorld({ ...DEFAULT_TUNING, coinWeight: 2 });
    try {
      world.addCylinder(1, {
        position: { x: -2, y: 5, z: 0 },
        radius: 0.3,
        thickness: 0.1,
      });
      let mass = 0;
      let inertia = { x: 0, y: 0, z: 0 };
      let impulseSpeed = 0;
      world.forEachCoin((_id, body) => {
        mass = body.mass();
        expect(mass).toBeCloseTo(Math.PI * 0.3 ** 2 * 0.1 * 2, 6);
        inertia = body.principalInertia();
        body.applyImpulse({ x: 1, y: 0, z: 0 }, true);
        impulseSpeed = body.linvel().x;
      });

      world.updateCoinWeight(8);
      world.forEachCoin((_id, body) => {
        expect(body.mass()).toBeCloseTo(mass * 4, 6);
        const updatedInertia = body.principalInertia();
        for (const axis of ["x", "y", "z"] as const)
          expect(updatedInertia[axis]).toBeCloseTo(inertia[axis] * 4, 6);
        expect(body.linvel().x).toBeCloseTo(impulseSpeed, 6);
        const shape = body.collider(0).shape as RAPIER.Cylinder;
        expect(shape.radius).toBeCloseTo(0.3, 6);
        expect(shape.halfHeight).toBeCloseTo(0.05, 6);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.applyImpulse({ x: 1, y: 0, z: 0 }, true);
        expect(body.linvel().x).toBeCloseTo(impulseSpeed / 4, 5);
      });

      world.addCylinder(2, {
        position: { x: 2, y: 5, z: 0 },
        radius: 0.6,
        thickness: 0.1,
      });
      world.forEachCoin((id, body) => {
        if (id === 2) expect(body.mass()).toBeCloseTo(mass * 16, 6);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      });
      world.step();
      world.forEachCoin((_id, body) => {
        expect(body.linvel().y).toBeCloseTo(-9.81 / 60, 5);
      });
    } finally {
      world.dispose();
    }
  });

  it("keeps zero, negative, and nonfinite weights out of live and reset state", async () => {
    const simulation = await createSimulation({ density: 0, coinWeight: 2 });
    try {
      simulation.configure({ coinWeight: Number.NaN });
      expect(simulation.tuning.coinWeight).toBe(2);
      simulation.configure({ coinWeight: 0 });
      expect(simulation.tuning.coinWeight).toBe(0.1);
      simulation.configure({ coinWeight: -5 });
      expect(simulation.tuning.coinWeight).toBe(0.1);
      simulation.reset({ coinWeight: 20 });
      expect(simulation.tuning.coinWeight).toBe(10);
      simulation.configure({ coinWeight: Number.POSITIVE_INFINITY });
      expect(simulation.tuning.coinWeight).toBe(10);
      simulation.reset();
      expect(simulation.tuning.coinWeight).toBe(10);
    } finally {
      simulation.dispose();
    }
  });
});
