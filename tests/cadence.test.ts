import { describe, expect, it } from "vitest";
import { createSimulation } from "../src/simulation";
import type { Simulation } from "../src/contracts";

function advance(simulation: Simulation, steps: number): void {
  for (let index = 0; index < steps; index += 1) simulation.step();
}

describe("fixed-step drop cadence", () => {
  it("accepts one drop at each exact ten-step boundary", async () => {
    const simulation = await createSimulation({ density: 0, dropRate: 6 });

    expect(simulation.drop(0)).toBe(true);
    expect(simulation.drop(0)).toBe(false);

    advance(simulation, 9);
    expect(simulation.drop(0)).toBe(false);

    simulation.step();
    expect(simulation.drop(0)).toBe(true);
    expect(simulation.drop(0)).toBe(false);

    simulation.dispose();
  });

  it("keeps long-run boundary counts exact", async () => {
    const simulation = await createSimulation({ density: 0, dropRate: 6 });
    const elapsedTicks = 1_000;
    let accepted = simulation.drop(0) ? 1 : 0;

    for (let tick = 1; tick <= elapsedTicks; tick += 1) {
      simulation.step();
      if (simulation.drop(0)) accepted += 1;
    }

    expect(accepted).toBe(1 + elapsedTicks / 10);
    simulation.dispose();
  });

  it("preserves live rate changes and reset cadence", async () => {
    const simulation = await createSimulation({ density: 0, dropRate: 6 });

    expect(simulation.drop(0)).toBe(true);
    advance(simulation, 4);
    simulation.configure({ dropRate: 12 });
    expect(simulation.drop(0)).toBe(false);
    simulation.step();
    expect(simulation.drop(0)).toBe(true);

    simulation.reset();
    expect(simulation.drop(0)).toBe(true);

    simulation.dispose();
  });
});
