import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CHUTES } from "../src/chutes";
import { createEncounter } from "../src/combat/encounter";
import { GOLD_ONLY_MIX } from "../src/combat/config";
import type { Encounter, EncounterEntry, EnemyDefinition, RoundAdmission, WaveDefinition } from "../src/combat/types";
import type { CoinType } from "../src/contracts";
import { resolveBuild } from "../src/run/modifiers";
import { DEFAULT_TUNING } from "../src/simulation";
import type { RapierWorld } from "../src/simulation/rapier-world";
import type { CoinLifecycle } from "../src/simulation/lifecycle";

interface NativeFixture { world: RapierWorld; lifecycle: CoinLifecycle }

const encounters: Encounter[] = [];
const playerBag: readonly CoinType[] = ["sword", "potion", "gold", "sword", "bomb"];
const enemyBag: readonly CoinType[] = ["skull", "skull", "skull", "gold", "gold"];

function wave(id: string, enemyCount = 1, kind: EnemyDefinition["kind"] = "guard"): WaveDefinition {
  return {
    id,
    enemies: Array.from({ length: enemyCount }, (_, index) => ({
      id: `${id}-enemy-${index}`,
      name: `Enemy ${index + 1}`,
      maxHp: 10_000,
      chuteId: `${id}-chute-${index}`,
      kind,
      bag: enemyBag,
    })),
  };
}

function dumpEntry(playerCount = 1): EncounterEntry {
  const playerChutes = Array.from({ length: playerCount }, (_, index) => ({
    id: `player-${index}`,
    bag: playerBag,
  }));
  const build = resolveBuild(
    { playerChutes, stickers: ["magazine-dump"], effectLevels: { temperedSwords: 0, restorativeBrew: 0 } },
    DEFAULT_TUNING,
    { swordDamage: 3, skullDamage: 2, potionHealing: 4, bombDamage: 5 },
  );
  return { playerHp: 100, currency: 0, playerChutes, build };
}

async function create(enemyCount = 1, playerCount = 1, kind: EnemyDefinition["kind"] = "guard") {
  const encounter = await createEncounter(
    { density: 0, seed: 211 },
    { openingMix: GOLD_ONLY_MIX, waves: [wave("burst", enemyCount, kind)] },
    dumpEntry(playerCount),
  );
  encounters.push(encounter);
  for (let tick = 0; tick < 720; tick++) encounter.step();
  expect(encounter.snapshot().phase).toBe("active");
  return encounter;
}

function nativeStock(encounter: Encounter): Map<string, readonly { id: number; body: unknown }[]> {
  // Physical regressions intentionally inspect the concrete native adapter to verify retained stock.
  const fixture = encounter.simulation as unknown as NativeFixture;
  return new Map(encounter.preview().map((tray) => [tray.id, tray.coins.map((coin) => ({
    id: coin.id,
    body: fixture.world.nativeBody(coin.id),
  }))]));
}

afterEach(() => {
  for (const encounter of encounters) encounter.dispose();
  encounters.length = 0;
});

describe("encounter magazine dump scheduling", () => {
  it("turns one requested unit into five row commitments while reporting later fragments only once", async () => {
    const encounter = await create(3, 2, "escalator");
    expect(encounter.drop(0)).toBe(true);
    const fragments: RoundAdmission[] = [];
    let admittedBodies = 0;
    for (let tick = 0; tick < 1440 && admittedBodies < 25; tick++) {
      const step = encounter.step();
      fragments.push(...step.admissions);
      for (const admission of step.admissions) admittedBodies += admission.coins.length;
    }
    expect(admittedBodies).toBe(25);

    expect(encounter.snapshot()).toMatchObject({ acceptedActions: 1, acceptedRounds: 5 });
    expect(fragments.every(({ action }) => action === 1)).toBe(true);
    expect(new Set(fragments.map(({ round }) => round)).size).toBe(5);
    expect(fragments.filter(({ newRound }) => newRound).map(({ round }) => round).sort()).toEqual([1, 2, 3, 4, 5]);
    for (let round = 1; round <= 5; round++) {
      const rowFragments = fragments.filter((fragment) => fragment.round === round);
      expect(rowFragments[0]!.newRound).toBe(true);
      expect(rowFragments.slice(1).every(({ newRound }) => !newRound)).toBe(true);
    }
    expect(encounter.snapshot().enemies.map(({ admittedRounds }) => admittedRounds)).toEqual([5, 5, 5]);
    expect(encounter.snapshot().feedStreams.map(({ consumed }) => consumed)).toEqual([5, 5, 5, 5, 5]);
  });

  it("consumes only actually admitted chute tokens and retains captured aim until native rearm completes", async () => {
    const encounter = await create(1, 1);
    expect(encounter.drop(0)).toBe(true);
    const capturedX = encounter.preview().map(({ x }) => x);
    encounter.setAim(1.5, { ...DEFAULT_CHUTES, chuteSpacing: 1 });
    expect(encounter.preview().map(({ x }) => x)).toEqual(capturedX);

    let firstAdmissions: readonly RoundAdmission[] = [];
    for (let tick = 0; tick < 1800 && firstAdmissions.length === 0; tick++)
      firstAdmissions = encounter.step().admissions;
    expect(firstAdmissions.length).toBeGreaterThan(0);
    const consumed = new Map(encounter.snapshot().feedStreams.map((stream) => [stream.chuteId, stream.consumed]));
    for (const tray of encounter.preview()) {
      const admitted = firstAdmissions.flatMap(({ coins }) => coins)
        .filter(({ chuteId }) => chuteId === tray.id).length;
      expect(consumed.get(tray.id)).toBe(admitted);
    }
    for (let tick = 0; tick < 5400 && encounter.preview().some(({ burst }) => burst.phase !== "idle"); tick++)
      encounter.step();
    expect(encounter.preview().every(({ burst }) => burst.phase === "idle")).toBe(true);
    expect(encounter.preview().find(({ source }) => source === "player")!.x).toBe(1.5);
  });

  it("finishes native rearm when admitted coins travel beyond the finite tray", async () => {
    const encounter = await create(1, 1);
    expect(encounter.drop(0)).toBe(true);
    const admittedIds: number[] = [];
    for (let tick = 0; tick < 1800 && admittedIds.length < 10; tick++)
      for (const admission of encounter.step().admissions)
        admittedIds.push(...admission.coins.map(({ id }) => id));
    expect(admittedIds).toHaveLength(10);
    expect(encounter.preview().every(({ gateOpen }) => gateOpen)).toBe(true);

    const fixture = encounter.simulation as unknown as { world: RapierWorld };
    const bodies = admittedIds.map((id, index) => {
      const body = fixture.world.nativeBody(id)!;
      const x = body.translation().x;
      body.setTranslation({ x, y: 1.5, z: 0.5 + index * 0.7 }, true);
      body.setGravityScale(0, true);
      body.lockTranslations(true, true);
      return body;
    });
    encounter.step();

    expect(encounter.preview().every(({ gateOpen, burst }) =>
      !gateOpen && !burst.trapRetracted)).toBe(true);
    admittedIds.forEach((id, index) =>
      expect(fixture.world.nativeBody(id)).toBe(bodies[index]));
    for (let tick = 0; tick < 600 && encounter.preview().some(({ burst }) => burst.phase !== "idle"); tick++)
      encounter.step();
    expect(encounter.preview().every(({ burst }) => burst.phase === "idle")).toBe(true);
    expect(encounter.drop(0)).toBe(true);
  });

  it("cancels on pause before admission without charging bags or replacing still-native bodies", async () => {
    const encounter = await create(1, 1);
    const stock = nativeStock(encounter);
    expect(encounter.drop(0)).toBe(true);
    encounter.setPaused(true);
    const paused = encounter.snapshot();
    for (let tick = 0; tick < 120; tick++) expect(encounter.step().admissions).toEqual([]);
    expect(encounter.snapshot()).toEqual(paused);
    expect(encounter.snapshot().feedStreams.every(({ consumed }) => consumed === 0)).toBe(true);

    encounter.setPaused(false);
    for (let tick = 0; tick < 600 && encounter.preview().some(({ burst }) => burst.phase !== "idle"); tick++)
      encounter.step();
    // The adapter cast is isolated above; compare native object identity through that fixture only.
    const fixture = encounter.simulation as unknown as { world: RapierWorld };
    for (const tray of encounter.preview()) {
      expect(tray.coins.map(({ id }) => id)).toEqual(stock.get(tray.id)!.map(({ id }) => id));
      tray.coins.forEach((coin, index) =>
        expect(fixture.world.nativeBody(coin.id)).toBe(stock.get(tray.id)![index]!.body));
    }
    expect(encounter.snapshot()).toMatchObject({ acceptedRounds: 0, remainingRounds: 0 });
  });

  it("supports the miniature six-lane cohort without changing five-row accounting", async () => {
    const entry = dumpEntry(3);
    const miniatureBuild = resolveBuild(
      {
        playerChutes: entry.playerChutes,
        stickers: ["magazine-dump", "miniature"],
        effectLevels: { temperedSwords: 0, restorativeBrew: 0 },
      },
      DEFAULT_TUNING,
      { swordDamage: 3, skullDamage: 2, potionHealing: 4, bombDamage: 5 },
    );
    const encounter = await createEncounter(
      { ...miniatureBuild.tuning, density: 0, seed: 307 },
      { openingMix: GOLD_ONLY_MIX, waves: [wave("mini-six", 3)] },
      { ...entry, build: miniatureBuild },
    );
    encounters.push(encounter);
    for (let tick = 0; tick < 720; tick++) encounter.step();
    expect(encounter.drop(0)).toBe(true);
    let admittedBodies = 0;
    for (let tick = 0; tick < 1440 && admittedBodies < 30; tick++)
      for (const admission of encounter.step().admissions) admittedBodies += admission.coins.length;
    expect(admittedBodies).toBe(30);

    expect(encounter.snapshot()).toMatchObject({ acceptedRounds: 5 });
    expect(encounter.preview()).toHaveLength(6);
    expect(encounter.snapshot().feedStreams.map(({ consumed }) => consumed)).toEqual(Array(6).fill(5));
    expect(encounter.simulation.stats().spawned).toBe(30);
  });
});

describe("native enemy feed ownership", () => {
  it("shutters a final dead enemy without deleting its admitted coin", async () => {
    const definition = wave("terminal");
    const encounter = await createEncounter(
      { density: 0, seed: 211 },
      { openingMix: GOLD_ONLY_MIX, waves: [{
        ...definition, enemies: definition.enemies.map(enemy => ({ ...enemy, maxHp: 3 })),
      }] },
    );
    encounters.push(encounter);
    for (let tick = 0; tick < 720; tick++) encounter.step();
    expect(encounter.drop(0)).toBe(true);
    const admitted = encounter.snapshot().lastAdmission!.coins.find(coin => coin.chuteId === "terminal-chute-0")!;
    // Inspect concrete native identity; terminal reconciliation must remove only unadmitted stock.
    const runtime = encounter.simulation as unknown as NativeFixture;
    const body = runtime.world.nativeBody(admitted.id);
    expect(body?.isDynamic()).toBe(true);
    const { radius, thickness } = encounter.simulation.tuning;
    const sword = runtime.lifecycle.spawn({ x: 3, y: -0.7, z: 4.5 }, { x: 0, y: 0, z: 0, w: 1 }, radius, thickness, "sword");
    runtime.world.addCylinder(sword.id, sword);
    encounter.step();
    expect(encounter.snapshot()).toMatchObject({ phase: "finished", result: "victory" });
    expect(encounter.preview().find(tray => tray.id === "terminal-chute-0")).toMatchObject({ enabled: false, coins: [] });
    expect(encounter.simulation.coins.get(admitted.id)?.type).toBe(admitted.type);
    expect(runtime.world.nativeBody(admitted.id)).toBe(body);
    const time = encounter.simulation.stats().time;
    encounter.step();
    expect(encounter.simulation.stats().time).toBe(time);
  });

  it("waits for an admitted old-owner coin before stocking the replacement lane", async () => {
    const first = wave("departing");
    const next = wave("replacement");
    const encounter = await createEncounter(
      { density: 0, seed: 211 },
      { openingMix: GOLD_ONLY_MIX, waves: [
        { ...first, enemies: first.enemies.map(enemy => ({ ...enemy, maxHp: 3 })) },
        { ...next, enemies: next.enemies.map(enemy => ({ ...enemy, bag: ["gold", "gold", "gold", "gold", "gold"] as const })) },
      ] },
    );
    encounters.push(encounter);
    for (let tick = 0; tick < 720; tick++) encounter.step();
    encounter.drop(0);
    const admitted = encounter.snapshot().lastAdmission!.coins.find(coin => coin.chuteId === "departing-chute-0")!;
    // Physical identity is retained across ownership changes, including while the outlet drains.
    const runtime = encounter.simulation as unknown as NativeFixture;
    const body = runtime.world.nativeBody(admitted.id);
    const { radius, thickness } = encounter.simulation.tuning;
    const sword = runtime.lifecycle.spawn({ x: 3, y: -0.7, z: 4.5 }, { x: 0, y: 0, z: 0, w: 1 }, radius, thickness, "sword");
    runtime.world.addCylinder(sword.id, sword);
    encounter.step();
    expect(encounter.snapshot()).toMatchObject({ phase: "active", waveIndex: 1 });
    const replacement = () => encounter.preview().find(tray => tray.id === "replacement-chute-0")!;
    expect(replacement().coins).toEqual([]);
    expect(replacement().gateOpen).toBe(true);
    for (let tick = 0; tick < 240 && replacement().coins.length < 5; tick++) encounter.step();
    expect(runtime.world.nativeBody(admitted.id)).toBe(body);
    expect(encounter.simulation.coins.get(admitted.id)?.type).toBe(admitted.type);
    expect(encounter.drop(0)).toBe(true);
    for (let tick = 0; tick < 240 && encounter.snapshot().acceptedRounds < 2; tick++) encounter.step();
    expect(encounter.snapshot().acceptedRounds).toBe(2);
    const fresh = encounter.snapshot().lastAdmission!.coins.find(coin => coin.chuteId === "replacement-chute-0")!;
    expect(fresh.type).toBe("gold");
    expect(runtime.world.nativeBody(fresh.id)?.isDynamic()).toBe(true);
  });
});
