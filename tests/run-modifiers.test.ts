import { describe, expect, it } from "vitest";
import { resolveBuild } from "../src/run/modifiers";
import type { RunInventory, StickerId } from "../src/run/types";
import { DEFAULT_TUNING } from "../src/simulation/config";
import { createEncounter } from "../src/combat/encounter";
import { DEFAULT_ENCOUNTER_CONFIG } from "../src/combat/config";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";

const effects = { swordDamage: 3, skullDamage: 2, potionHealing: 4, bombDamage: 5 };
function inventory(stickers: readonly StickerId[]): RunInventory {
  return { stickers, effectLevels: { temperedSwords: 2, restorativeBrew: 2 },
    playerChutes: [{ id: "player", bag: ["sword", "sword", "sword", "potion", "gold"] }] };
}
const combinations: readonly StickerId[][] = [
  ["collected-only", "miniature"], ["collected-only", "magazine-dump"], ["collected-only", "combo-bell"],
  ["miniature", "magazine-dump"], ["miniature", "combo-bell"], ["magazine-dump", "combo-bell"],
  ["collected-only", "miniature", "combo-bell"],
];

describe("composable resolved builds", () => {
  it.each(combinations.map((stickers) => ({ stickers })))("keeps $stickers orthogonal and applies upgrades after physical sword scaling", ({ stickers }) => {
    const owned = inventory(stickers);
    const before = structuredClone(owned);
    const build = resolveBuild(owned, DEFAULT_TUNING, effects);
    expect(build.swordDamage).toBe(stickers.includes("miniature") ? 4 : 5);
    expect(build.potionHealing).toBe(8);
    expect(build.bombDamage).toBe(stickers.includes("collected-only") ? 0 : 5);
    expect(build.combo).toEqual(stickers.includes("combo-bell") ? { windowTicks: 144, maxMultiplier: 3 } : { windowTicks: 0, maxMultiplier: 1 });
    expect(build.releaseMode).toBe(stickers.includes("magazine-dump") ? "dump" : "ordinary");
    expect(build.tuning.density).toBe(stickers.includes("miniature") ? 600 : 400);
    expect(build.tuning.coinWeight).toBe(1);
    expect(owned).toEqual(before);
  });
  it("scales the configured diagnostic baseline within supported cylinder and population bounds", () => {
    const build = resolveBuild(inventory(["miniature"]), { ...DEFAULT_TUNING, radius: 0.05, thickness: 0.02, density: 1000 }, effects);
    expect(build.tuning).toMatchObject({ radius: 0.05, thickness: 0.02, density: 1000 });
    const ordinary = resolveBuild(inventory([]), DEFAULT_TUNING, effects);
    expect(ordinary.tuning).toEqual(DEFAULT_TUNING);
  });
  it("changes real opening and native stock cylinders and keeps stock outside coin accounting", async () => {
    const owned = inventory(["miniature"]);
    const build = resolveBuild(owned, { ...DEFAULT_TUNING, density: 4 }, effects);
    const encounter = await createEncounter(build.tuning, { swordDamage: build.swordDamage, potionHealing: build.potionHealing },
      { playerHp: 100, currency: 0, playerChutes: owned.playerChutes, build });
    try {
      encounter.step();
      // Inspect the actual native collider; CoinView dimensions alone cannot prove physics scaling.
      const runtime = encounter.simulation as unknown as { world: RapierWorld };
      const coin = [...encounter.simulation.coins.values()][0]!;
      const cylinder = runtime.world.nativeBody(coin.id)!.collider(0).shape;
      expect(cylinder).toMatchObject({ radius: 0.24, halfHeight: 0.04875 });
      for (let tick = 1; tick < 720; tick++) encounter.step();
      expect(encounter.simulation.stats().spawned).toBe(6);
      for (const tray of encounter.preview()) {
        expect(tray.coins).toHaveLength(5);
        for (const stock of tray.coins) {
          expect(stock).toMatchObject({ radius: 0.24, thickness: 0.0975 });
          expect(runtime.world.nativeBody(stock.id)!.collider(0).shape).toMatchObject({ radius: 0.24, halfHeight: 0.04875 });
        }
      }
    } finally { encounter.dispose(); }
  });
  it("collected-only retains real bomb impulses and arming while suppressing only detonation HP", async () => {
    async function physical(stickers: readonly StickerId[]) {
      const owned = inventory(stickers);
      const build = resolveBuild(owned, { ...DEFAULT_TUNING, density: 0 }, effects);
      const encounter = await createEncounter(build.tuning,
        { bomb: { ...DEFAULT_ENCOUNTER_CONFIG.bomb, hitThreshold: 1 } },
        { playerHp: 50, currency: 0, playerChutes: owned.playerChutes, build });
      try {
        // These loading fixtures must enter the real native collision and collection paths.
        const runtime = encounter.simulation as unknown as { world: RapierWorld; lifecycle: CoinLifecycle };
        const bomb = runtime.lifecycle.spawn({ x: 0, y: 1, z: 2 }, { x: 0, y: 0, z: 0, w: 1 }, 0.32, 0.13, "bomb");
        const falling = runtime.lifecycle.spawn({ x: 0, y: 1.5, z: 2 }, { x: 0, y: 0, z: 0, w: 1 }, 0.32, 0.13, "gold");
        const nearby = runtime.lifecycle.spawn({ x: 1, y: 1, z: 2 }, { x: 0, y: 0, z: 0, w: 1 }, 0.32, 0.13, "skull");
        for (const coin of [bomb, falling, nearby]) runtime.world.addCylinder(coin.id, coin);
        const bombBody = runtime.world.nativeBody(bomb.id)!;
        bombBody.lockTranslations(true, true); bombBody.lockRotations(true, true);
        runtime.world.nativeBody(falling.id)!.lockRotations(true, true);
        for (let tick = 0; tick < 120 && !encounter.snapshot().totals.detonations; tick++) encounter.step();
        const velocity = runtime.world.nativeBody(nearby.id)!.linvel();
        const before = encounter.snapshot();
        const skull = runtime.lifecycle.spawn({ x: -2, y: -0.7, z: 4.5 }, { x: 0, y: 0, z: 0, w: 1 }, 0.32, 0.13, "skull");
        runtime.world.addCylinder(skull.id, skull);
        encounter.step();
        return { before, velocity: { ...velocity }, after: encounter.snapshot() };
      } finally { encounter.dispose(); }
    }
    const standard = await physical([]);
    const safe = await physical(["collected-only"]);
    expect(safe.before.totals).toMatchObject({ detonations: 1, bombDamageToPlayer: 0, bombDamageToEnemy: 0 });
    expect(standard.before.totals).toMatchObject({ detonations: 1, bombDamageToPlayer: 5, bombDamageToEnemy: 5 });
    expect(safe.velocity).toEqual(standard.velocity);
    expect(Math.abs(safe.velocity.x)).toBeGreaterThan(0.1);
    expect(safe.after.playerHp).toBe(safe.before.playerHp - 2);
  });
});
