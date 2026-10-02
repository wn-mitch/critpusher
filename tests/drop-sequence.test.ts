import { describe, expect, it } from "vitest";
import {
  createChuteLayout,
  DEFAULT_CHUTES,
  sanitizeChutes,
} from "../src/chutes";
import { createDropSequence } from "../src/feedback/drop-sequence";
import { createSimulation } from "../src/simulation";
import { FIXED_DT } from "../src/simulation/config";

describe("coin-by-coin drop sets", () => {
  it("honors fractional-second coin delays without a trailing set delay", async () => {
    const simulation = await createSimulation({ density: 0 });
    const sequence = createDropSequence();
    const settings = sanitizeChutes(
      { ...DEFAULT_CHUTES, dropDelay: 0.23 },
      simulation.tuning,
    );
    const intervalTicks = Math.ceil(settings.dropDelay / FIXED_DT);
    const layout = createChuteLayout(settings, simulation.tuning, 0);
    let tick = 0;
    const releasedAt: number[] = [];
    const release = () => {
      if (!simulation.releaseChutes(layout, 0)) return false;
      releasedAt.push(tick);
      return true;
    };
    try {
      expect(sequence.start(3, intervalTicks, tick, release)).toBe(true);
      expect(sequence.start(2, 6, tick, release)).toBe(false);
      expect(sequence.advance(tick, release)).toBe(false);
      for (tick = 1; tick < 40; tick++) {
        simulation.step();
        sequence.advance(tick, release);
      }
      expect(releasedAt).toEqual([0, 14, 28]);
      expect(sequence.remaining).toBe(0);
      expect(simulation.stats().spawned).toBe(9);
      expect(
        [...simulation.coins.values()].filter(
          (coin) => coin.faction === "enemy",
        ),
      ).toHaveLength(6);
      expect(
        [...simulation.coins.values()].filter(
          (coin) => coin.faction === "ally",
        ),
      ).toHaveLength(3);
      expect(sequence.start(1, intervalTicks, tick, release)).toBe(true);
      expect(releasedAt).toEqual([0, 14, 28, 40]);
      expect(simulation.stats().spawned).toBe(12);
    } finally {
      simulation.dispose();
    }
  });

  it.each([0, 4])(
    "releases the maximum click budget with %i enemy chutes",
    async (enemyChutes) => {
      const simulation = await createSimulation({ density: 0 });
      const sequence = createDropSequence();
      const layout = createChuteLayout(
        { ...DEFAULT_CHUTES, enemyChutes },
        simulation.tuning,
        0,
      );
      const release = () => simulation.releaseChutes(layout, 0) !== null;
      try {
        expect(sequence.start(30, 30, 0, release)).toBe(true);
        for (let tick = 1; tick <= 29 * 30; tick++) {
          simulation.step();
          sequence.advance(tick, release);
        }
        expect(sequence.remaining).toBe(0);
        expect(simulation.stats().spawned).toBe(30 * (enemyChutes + 1));
      } finally {
        simulation.dispose();
      }
    },
  );

  it("never emits catch-up batches together after a delayed advance", async () => {
    const simulation = await createSimulation({ density: 0 });
    const sequence = createDropSequence();
    const layout = createChuteLayout(DEFAULT_CHUTES, simulation.tuning, 0);
    const release = () => simulation.releaseChutes(layout) !== null;
    try {
      expect(sequence.start(3, 30, 0, release)).toBe(true);
      for (let step = 0; step < 300; step++) simulation.step();
      expect(sequence.advance(300, release)).toBe(true);
      expect(sequence.advance(300, release)).toBe(false);
      expect(sequence.remaining).toBe(1);
      expect(simulation.stats().spawned).toBe(6);
      for (let step = 0; step < 29; step++) simulation.step();
      expect(sequence.advance(329, release)).toBe(false);
      simulation.step();
      expect(sequence.advance(330, release)).toBe(true);
      expect(sequence.remaining).toBe(0);
      expect(simulation.stats().spawned).toBe(9);
    } finally {
      simulation.dispose();
    }
  });

  it("cancels remaining batches without resuming them and admits a new deliberate sequence", async () => {
    const simulation = await createSimulation({ density: 0 });
    const sequence = createDropSequence();
    const layout = createChuteLayout(DEFAULT_CHUTES, simulation.tuning, 0);
    const release = () => simulation.releaseChutes(layout) !== null;
    try {
      expect(sequence.start(5, 30, 0, release)).toBe(true);
      sequence.cancel();
      for (let tick = 1; tick <= 120; tick++) {
        simulation.step();
        expect(sequence.advance(tick, release)).toBe(false);
      }
      expect(simulation.stats().spawned).toBe(3);
      expect(sequence.start(1, 30, 120, release)).toBe(true);
      expect(simulation.stats().spawned).toBe(6);
    } finally {
      simulation.dispose();
    }
  });

  it("stops on refused physical admission rather than silently retrying or reducing the budget", async () => {
    const simulation = await createSimulation({ density: 0 });
    const sequence = createDropSequence();
    const layout = createChuteLayout(DEFAULT_CHUTES, simulation.tuning, 0);
    const release = () => simulation.releaseChutes(layout) !== null;
    try {
      expect(sequence.start(3, 30, 0, release)).toBe(true);
      simulation.configure({ dropRate: 0 });
      for (let step = 0; step < 30; step++) simulation.step();
      expect(sequence.advance(30, release)).toBe(false);
      expect(sequence.remaining).toBe(0);
      simulation.configure({ dropRate: 6 });
      for (let tick = 31; tick <= 90; tick++) {
        simulation.step();
        expect(sequence.advance(tick, release)).toBe(false);
      }
      expect(simulation.stats().spawned).toBe(3);
      expect(sequence.start(1, 30, 90, release)).toBe(true);
      expect(simulation.stats().spawned).toBe(6);
    } finally {
      simulation.dispose();
    }
  });
});
