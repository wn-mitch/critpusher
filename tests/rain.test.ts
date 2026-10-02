import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING, createSimulation } from "../src/simulation";
import { planRain, type RainDrop } from "../src/simulation/rain";
import type { Simulation, Tuning } from "../src/contracts";

function tuning(patch: Partial<Tuning> = {}): Tuning {
  return { ...DEFAULT_TUNING, ...patch };
}

function geometry(plan: RainDrop[]): Omit<RainDrop, "faction">[] {
  return plan.map((drop) => ({
    releaseTick: drop.releaseTick,
    pose: {
      x: drop.pose.x,
      y: drop.pose.y,
      z: drop.pose.z,
      rotation: { ...drop.pose.rotation },
    },
  }));
}

function drainRain(simulation: Simulation, limit = 1_200): void {
  for (let step = 0; step < limit; step += 1) {
    if (simulation.stats().pendingRain === 0) return;
    simulation.step();
  }
  expect(simulation.stats().pendingRain).toBe(0);
}

function expectConservation(simulation: Simulation): void {
  const stats = simulation.stats();
  expect(stats.spawned).toBe(stats.active + stats.collected + stats.lost);
}

describe("seeded staged rain", () => {
  it("returns no scheduled drops for zero density", () => {
    expect(planRain(tuning({ density: 0 }))).toEqual([]);
  });

  it("plans the supported high-density count without truncating", () => {
    expect(planRain(tuning({ density: 1_000, seed: 4 }))).toHaveLength(1_000);
  });

  it("keeps a representative plan from repeating vertical columns", () => {
    const plan = planRain(tuning({ density: 300, seed: 2026 }));
    const columns = new Set(plan.map(({ pose }) => `${pose.x}|${pose.z}`));

    expect(plan).toHaveLength(300);
    expect(columns.size).toBe(plan.length);
    expect(plan.every(({ releaseTick }) => releaseTick >= 0)).toBe(true);
  });

  it("reproduces seeded geometry while changing it for a different seed", () => {
    const first = geometry(planRain(tuning({ density: 48, seed: 71 })));
    const sameSeed = geometry(planRain(tuning({ density: 48, seed: 71 })));
    const differentSeed = geometry(planRain(tuning({ density: 48, seed: 72 })));

    expect(sameSeed).toEqual(first);
    expect(differentSeed).not.toEqual(first);
  });

  it("moves the lower rain frontier with the configured collection edge", () => {
    const full = planRain(tuning({ density: 120, seed: 29, shelfFront: 4 }));
    const short = planRain(tuning({ density: 120, seed: 29, shelfFront: 2.5 }));
    const fullLower = full.filter(({ pose }) => pose.z > -2);
    const shortLower = short.filter(({ pose }) => pose.z > -2);

    expect(fullLower.length).toBeGreaterThan(0);
    expect(shortLower).toHaveLength(fullLower.length);
    expect(shortLower.every(({ pose }) => pose.z < 2.5 - 0.3)).toBe(true);
    expect(Math.max(...shortLower.map(({ pose }) => pose.z))).toBeLessThan(
      Math.max(...fullLower.map(({ pose }) => pose.z)),
    );
  });

  it("keeps same-release cylinders separated by a conservative bounding radius", () => {
    const configured = tuning({ density: 120, seed: 19 });
    const plan = planRain(configured);
    const byRelease = new Map<number, RainDrop[]>();

    for (const drop of plan) {
      const batch = byRelease.get(drop.releaseTick);
      if (batch) batch.push(drop);
      else byRelease.set(drop.releaseTick, [drop]);

      const { x, y, z, rotation } = drop.pose;
      const quaternionLength = Math.hypot(
        rotation.x,
        rotation.y,
        rotation.z,
        rotation.w,
      );
      expect(
        Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z),
      ).toBe(true);
      expect(quaternionLength).toBeCloseTo(1, 8);
    }

    const batches = [...byRelease.values()];
    expect(Math.max(...batches.map((batch) => batch.length))).toBeGreaterThan(
      1,
    );

    const boundingRadius = Math.hypot(
      configured.radius,
      configured.thickness / 2,
    );
    for (const batch of batches) {
      for (let first = 0; first < batch.length; first += 1) {
        const a = batch[first]!.pose;
        for (let second = first + 1; second < batch.length; second += 1) {
          const b = batch[second]!.pose;
          const centerDistance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
          expect(centerDistance).toBeGreaterThanOrEqual(
            2 * boundingRadius - 1e-7,
          );
        }
      }
    }
  });

  it("keeps newly spawned active bodies out of occupied free volume", async () => {
    const density = 24;
    const simulation = await createSimulation({ density, seed: 13 });
    const seen = new Set<number>();
    const boundingRadius = Math.hypot(
      simulation.tuning.radius,
      simulation.tuning.thickness / 2,
    );
    const physicsTolerance = 0.12;

    try {
      for (
        let step = 0;
        step < 600 && simulation.stats().pendingRain > 0;
        step += 1
      ) {
        simulation.step();
        const visible = [...simulation.coins.values()];
        const newlyVisible = visible.filter((coin) => !seen.has(coin.id));

        for (const coin of newlyVisible) {
          for (const other of visible) {
            if (coin.id === other.id) continue;
            const centerDistance = Math.hypot(
              coin.position.x - other.position.x,
              coin.position.y - other.position.y,
              coin.position.z - other.position.z,
            );
            expect(centerDistance).toBeGreaterThanOrEqual(
              2 * boundingRadius - physicsTolerance,
            );
          }
          seen.add(coin.id);
        }
      }

      expect(simulation.stats().pendingRain).toBe(0);
      expect(simulation.stats().spawned).toBe(density);
      expectConservation(simulation);
    } finally {
      simulation.dispose();
    }
  });

  it("settles default rain across upper and lower machine regions", async () => {
    const requested = 300;
    const simulation = await createSimulation({
      density: requested,
      seed: 1337,
    });

    try {
      for (let step = 0; step < 720; step += 1) simulation.step();

      const stats = simulation.stats();
      const settled = [...simulation.coins.values()].filter(
        (coin) => coin.position.y <= 1.5,
      );
      const upper = settled.filter(
        (coin) =>
          coin.position.y > 0.5 &&
          coin.position.z < stats.pusherZ + 1 + simulation.tuning.radius,
      );
      const lower = settled.filter((coin) => !upper.includes(coin));

      expect(stats.pendingRain).toBe(0);
      expect(stats.spawned).toBe(requested);
      expect(upper.length).toBeGreaterThanOrEqual(requested * 0.1);
      expect(upper.length).toBeLessThanOrEqual(requested * 0.4);
      expect(lower.length).toBeGreaterThan(upper.length);
      expect(upper.some((coin) => coin.position.x < -1.5)).toBe(true);
      expect(
        upper.some((coin) => coin.position.x >= -1.5 && coin.position.x <= 1.5),
      ).toBe(true);
      expect(upper.some((coin) => coin.position.x > 1.5)).toBe(true);
      expectConservation(simulation);
    } finally {
      simulation.dispose();
    }
  });

  it("drains a bounded high-count schedule without losing count conservation", async () => {
    const simulation = await createSimulation({
      density: 96,
      seed: 7,
    });

    try {
      drainRain(simulation);
      const stats = simulation.stats();
      expect(stats.spawned).toBe(96);
      expectConservation(simulation);
    } finally {
      simulation.dispose();
    }
  });

  it("replaces an in-flight schedule on reset", async () => {
    const simulation = await createSimulation({
      density: 96,
      seed: 31,
    });

    try {
      simulation.step();
      simulation.reset({ density: 9, seed: 32 });
      expect(simulation.stats().pendingRain).toBe(9);

      drainRain(simulation);
      const stats = simulation.stats();
      expect(stats.spawned).toBe(9);
      expect(stats.spawned).not.toBe(96);
      expectConservation(simulation);
    } finally {
      simulation.dispose();
    }
  });
});
