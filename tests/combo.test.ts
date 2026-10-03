import { describe, expect, it } from "vitest";
import { createEncounter } from "../src/combat/encounter";
import type { Encounter, WaveDefinition } from "../src/combat/types";
import type { CoinType, Vec3 } from "../src/contracts";
import { resolveBuild } from "../src/run/modifiers";
import type { RunInventory } from "../src/run/types";
import { DEFAULT_TUNING } from "../src/simulation/config";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";

interface NativeFixture { world: RapierWorld; lifecycle: CoinLifecycle }
function wave(id: string, hp: number): WaveDefinition {
  return { id, enemies: [{ id: `${id}-enemy`, chuteId: `${id}-chute`, name: "Fixture target",
    maxHp: hp, kind: "guard", bag: ["skull", "skull", "skull", "skull", "gold"] }] };
}
async function setup(waves: readonly WaveDefinition[] = [wave("combo", 1000)], miniature = false, upgrades = 0) {
  const inventory: RunInventory = { playerChutes: [{ id: "player", bag: ["sword", "sword", "sword", "potion", "gold"] }],
    stickers: miniature ? ["miniature", "combo-bell"] : ["combo-bell"],
    effectLevels: { temperedSwords: upgrades, restorativeBrew: 0 } };
  const build = resolveBuild(inventory, { ...DEFAULT_TUNING, density: 0 },
    { swordDamage: 3, skullDamage: 2, potionHealing: 4, bombDamage: 5 });
  const entry = { playerHp: 100, currency: 0, playerChutes: inventory.playerChutes, build };
  const encounter = await createEncounter(build.tuning, { waves }, entry);
  // Controlled native fixtures exercise real collection and loss, rather than reducer echoes.
  const runtime = encounter.simulation as unknown as NativeFixture;
  encounter.step();
  return { encounter, runtime, build, entry, waves };
}
function inject(encounter: Encounter, runtime: NativeFixture, type: CoinType, position: Vec3 = { x: 0, y: -0.7, z: 4.5 }): number {
  const { radius, thickness } = encounter.simulation.tuning;
  const coin = runtime.lifecycle.spawn(position, { x: 0, y: 0, z: 0, w: 1 }, radius, thickness, type);
  expect(runtime.world.addCylinder(coin.id, coin)).toBe(true);
  return coin.id;
}

describe("simulation-timed sword combo", () => {
  it("orders same-tick swords by physical ID, upgrades before multiplication, and keeps passive combo after mascot collection", async () => {
    const { encounter, runtime } = await setup(undefined, true, 2);
    try {
      const mascot = [...encounter.simulation.gizmos.values()][0]!;
      runtime.world.nativeBody(mascot.id)!.setTranslation({ x: 0, y: -0.7, z: 4.5 }, true);
      const ids = [-3, -1, 1, 3].map((x) => inject(encounter, runtime, "sword", { x, y: -0.7, z: 4.5 }));
      const batch = encounter.step();
      expect(batch.combat.effects.map(({ id, enemyDamage, swordMultiplier }) => ({ id, enemyDamage, swordMultiplier }))).toEqual([
        { id: ids[0], enemyDamage: 4, swordMultiplier: 1 }, { id: ids[1], enemyDamage: 8, swordMultiplier: 2 },
        { id: ids[2], enemyDamage: 12, swordMultiplier: 3 }, { id: ids[3], enemyDamage: 12, swordMultiplier: 3 },
      ]);
      expect(batch.gizmoEvents).toEqual([expect.objectContaining({ id: mascot.id, kind: "collected", currency: 3 })]);
      expect(batch.combat.state.currency).toBe(3);
      expect(encounter.simulation.stats()).toMatchObject({ spawned: 4, collected: 4,
        gizmos: { spawned: 1, active: 0, collected: 1, lost: 0, pending: 0 } });
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(12);
      expect(encounter.snapshot().enemies[0]!.hp).toBe(952);
    } finally { encounter.dispose(); }
  });
  it("refreshes within 143 ticks and expires exactly at 144 ticks", async () => {
    const { encounter, runtime } = await setup();
    try {
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(3);
      for (let tick = 0; tick < 142; tick++) encounter.step();
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(6);
      for (let tick = 0; tick < 143; tick++) encounter.step();
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(3);
      expect(encounter.snapshot().combo.chain).toBe(1);
    } finally { encounter.dispose(); }
  });
  it("does not refresh from lost swords or non-swords and keeps the combo after mascot loss", async () => {
    const { encounter, runtime } = await setup();
    try {
      inject(encounter, runtime, "sword"); encounter.step();
      const committed = encounter.snapshot().combo;
      const mascot = [...encounter.simulation.gizmos.values()][0]!;
      runtime.world.nativeBody(mascot.id)!.setTranslation({ x: 100, y: 1, z: 0 }, true);
      inject(encounter, runtime, "sword", { x: 100, y: 1, z: 0 });
      inject(encounter, runtime, "potion");
      const batch = encounter.step();
      expect(batch.events.some(({ kind, type }) => kind === "lost" && type === "sword")).toBe(true);
      expect(batch.gizmoEvents).toEqual([expect.objectContaining({ id: mascot.id, kind: "lost" })]);
      expect(encounter.snapshot().combo).toEqual(committed);
      expect(encounter.snapshot().currency).toBe(0);
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(6);
    } finally { encounter.dispose(); }
  });
  it("freezes expiry while paused and resumes from simulation time", async () => {
    const { encounter, runtime } = await setup();
    try {
      inject(encounter, runtime, "sword"); encounter.step();
      const before = encounter.snapshot();
      const time = encounter.simulation.stats().time;
      encounter.setPaused(true);
      for (let attempt = 0; attempt < 200; attempt++) encounter.step();
      expect(encounter.snapshot().tick).toBe(before.tick);
      expect(encounter.snapshot().combo).toEqual(before.combo);
      expect(encounter.simulation.stats().time).toBe(time);
      encounter.setPaused(false);
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(6);
    } finally { encounter.dispose(); }
  });
  it("persists into reinforcements but resets with a fresh encounter and fresh mascot", async () => {
    const { encounter, runtime, build, entry, waves } = await setup([wave("first", 3), wave("second", 1000)]);
    try {
      const firstMascot = [...encounter.simulation.gizmos.values()][0]!.id;
      inject(encounter, runtime, "sword");
      const clear = encounter.step();
      expect(clear.waveEvents.map(({ kind }) => kind)).toEqual(["died", "entered"]);
      expect(encounter.snapshot().combo.chain).toBe(1);
      inject(encounter, runtime, "sword");
      expect(encounter.step().combat.delta.swordDamage).toBe(6);
      encounter.reset(build.tuning, { waves }, entry);
      expect(encounter.snapshot().combo).toEqual({ chain: 0, lastSwordTick: null });
      encounter.step();
      const nextMascot = [...encounter.simulation.gizmos.values()][0]!.id;
      expect(nextMascot).toBeGreaterThan(firstMascot);
      expect(encounter.simulation.stats().gizmos).toMatchObject({ spawned: 1, active: 1, collected: 0, lost: 0 });
    } finally { encounter.dispose(); }
  });
});
