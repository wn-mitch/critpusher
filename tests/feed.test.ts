import { describe, expect, it } from "vitest";
import { createSimulation } from "../src/simulation";
import { PLAYER_DROP_Z } from "../src/simulation/config";
import type { Simulation } from "../src/contracts";

const FIXED_HZ = 60;
const PUSHER_LANDING_PHASES = [0, 0.25, 0.5, 0.75] as const;

function advance(simulation: Simulation, steps: number): void {
  for (let index = 0; index < steps; index += 1) simulation.step();
}

describe("rear player feed physics", () => {
  it.each(PUSHER_LANDING_PHASES)(
    "lands a rear drop on the moving upper pusher at phase %s",
    async (phase) => {
      const period = 2.4;
      const simulation = await createSimulation({
        density: 0,
        dropRate: 6,
        period,
        seed: 2026,
      });

      try {
        const phaseSteps = Math.round(phase * period * FIXED_HZ);
        advance(simulation, phaseSteps);
        expect(simulation.stats().phase).toBeCloseTo(phase, 8);

        expect(simulation.drop(0)).toBe(true);
        const dropped = [...simulation.coins.values()][0];
        expect(dropped).toBeDefined();
        if (!dropped) return;
        expect(dropped.position.z).toBeCloseTo(PLAYER_DROP_Z, 8);

        let supportedFrames = 0;
        let sawUpperPusherLanding = false;
        let minimumZ = dropped.position.z;
        let lostEvents = 0;

        for (let step = 0; step < 240; step += 1) {
          simulation.step();
          const coin = simulation.coins.get(dropped.id);
          if (coin) {
            minimumZ = Math.min(minimumZ, coin.position.z);
            // The pusher top is y=.6; a Y-axis cylinder resting on it has
            // its center near y=.6+thickness/2, not near the shelf top.
            const restingY = 0.6 + coin.thickness / 2;
            const onUpperPusher =
              coin.position.y >= restingY - 0.1 &&
              coin.position.y <= restingY + 0.1;
            supportedFrames = onUpperPusher ? supportedFrames + 1 : 0;
            if (supportedFrames >= 8) sawUpperPusherLanding = true;
          }
          for (const event of simulation.drainEvents()) {
            if (event.kind === "lost") lostEvents += 1;
          }
          if (sawUpperPusherLanding) break;
        }

        expect(sawUpperPusherLanding).toBe(true);
        expect(lostEvents).toBe(0);
        // The rear wall's inside face is z=-4.05. Allow only a small
        // contact tolerance for the coin radius; deeper means tunneling.
        expect(minimumZ).toBeGreaterThan(-4.05 + dropped.radius - 0.1);
      } finally {
        simulation.dispose();
      }
    },
  );

  it("moves a finite repeated rear feed through the pusher to a payout", async () => {
    const simulation = await createSimulation({
      density: 0,
      dropRate: 6,
      seed: 2026,
      period: 2.4,
    });

    try {
      let acceptedDrops = 0;
      let peakActive = 0;
      let furthestForwardZ = PLAYER_DROP_Z;
      let collected = 0;
      let lost = 0;

      // Twenty fixed-step seconds is long enough to exercise several normal
      // pusher cycles while keeping this regression bounded and deterministic.
      for (let step = 0; step < 1_200; step += 1) {
        if (simulation.drop(0)) acceptedDrops += 1;
        simulation.step();
        peakActive = Math.max(peakActive, simulation.stats().active);
        for (const coin of simulation.coins.values()) {
          furthestForwardZ = Math.max(furthestForwardZ, coin.position.z);
        }
        for (const event of simulation.drainEvents()) {
          if (event.kind === "collected") collected += 1;
          if (event.kind === "lost") lost += 1;
        }
      }

      expect(acceptedDrops).toBe(120);
      expect(peakActive).toBeGreaterThan(1);
      expect(furthestForwardZ).toBeGreaterThan(PLAYER_DROP_Z + 1);
      expect(collected).toBeGreaterThan(0);
      expect(lost).toBe(0);
      expect(simulation.stats().spawned).toBe(acceptedDrops);
    } finally {
      simulation.dispose();
    }
  });
});
