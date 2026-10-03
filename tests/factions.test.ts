import * as RAPIER from "@dimforge/rapier3d-compat";
import { describe, expect, it } from "vitest";
import { GOLD_ONLY_MIX } from "../src/combat/config";
import { COIN_TYPES, type CoinEvent, type CoinType } from "../src/contracts";
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
import { createSyntheticSlots } from "../src/experiments/chutes";


describe("playable chute sources", () => {
  it("admits every selected chute at spacing and aim boundaries without overlap or partial release", async () => {
    const simulation = await createSimulation(
      { density: 0 },
      { openingMix: GOLD_ONLY_MIX },
    );
    try {
      for (const radius of [0.2, 0.32, 0.6]) {
        for (let enemyChutes = 0; enemyChutes <= 4; enemyChutes++) {
          for (const chuteSpacing of [0, 3]) {
            for (const requestedX of [-9, 9]) {
              simulation.reset({ density: 0, radius });
              const settings = sanitizeChutes(
                {
                  ...DEFAULT_CHUTES,
                  chuteSpacing,
                },
                simulation.tuning,
              );
              const layout = createChuteLayout(
                createSyntheticSlots(enemyChutes),
                simulation.tuning,
                requestedX,
                settings.chuteSpacing,
              );
              const ids = simulation.releaseChutes(
                layout.map(({ x, count, source }) => ({
                  x,
                  count,
                  type:
                    source === "enemy" ? ("skull" as const) : ("sword" as const),
                })),
              );
              expect(ids).not.toBeNull();
              expect(layout).toHaveLength(enemyChutes + 1);
              expect(ids).toHaveLength(enemyChutes + 1);
              expect(layout[0]!.source).toBe("player");
              for (let index = 0; index < layout.length; index++) {
                const chute = layout[index]!;
                expect(simulation.coins.get(ids![index]!)).toMatchObject({
                  type: index === 0 ? "sword" : "skull",
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
      createSyntheticSlots(3),
      DEFAULT_TUNING,
      -9,
      1.5,
    );
    expect(layout.map((chute) => chute.x - layout[0]!.x)).toEqual([
      0, -1.5, 1.5, -3,
    ]);
    expect(layout.map((chute) => chute.count)).toEqual([1, 1, 1, 1]);
    expect(layout[0]!.x).toBeCloseTo(-1.4);
  });

  it("reserves six roster slots and does not shift survivors when an enemy closes", () => {
    const slots = [
      ...[0, 1, -1].map((slot, index) => ({
        id: `player-${index}`, ownerId: "player", source: "player" as const, slot, enabled: true,
      })),
      ...[-2, 2, -3].map((slot, index) => ({
        id: `enemy-${index}`, ownerId: `enemy-${index}`, source: "enemy" as const, slot, enabled: true,
      })),
    ];
    for (const radius of [0.24, 0.32]) {
      for (const aim of [-100, 0, 100]) {
        const before = createChuteLayout(slots, { radius }, aim, 3);
        const after = createChuteLayout(slots.map((slot) => slot.id === "enemy-0"
          ? { ...slot, enabled: false } : slot), { radius }, aim, 3);
        expect(after.map(({ id, x }) => ({ id, x }))).toEqual(before.map(({ id, x }) => ({ id, x })));
        for (const lane of after) expect(Math.abs(lane.x) + radius).toBeLessThan(5);
        const positions = after.map(({ x }) => x).sort((a, b) => a - b);
        for (let index = 1; index < positions.length; index++) {
          expect(positions[index]! - positions[index - 1]!).toBeGreaterThanOrEqual(2 * radius + 0.019999);
        }
      }
    }
    expect(() => createChuteLayout([slots[0]!, slots[0]!], DEFAULT_TUNING, 0, 0.66)).toThrow("Invalid chute slots");
  });

  it("preserves types through real physics, separates catches, and never counts losses or duplicate resolution", async () => {
    await RAPIER.init();
    const world = new RapierWorld(DEFAULT_TUNING);
    const lifecycle = new CoinLifecycle();
    const types: CoinType[] = ["gold", "sword", "skull", "potion", "bomb"];
    const coins = types.map((type, index) =>
      lifecycle.spawn(
        {
          x: index - 2,
          y: index === 2 || index === 4 ? -1 : 0.2,
          z: index === 2 || index === 4 ? 3 : 4.5,
        },
        { x: 0, y: 0, z: 0, w: 1 },
        0.32,
        0.13,
        type,
      ),
    );
    const events: CoinEvent[] = [];
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
          else lifecycle.lose(id, "out-of-bounds", position);
          world.removeCylinder(id);
        });
        events.push(...lifecycle.drainEvents());
      }
      expect(lifecycle.stats()).toEqual({
        active: 0,
        spawned: 5,
        collected: 3,
        collectedByType: {
          gold: 1,
          diamond: 0,
          sword: 1,
          skull: 0,
          potion: 1,
          bomb: 0,
        },
        detonated: 0,
        lost: 2,
      });
      expect(
        events
          .filter((event) => event.kind === "collected")
          .map((event) => event.type)
          .sort(),
      ).toEqual(["gold", "potion", "sword"]);
      expect(
        events
          .filter((event) => event.kind === "lost")
          .map((event) => event.type)
          .sort(),
      ).toEqual(["bomb", "skull"]);
      for (const coin of coins) {
        expect(lifecycle.collect(coin.id)).toBe(false);
        expect(lifecycle.lose(coin.id, "out-of-bounds")).toBe(false);
      }
      expect(
        COIN_TYPES.reduce(
          (total, type) => total + lifecycle.stats().collectedByType[type],
          0,
        ),
      ).toBe(lifecycle.stats().collected);
      expect(lifecycle.drainEvents()).toEqual([]);
      lifecycle.reset();
      expect(lifecycle.stats()).toEqual({
        active: 0,
        spawned: 0,
        collected: 0,
        collectedByType: {
          gold: 0,
          diamond: 0,
          sword: 0,
          skull: 0,
          potion: 0,
          bomb: 0,
        },
        detonated: 0,
        lost: 0,
      });
      expect(
        lifecycle.spawn(
          { x: 0, y: 0, z: 0 },
          { x: 0, y: 0, z: 0, w: 1 },
          0.32,
          0.13,
        ).type,
      ).toBe("sword");
    } finally {
      world.dispose();
    }
  });
});
