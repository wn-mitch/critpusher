import { describe, expect, it } from "vitest";
import { createChuteLayout, DEFAULT_CHUTES } from "../src/chutes";
import { createDropSequence } from "../src/feedback/drop-sequence";
import { createSimulation } from "../src/simulation";

describe("timed synchronized release sequences", () => {
  it("releases the requested physical batches at exact intervals and applies delay across held-input sequences", async () => {
    const simulation = await createSimulation({ density: 0 });
    const sequence = createDropSequence();
    const layout = createChuteLayout(DEFAULT_CHUTES, simulation.tuning, 0);
    let tick = 0;
    const releasedAt: number[] = [];
    const release = () => {
      if (!simulation.releaseChutes(layout)) return false;
      releasedAt.push(tick);
      return true;
    };
    try {
      expect(sequence.start(3, 30, tick, release)).toBe(true);
      expect(sequence.start(2, 6, tick, release)).toBe(false);
      expect(sequence.advance(tick, release)).toBe(false);
      for (tick = 1; tick < 90; tick++) {
        simulation.step();
        sequence.advance(tick, release);
      }
      expect(releasedAt).toEqual([0, 30, 60]);
      expect(sequence.remaining).toBe(0);
      expect(simulation.stats().spawned).toBe(27);
      expect(
        [...simulation.coins.values()].filter(
          (coin) => coin.faction === "enemy",
        ),
      ).toHaveLength(18);
      expect(sequence.start(1, 30, 89, release)).toBe(false);
      simulation.step();
      expect(sequence.start(1, 30, tick, release)).toBe(true);
      expect(releasedAt).toEqual([0, 30, 60, 90]);
      expect(simulation.stats().spawned).toBe(36);
    } finally {
      simulation.dispose();
    }
  });

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
      expect(simulation.stats().spawned).toBe(18);
      for (let step = 0; step < 29; step++) simulation.step();
      expect(sequence.advance(329, release)).toBe(false);
      simulation.step();
      expect(sequence.advance(330, release)).toBe(true);
      expect(sequence.remaining).toBe(0);
      expect(simulation.stats().spawned).toBe(27);
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
      expect(simulation.stats().spawned).toBe(9);
      expect(sequence.start(1, 30, 120, release)).toBe(true);
      expect(simulation.stats().spawned).toBe(18);
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
      expect(simulation.stats().spawned).toBe(9);
      expect(sequence.start(1, 30, 90, release)).toBe(true);
      expect(simulation.stats().spawned).toBe(18);
    } finally {
      simulation.dispose();
    }
  });
});
