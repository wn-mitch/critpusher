import * as RAPIER from "@dimforge/rapier3d-compat";
import { describe, expect, it } from "vitest";
import type { CoinFaction, CollectionEvent } from "../src/contracts";
import {
  createChuteLayout,
  DEFAULT_CHUTES,
  sanitizeChutes,
} from "../src/chutes";
import {
  classifyCoinPosition,
  createSimulation,
  DEFAULT_TUNING,
} from "../src/simulation";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";

describe("playable chute factions", () => {
  it("admits every selected chute at spacing and aim boundaries without overlap or partial release", async () => {
    const simulation = await createSimulation({ density: 0 });
    try {
      for (const radius of [0.2, 0.32, 0.6]) {
        for (let enemyChutes = 0; enemyChutes <= 4; enemyChutes++) {
          for (const chuteSpacing of [0, 3]) {
            for (const requestedX of [-9, 9]) {
              simulation.reset({ density: 0, radius });
              const settings = sanitizeChutes(
                {
                  ...DEFAULT_CHUTES,
                  enemyChutes,
                  chuteSpacing,
                },
                simulation.tuning,
              );
              const layout = createChuteLayout(
                settings,
                simulation.tuning,
                requestedX,
              );
              const ids = simulation.releaseChutes(layout);
              expect(ids).not.toBeNull();
              expect(layout).toHaveLength(enemyChutes + 1);
              expect(ids).toHaveLength(enemyChutes + 1);
              expect(layout[0]!.faction).toBe("ally");
              for (let index = 0; index < layout.length; index++) {
                const chute = layout[index]!;
                expect(simulation.coins.get(ids![index]!)).toMatchObject({
                  faction: index === 0 ? "ally" : "enemy",
                  position: { x: chute.x },
                });
                expect(Math.abs(chute.x) + radius).toBeLessThan(5);
                for (const other of layout.slice(index + 1)) {
                  expect(Math.abs(chute.x - other.x)).toBeGreaterThan(
                    2 * radius,
                  );
                }
              }
              expect(simulation.stats().spawned).toBe(
                simulation.stats().active,
              );
            }
          }
        }
      }
    } finally {
      simulation.dispose();
    }
  });

  it("keeps asymmetric odd-count offsets and spacing when aim reaches a wall", () => {
    const layout = createChuteLayout(
      { ...DEFAULT_CHUTES, enemyChutes: 3, chuteSpacing: 1.5 },
      DEFAULT_TUNING,
      -9,
    );
    expect(layout.map((chute) => chute.x - layout[0]!.x)).toEqual([
      0, -1.5, 1.5, -3,
    ]);
    expect(layout.map((chute) => chute.count)).toEqual([1, 1, 1, 1]);
    expect(layout[0]!.x).toBeCloseTo(-1.4);
  });

  it("preserves faction through real physics, separates catches, and never counts losses or duplicate resolution", async () => {
    await RAPIER.init();
    const world = new RapierWorld(DEFAULT_TUNING);
    const lifecycle = new CoinLifecycle();
    const factions: CoinFaction[] = ["ally", "enemy", "enemy", "dud", "dud"];
    const coins = factions.map((faction, index) =>
      lifecycle.spawn(
        {
          x: index - 2,
          y: index === 2 || index === 4 ? -1 : 0.2,
          z: index === 2 || index === 4 ? 3 : 4.5,
        },
        { x: 0, y: 0, z: 0, w: 1 },
        0.32,
        0.13,
        faction,
      ),
    );
    const events: CollectionEvent[] = [];
    try {
      for (const coin of coins)
        expect(world.addCylinder(coin.id, coin)).toBe(true);
      for (let step = 0; step < 180 && lifecycle.active > 0; step++) {
        world.step();
        world.forEachCoin((id, body) => {
          const position = body.translation();
          lifecycle.update(id, position, body.rotation());
          const kind = classifyCoinPosition(position, 4);
          if (!kind) return;
          if (kind === "collected") lifecycle.collect(id, position);
          else lifecycle.lose(id, position);
          world.removeCylinder(id);
        });
        events.push(...lifecycle.drainEvents());
      }
      expect(lifecycle.stats()).toEqual({
        active: 0,
        spawned: 5,
        collected: 3,
        allyCollected: 1,
        enemyCollected: 1,
        dudCollected: 1,
        lost: 2,
      });
      expect(
        events
          .filter((event) => event.kind === "collected")
          .map((event) => event.faction)
          .sort(),
      ).toEqual(["ally", "dud", "enemy"]);
      expect(
        events
          .filter((event) => event.kind === "lost")
          .map((event) => event.faction)
          .sort(),
      ).toEqual(["dud", "enemy"]);
      for (const coin of coins) {
        expect(lifecycle.collect(coin.id)).toBe(false);
        expect(lifecycle.lose(coin.id)).toBe(false);
      }
      expect(
        lifecycle.stats().allyCollected +
          lifecycle.stats().enemyCollected +
          lifecycle.stats().dudCollected,
      ).toBe(lifecycle.stats().collected);
      expect(lifecycle.drainEvents()).toEqual([]);
      lifecycle.reset();
      expect(lifecycle.stats()).toEqual({
        active: 0,
        spawned: 0,
        collected: 0,
        allyCollected: 0,
        enemyCollected: 0,
        dudCollected: 0,
        lost: 0,
      });
      expect(
        lifecycle.spawn(
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0, w: 1 },
          0.32,
          0.13,
        ).faction,
      ).toBe("ally");
    } finally {
      world.dispose();
    }
  });
});
