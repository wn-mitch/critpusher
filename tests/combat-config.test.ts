import { describe, expect, it } from "vitest";
import { DEFAULT_ENCOUNTER_CONFIG, encounterConfig, initialCombatState, normalizeMix, simulationConfig, validateEntry } from "../src/combat/config";
import type { CoinMix, BombConfig, EncounterEntry, EnemyDefinition, WaveDefinition } from "../src/combat/types";
import type { CoinType } from "../src/contracts";

function enemy(id: string, patch: Partial<EnemyDefinition> = {}): EnemyDefinition {
  return { id, name: "Guard", maxHp: 20, chuteId: `${id}-chute`,
    bag: ["skull", "skull", "skull", "skull", "gold"], kind: "guard", ...patch };
}
function entry(patch: Partial<EncounterEntry> = {}): EncounterEntry {
  return { playerHp: 8, currency: 12, playerChutes: [
    { id: "player-chute", bag: ["sword", "sword", "sword", "potion", "gold"] },
  ], ...patch };
}

describe("encounter configuration", () => {
  it("normalizes explicit zeros while rejecting missing, negative and nonfinite weights", () => {
    const mix: CoinMix = { gold: 1, diamond: 0, sword: 3, skull: 0, potion: 0, bomb: 0 };
    expect(normalizeMix(mix)).toEqual({ gold: 25, diamond: 0, sword: 75, skull: 0, potion: 0, bomb: 0 });
    for (const invalid of [{ ...mix, bomb: undefined }, { ...mix, sword: -1 }, { ...mix, potion: NaN }, { ...mix, gold: 0, sword: 0 }])
      expect(() => normalizeMix(invalid as CoinMix)).toThrow();
  });
  it("replaces complete nested records and rejects partial bomb records", () => {
    expect(() => simulationConfig(undefined, { bomb: { hitThreshold: 2 } as BombConfig })).toThrow();
    expect(() => simulationConfig(undefined, { bomb: null as unknown as BombConfig })).toThrow();
    expect(() => simulationConfig(undefined, { openingMix: null as unknown as CoinMix })).toThrow();
    const base = encounterConfig();
    const originalBomb = { ...base.bomb };
    const originalMix = { ...base.openingMix };
    const next = encounterConfig(base, { bomb: { ...base.bomb, hitThreshold: 2 } });
    next.bomb.blastRadius = 1;
    next.openingMix.gold = 0;
    expect(base.bomb).toEqual(originalBomb);
    expect(base.openingMix).toEqual(originalMix);
  });
  it("rejects invalid integer effects and bomb boundaries instead of silently substituting defaults", () => {
    for (const value of [0, -1, 1.5, Infinity, NaN])
      expect(() => encounterConfig(undefined, { swordDamage: value })).toThrow();
    for (const value of [0, 11, 2.5, NaN])
      expect(() => encounterConfig(undefined, { bomb: { ...DEFAULT_ENCOUNTER_CONFIG.bomb, hitThreshold: value } })).toThrow();
    for (const [key, value] of [["minClosingSpeed", 0], ["blastRadius", 5.1], ["blastDeltaSpeed", Infinity]] as const)
      expect(() => encounterConfig(undefined, { bomb: { ...DEFAULT_ENCOUNTER_CONFIG.bomb, [key]: value } })).toThrow();
  });
  it("rejects empty or oversized wave rosters and malformed enemy definitions", () => {
    const badWaves = [undefined, null, [], [{ id: "wave", enemies: [] }],
      [{ id: "wave", enemies: [enemy("a"), enemy("b"), enemy("c"), enemy("d")] }],
      [{ id: "wave", enemies: [null] }]];
    for (const waves of badWaves)
      expect(() => encounterConfig(undefined, { waves: waves as unknown as WaveDefinition[] })).toThrow();
    for (const maxHp of [0, -1, 1.5, Infinity, NaN])
      expect(() => encounterConfig(undefined, { waves: [{ id: "wave", enemies: [enemy("a", { maxHp })] }] })).toThrow();
  });
  it("rejects duplicate identities across waves, enemies, and chute ownership", () => {
    const badWaves: WaveDefinition[][] = [
      [{ id: "wave", enemies: [enemy("a")] }, { id: "wave", enemies: [enemy("b")] }],
      [{ id: "first", enemies: [enemy("a")] }, { id: "second", enemies: [enemy("a")] }],
      [{ id: "wave", enemies: [enemy("a"), enemy("b", { chuteId: "a-chute" })] }],
      [{ id: "wave", enemies: [enemy("wave")] }],
      [{ id: "wave", enemies: [enemy("a", { chuteId: "a" })] }],
      [{ id: "", enemies: [enemy("a")] }],
    ];
    for (const waves of badWaves)
      expect(() => encounterConfig(undefined, { waves })).toThrow();
  });
  it("rejects malformed bags for both enemy and player chutes", () => {
    const config = encounterConfig();
    for (const bag of [undefined, null, [], ["sword"], Array(5), Array(6).fill("gold"),
      ["sword", "sword", "sword", "sword", "unknown"]]) {
      const invalid = bag as unknown as CoinType[];
      expect(() => encounterConfig(undefined, { waves: [{ id: "wave", enemies: [enemy("a", { bag: invalid })] }] })).toThrow();
      expect(() => validateEntry(config, entry({ playerChutes: [{ id: "player-chute", bag: invalid }] }))).toThrow();
    }
  });
  it("clones wave definitions and starts independent combat states with carried resources", () => {
    const waves: WaveDefinition[] = [{ id: "wave", enemies: [enemy("a"), enemy("b")] }];
    const config = encounterConfig(undefined, { playerMaxHp: 10, waves });
    const first = initialCombatState(config, entry());
    const second = initialCombatState(config, entry());
    first.enemies[0].hp = 0;
    waves[0].enemies[0].maxHp = 1;
    (waves[0].enemies[0].bag as CoinType[])[0] = "bomb";
    expect(second.enemies.map(value => value.hp)).toEqual([20, 20]);
    expect(second).toMatchObject({ playerHp: 8, currency: 12, result: null });
    expect(config.waves[0].enemies[0]).toMatchObject({ maxHp: 20, bag: ["skull", "skull", "skull", "skull", "gold"] });
  });
  it("rejects invalid carried resources and player ownership before accepting an entry", () => {
    const config = encounterConfig(undefined, { playerMaxHp: 10, waves: [{ id: "wave", enemies: [enemy("a")] }] });
    for (const playerHp of [0, -1, 11, 1.5, Infinity, NaN])
      expect(() => validateEntry(config, entry({ playerHp }))).toThrow();
    for (const currency of [-1, 0.5, Infinity, NaN])
      expect(() => validateEntry(config, entry({ currency }))).toThrow();
    const chute = entry().playerChutes[0];
    for (const playerChutes of [[], [chute, chute], [chute, { ...chute, id: "p2" }, { ...chute, id: "p3" }, { ...chute, id: "p4" }],
      [{ ...chute, id: "" }], [{ ...chute, id: "a-chute" }], [{ ...chute, id: "a" }], [{ ...chute, id: "wave" }]])
      expect(() => validateEntry(config, entry({ playerChutes }))).toThrow();
  });
  it("clones accepted player bags so later caller mutation cannot change encounter inventory", () => {
    const original = entry();
    const validated = validateEntry(encounterConfig(), original);
    (original.playerChutes[0].bag as CoinType[])[0] = "bomb";
    original.playerChutes[0].id = "changed";
    expect(validated.playerChutes).toEqual([
      { id: "player-chute", bag: ["sword", "sword", "sword", "potion", "gold"] },
    ]);
  });
});
