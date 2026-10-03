import { describe, expect, it } from "vitest";
import { createEncounter } from "../src/combat/encounter";
import { DEFAULT_ENCOUNTER_CONFIG, GOLD_ONLY_MIX } from "../src/combat/config";
import type { Encounter, EnemyDefinition, WaveDefinition } from "../src/combat/types";
import type { CoinType, Vec3 } from "../src/contracts";
import { DEFAULT_CHUTES } from "../src/chutes";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";

interface PhysicalFixture { world: RapierWorld; lifecycle: CoinLifecycle; pendingRain: number }
function fixture(encounter: Encounter): PhysicalFixture {
  // Controlled Rapier fixtures require the native world, not a simulated combat echo.
  const runtime = encounter.simulation as unknown as PhysicalFixture;
  return runtime;
}
function wave(id: string, hps: readonly number[], kind: EnemyDefinition["kind"] = "guard"): WaveDefinition {
  return { id, enemies: hps.map((maxHp, index) => ({ id: `${id}-enemy-${index}`, name: "Fixture enemy",
    chuteId: `${id}-chute-${index}`, maxHp, kind, bag: ["skull", "skull", "skull", "gold", "gold"] })) };
}
function advance(encounter: Encounter, ticks: number): void {
  for (let index = 0; index < ticks; index++) encounter.step();
}
function inject(encounter: Encounter, type: CoinType, position: Vec3 = { x: 0, y: -0.7, z: 4.5 }) {
  const runtime = fixture(encounter);
  const coin = runtime.lifecycle.spawn(position, { x: 0, y: 0, z: 0, w: 1 },
    encounter.simulation.tuning.radius, encounter.simulation.tuning.thickness, type);
  expect(runtime.world.addCylinder(coin.id, coin)).toBe(true);
  return { coin, body: runtime.world.nativeBody(coin.id)! };
}
async function activeEncounter() {
  const encounter = await createEncounter({ density: 0, seed: 71 }, { waves: [wave("fixture", [1000])], openingMix: GOLD_ONLY_MIX });
  advance(encounter, 720);
  expect(encounter.snapshot().phase).toBe("active");
  return encounter;
}

describe("continuous encounter lifecycle", () => {
  it("resolves real catches during loading before magazines are available", async () => {
    const encounter = await createEncounter({ density: 0 }, { waves: [wave("loading", [1000])] },
      { playerHp: 50, currency: 7, playerChutes: [{ id: "player", bag: ["sword", "sword", "sword", "potion", "gold"] }] });
    try {
      expect(encounter.drop(0)).toBe(false);
      expect(encounter.preview()).toEqual([]);
      ["sword", "skull", "potion", "gold", "diamond", "bomb"].forEach((type, index) =>
        inject(encounter, type as CoinType, { x: index - 2.5, y: -0.7, z: 4.5 }));
      const step = encounter.step();
      expect(step.combat.state).toMatchObject({ playerHp: 52, currency: 18 });
      expect(step.combat.state.enemies[0]!.hp).toBe(997);
      expect(step.combat.delta).toMatchObject({ swordDamage: 3, skullDamage: 2, healingUsed: 4, safeBombs: 1, currencyGained: 11 });
      expect(encounter.snapshot().loading.collectedByType).toEqual({ sword: 1, skull: 1, potion: 1, gold: 1, diamond: 1, bomb: 1 });
      advance(encounter, 719);
      expect(encounter.snapshot()).toMatchObject({ phase: "active", playerHp: 52, currency: 18 });
      expect(encounter.snapshot().totals.swordDamage).toBe(3);
      expect(encounter.preview().filter(({ enabled }) => enabled)).toHaveLength(2);
    } finally { encounter.dispose(); }
  });

  it("arms physical bombs from the first loading ticks without inventing contacts", async () => {
    const encounter = await createEncounter({ density: 0 }, { waves: [wave("bomb", [1000])],
      bomb: { ...DEFAULT_ENCOUNTER_CONFIG.bomb, hitThreshold: 1 } });
    try {
      const bomb = inject(encounter, "bomb", { x: 0, y: 1, z: 2 });
      bomb.body.lockTranslations(true, true);
      bomb.body.lockRotations(true, true);
      const falling = inject(encounter, "gold", { x: 0, y: 1.5, z: 2 });
      falling.body.lockRotations(true, true);
      for (let tick = 0; tick < 120 && encounter.snapshot().totals.detonations === 0; tick++) encounter.step();
      expect(encounter.snapshot()).toMatchObject({ phase: "loading", playerHp: 95 });
      expect(encounter.snapshot().enemies[0]!.hp).toBe(995);
      expect(encounter.snapshot().totals).toMatchObject({ detonations: 1, bombDamageToPlayer: 5, bombDamageToEnemy: 5 });
    } finally { encounter.dispose(); }
  });

  it("supports an opening victory with zero actions and freezes partial rain exactly once", async () => {
    const encounter = await createEncounter({ density: 400 }, { waves: [wave("opening", [1])], openingMix: GOLD_ONLY_MIX });
    try {
      inject(encounter, "sword");
      const step = encounter.step();
      expect(step.combat.state.result).toBe("victory");
      expect(encounter.snapshot()).toMatchObject({ phase: "finished", acceptedActions: 0, acceptedRounds: 0, completionSerial: 1 });
      expect(encounter.simulation.stats().pendingRain).toBe(0);
      expect(encounter.simulation.stats().spawned).toBeLessThan(401);
      const before = encounter.snapshot();
      const stats = encounter.simulation.stats();
      advance(encounter, 30);
      expect(encounter.snapshot()).toEqual(before);
      expect(encounter.simulation.stats()).toEqual(stats);
      expect(encounter.drop(0)).toBe(false);
      encounter.reset({ density: 0 });
      advance(encounter, 720);
      expect(encounter.simulation.stats().spawned).toBe(0);
      expect(encounter.snapshot().phase).toBe("active");
    } finally { encounter.dispose(); }
  });

  it("ends lethal skull loading without waiting for a magazine or erasing later-wave enemies", async () => {
    const encounter = await createEncounter({ density: 400 }, { waves: [wave("first", [10]), wave("later", [20])], openingMix: GOLD_ONLY_MIX },
      { playerHp: 1, currency: 0, playerChutes: [{ id: "player", bag: Array(5).fill("sword") }] });
    try {
      inject(encounter, "skull");
      const step = encounter.step();
      expect(step.combat.state.result).toBe("defeat");
      expect(step.waveEvents).toEqual([]);
      expect(encounter.snapshot()).toMatchObject({ phase: "finished", waveIndex: 0, acceptedActions: 0 });
      expect(encounter.snapshot().enemies[0]!.hp).toBe(10);
      expect(encounter.simulation.stats().pendingRain).toBe(0);
      const before = encounter.snapshot();
      advance(encounter, 60);
      expect(encounter.snapshot()).toEqual(before);
    } finally { encounter.dispose(); }
  });

  it("resolves healing before lethal loading damage and gives final simultaneous defeat precedence", async () => {
    const encounter = await createEncounter({ density: 0 }, { waves: [wave("lethal", [3])] },
      { playerHp: 2, currency: 0, playerChutes: [{ id: "player", bag: Array(5).fill("sword") }] });
    try {
      inject(encounter, "skull", { x: -1, y: -0.7, z: 4.5 });
      inject(encounter, "potion", { x: 1, y: -0.7, z: 4.5 });
      expect(encounter.step().combat.state.playerHp).toBe(4);
      inject(encounter, "skull", { x: -2, y: -0.7, z: 4.5 });
      inject(encounter, "skull", { x: 0, y: -0.7, z: 4.5 });
      inject(encounter, "sword", { x: 2, y: -0.7, z: 4.5 });
      expect(encounter.step().combat.state.result).toBe("simultaneous-defeat");
      expect(encounter.snapshot().phase).toBe("finished");
    } finally { encounter.dispose(); }
  });

  it.each([{ swordDamage: 3, swords: 2, discarded: 0 }, { swordDamage: 9, swords: 1, discarded: 3 }])(
    "confines $swordDamage damage swords to born enemies and enters reinforcements after the batch", async ({ swordDamage, swords, discarded }) => {
      const encounter = await createEncounter({ density: 0 }, { waves: [wave("first", [2, 4]), wave("next", [17])], swordDamage });
      try {
        for (let index = 0; index < swords; index++) inject(encounter, "sword", { x: index * 2, y: -0.7, z: 4.5 });
        inject(encounter, "gold", { x: -2, y: -0.7, z: 4.5 });
        const step = encounter.step();
        expect(step.combat.state.enemies.map(({ hp }) => hp)).toEqual([0, 0]);
        expect(step.combat.delta).toMatchObject({ enemyHpRemoved: 6, discardedDamage: discarded, currencyGained: 1 });
        expect(step.waveEvents.map(({ kind }) => kind)).toEqual(["died", "entered"]);
        expect(encounter.snapshot()).toMatchObject({ phase: "loading", waveIndex: 1, result: null, currency: 1 });
        expect(encounter.snapshot().enemies.map(({ hp }) => hp)).toEqual([17]);
        expect(encounter.preview()).toEqual([]);
        advance(encounter, 719);
        expect(encounter.preview().find(({ source }) => source === "enemy")!.ownerId).toBe("next-enemy-0");
      } finally { encounter.dispose(); }
    },
  );

  it("shutters a dead enemy without deleting its admitted skull or shifting reserved lanes", async () => {
    const encounter = await createEncounter({ density: 0 }, { waves: [wave("roster", [2, 1000])] });
    try {
      advance(encounter, 720);
      const layout = encounter.preview().map(({ id, x }) => ({ id, x }));
      expect(encounter.drop(0)).toBe(true);
      const enemyCoin = encounter.snapshot().lastAdmission!.coins.find(({ chuteId }) => chuteId === "roster-chute-0")!;
      const native = fixture(encounter).world.nativeBody(enemyCoin.id);
      inject(encounter, "sword");
      encounter.step();
      const shutter = encounter.preview().find(({ id }) => id === "roster-chute-0")!;
      expect(shutter).toMatchObject({ enabled: false, coins: [], preview: [] });
      expect(encounter.preview().map(({ id, x }) => ({ id, x }))).toEqual(layout);
      expect(encounter.simulation.coins.has(enemyCoin.id)).toBe(true);
      expect(fixture(encounter).world.nativeBody(enemyCoin.id)).toBe(native);
    } finally { encounter.dispose(); }
  });

  it("interrupts a captured set at a wave boundary but retains player stream and native stock", async () => {
    const encounter = await createEncounter({ density: 0 }, { waves: [wave("first", [1]), wave("next", [1000])] });
    try {
      advance(encounter, 720);
      expect(encounter.drop(0, { ...DEFAULT_CHUTES, dropsPerAction: 3 })).toBe(true);
      const playerStock = encounter.preview().find(({ source }) => source === "player")!.coins.map(({ id }) => id);
      inject(encounter, "sword");
      encounter.step();
      expect(encounter.snapshot()).toMatchObject({ waveIndex: 1, remainingRounds: 0, interruptedRounds: 2, acceptedRounds: 1 });
      expect(encounter.preview().find(({ source }) => source === "player")!.coins.map(({ id }) => id)).toEqual(playerStock);
      expect(encounter.preview().find(({ source }) => source === "enemy")!.id).toBe("next-chute-0");
      advance(encounter, 180);
      expect(encounter.snapshot().acceptedRounds).toBe(1);
      expect(encounter.drop(0)).toBe(true);
    } finally { encounter.dispose(); }
  });

  it("keeps aim and spacing captured, applies deferred aim after the set, and cancels on pause", async () => {
    const encounter = await activeEncounter();
    try {
      expect(encounter.drop(0, { ...DEFAULT_CHUTES, dropsPerAction: 2 })).toBe(true);
      const positions = encounter.preview().map(({ x }) => x);
      encounter.setAim(1.5, { ...DEFAULT_CHUTES, chuteSpacing: 1 });
      expect(encounter.preview().map(({ x }) => x)).toEqual(positions);
      for (let tick = 0; tick < 500 && encounter.snapshot().remainingRounds; tick++) encounter.step();
      expect(encounter.snapshot()).toMatchObject({ acceptedRounds: 2, remainingRounds: 0 });
      expect(encounter.preview().find(({ source }) => source === "player")!.x).toBe(1.5);
      expect(encounter.drop(1.5, { ...DEFAULT_CHUTES, dropsPerAction: 3 })).toBe(true);
      encounter.setPaused(true);
      const before = encounter.snapshot();
      advance(encounter, 60);
      expect(encounter.snapshot()).toEqual(before);
      expect(encounter.snapshot().remainingRounds).toBe(0);
      encounter.setPaused(false);
      advance(encounter, 180);
      expect(encounter.snapshot().acceptedRounds).toBe(before.acceptedRounds);
    } finally { encounter.dispose(); }
  });

  it("counts real admitted rows for escalation and preserves the five committed native types", async () => {
    const encounter = await createEncounter({ density: 0 }, { waves: [wave("pressure", [1000], "escalator")] });
    try {
      advance(encounter, 720);
      for (let round = 0; round < 10; round++) {
        expect(encounter.drop(0)).toBe(true);
        for (let tick = 0; tick < 500 && encounter.snapshot().acceptedRounds <= round; tick++) encounter.step();
        expect(encounter.snapshot().acceptedRounds).toBe(round + 1);
        const enemy = encounter.preview().find(({ source }) => source === "enemy")!;
        expect(enemy.coins.slice(0, 5).map(({ type }) => type)).toEqual(enemy.preview);
        advance(encounter, 180);
      }
      expect(encounter.snapshot().enemies[0]!.admittedRounds).toBe(10);
      advance(encounter, 300);
      for (let round = 0; round < 10; round++) { encounter.drop(0); advance(encounter, 240); }
      expect(encounter.preview().find(({ source }) => source === "enemy")!.preview).toEqual(Array(5).fill("skull"));
    } finally { encounter.dispose(); }
  });

  it("rejects invalid entry bags before replacing the native world and resets seeded geometry with fresh IDs", async () => {
    const encounter = await createEncounter({ density: 4, seed: 113 }, { openingMix: GOLD_ONLY_MIX, waves: [wave("seed", [1000])] });
    try {
      encounter.step();
      const first = [...encounter.simulation.coins.values()].map((coin) => structuredClone(coin));
      const stats = encounter.simulation.stats();
      expect(() => encounter.reset(undefined, undefined, { playerHp: 10, currency: 0, playerChutes: [{ id: "player", bag: [] }] })).toThrow();
      expect(encounter.simulation.stats()).toEqual(stats);
      encounter.reset();
      encounter.step();
      const reset = [...encounter.simulation.coins.values()];
      expect(reset.every(({ id }) => id > first.at(-1)!.id)).toBe(true);
      expect(reset.map(({ id: _id, ...coin }) => coin)).toEqual(first.map(({ id: _id, ...coin }) => coin));
    } finally { encounter.dispose(); }
  });

  it("freezes an incomplete opening at the loader cap without resuming future rain", async () => {
    const encounter = await createEncounter({ density: 0 });
    try {
      fixture(encounter).pendingRain = 1;
      advance(encounter, 1440);
      expect(encounter.snapshot()).toMatchObject({ phase: "error", error: "Opening load incomplete; reseed the pile" });
      const time = encounter.simulation.stats().time;
      advance(encounter, 30);
      expect(encounter.simulation.stats().time).toBe(time);
      expect(encounter.simulation.stats().pendingRain).toBe(0);
      expect(encounter.drop(0)).toBe(false);
      encounter.reset();
      advance(encounter, 720);
      expect(encounter.snapshot().phase).toBe("active");
    } finally { encounter.dispose(); }
  });
});
