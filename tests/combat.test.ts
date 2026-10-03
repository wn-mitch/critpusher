import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENCOUNTER_CONFIG,
  emptyTotals,
  initialCombatState,
} from "../src/combat/config";
import { resolveCombatStep } from "../src/combat/reducer";
import type {
  CombatEffect,
  CombatState,
  EncounterConfig,
} from "../src/combat/types";
import { COIN_TYPES, type CoinEvent, type CoinType } from "../src/contracts";

const CONFIG: EncounterConfig = {
  ...DEFAULT_ENCOUNTER_CONFIG,
  playerMaxHp: 10,
  waves: [{
    id: "wave",
    enemies: [{ id: "guard", name: "Guard", maxHp: 10, chuteId: "guard-chute",
      bag: ["skull", "skull", "skull", "skull", "gold"], kind: "guard" }],
  }],
  swordDamage: 3,
  skullDamage: 2,
  potionHealing: 4,
};

function collected(id: number, type: CoinType): CoinEvent {
  return { id, type, kind: "collected", position: { x: id, y: 0, z: 0 } };
}

function lost(id: number, type: CoinType): CoinEvent {
  return {
    id,
    type,
    kind: "lost",
    reason: "out-of-bounds",
    position: { x: id, y: 0, z: 0 },
  };
}

function detonated(
  id: number,
  blastAssociated = false,
): CoinEvent {
  return {
    id,
    type: "bomb",
    kind: "detonated",
    chainRootId: blastAssociated ? 1 : id,
    blastAssociated,
    position: { x: id, y: 0, z: 0 },
  };
}

function combatState(
  patch: Partial<Pick<CombatState, "playerHp" | "currency" | "result">> & { enemyHps?: readonly number[] } = {},
): CombatState {
  const { enemyHps = [10], ...rest } = patch;
  const initial = initialCombatState(CONFIG);
  return {
    ...initial,
    ...rest,
    enemies: enemyHps.map((hp, index) => ({
      ...initial.enemies[0], id: `guard-${index}`, chuteId: `guard-chute-${index}`, hp,
    })),
  };
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [items.slice()];
  return items.flatMap((item, index) => {
    const rest = [...items.slice(0, index), ...items.slice(index + 1)];
    return permutations(rest).map((permutation) => [item, ...permutation]);
  });
}

function effectsById(effects: readonly CombatEffect[]): CombatEffect[] {
  return [...effects].sort((left, right) => left.id - right.id);
}

describe("fixed-step combat reducer", () => {
  it("applies the configured mixed catch batch with order-independent healing", () => {
    const events = [
      collected(1, "sword"),
      collected(2, "skull"),
      collected(3, "potion"),
      collected(4, "gold"),
      collected(5, "diamond"),
    ];

    const result = resolveCombatStep(combatState(), events, CONFIG);

    expect(result.state).toMatchObject({
      playerHp: 10,
      enemies: [{ hp: 7 }],
      currency: 11,
      result: null,
    });
    expect(result.delta).toEqual({
      ...emptyTotals(),
      swordDamage: 3,
      skullDamage: 2,
      enemyHpRemoved: 3,
      healingOffered: 4,
      healingUsed: 2,
      healingWasted: 2,
      currencyGained: 11,
    });
    expect(result.state.totals).toEqual(result.delta);
    expect(effectsById(result.effects)).toEqual([
      expect.objectContaining({ id: 1, enemyDamage: 3 }),
      expect.objectContaining({ id: 2, playerDamage: 2 }),
      expect.objectContaining({ id: 3, healingOffered: 4 }),
      expect.objectContaining({ id: 4, currency: 1 }),
      expect.objectContaining({ id: 5, currency: 10 }),
    ]);
  });

  it("produces identical arithmetic and per-event effects for every mixed-event permutation", () => {
    const events = [
      collected(1, "sword"),
      collected(2, "skull"),
      collected(3, "potion"),
      collected(4, "gold"),
      detonated(5, true),
    ];
    const initial = combatState({ playerHp: 8, enemyHps: [9], currency: 2 });
    const expected = resolveCombatStep(initial, events, CONFIG);
    const expectedEffects = effectsById(expected.effects);

    for (const permutation of permutations(events)) {
      const actual = resolveCombatStep(initial, permutation, CONFIG);
      expect(actual.state).toEqual(expected.state);
      expect(actual.delta).toEqual(expected.delta);
      expect(effectsById(actual.effects)).toEqual(expectedEffects);
    }
  });

  it("ignores every lost coin type and gives a safely caught bomb no damage", () => {
    const initial = combatState();
    const allLosses = COIN_TYPES.map((type, index) => lost(index + 1, type));
    const lossResult = resolveCombatStep(initial, allLosses, CONFIG);

    expect(lossResult.state).toEqual(initial);
    expect(lossResult.delta).toEqual(emptyTotals());
    expect(lossResult.effects).toEqual([]);

    const caughtBomb = resolveCombatStep(initial, [collected(20, "bomb")], CONFIG);
    expect(caughtBomb.state).toMatchObject({ playerHp: 10, enemies: [{ hp: 10 }] });
    expect(caughtBomb.delta).toEqual({ ...emptyTotals(), safeBombs: 1 });
    expect(caughtBomb.effects).toEqual([
      expect.objectContaining({
        id: 20,
        safeBomb: true,
        detonated: false,
        enemyDamage: 0,
        playerDamage: 0,
      }),
    ]);
  });

  it("applies exactly five bomb damage to each combatant and tracks blast association", () => {
    const result = resolveCombatStep(
      combatState(),
      [detonated(1, true)],
      CONFIG,
    );

    expect(result.state).toMatchObject({
      playerHp: 5,
      enemies: [{ hp: 5 }],
      result: null,
    });
    expect(result.delta).toEqual({
      ...emptyTotals(),
      bombDamageToEnemy: 5,
      bombDamageToPlayer: 5,
      enemyHpRemoved: 5,
      detonations: 1,
      blastAssociatedDetonations: 1,
    });
    expect(result.effects).toEqual([
      expect.objectContaining({
        id: 1,
        enemyDamage: 5,
        playerDamage: 5,
        detonated: true,
        blastAssociated: true,
      }),
    ]);
  });

  it("reports raw overkill separately from actual enemy HP removed", () => {
    const result = resolveCombatStep(
      combatState({ enemyHps: [2] }),
      [collected(1, "sword"), collected(2, "sword")],
      CONFIG,
    );

    expect(result.state.enemies.map(enemy => enemy.hp)).toEqual([0]);
    expect(result.state.result).toBe("victory");
    expect(result.delta.swordDamage).toBe(6);
    expect(result.delta.enemyHpRemoved).toBe(2);
    expect(result.delta.discardedDamage).toBe(4);
  });

  it("routes swords by physical ID through the living front enemies without mutating the input", () => {
    const initial = combatState({ enemyHps: [0, 2, 4] });
    const events = [collected(20, "sword"), collected(10, "sword")];
    const result = resolveCombatStep(initial, events, CONFIG);

    expect(result.state.enemies.map(enemy => enemy.hp)).toEqual([0, 0, 0]);
    expect(result.state.result).toBe("victory");
    expect(result.effects.map(effect => ({ id: effect.id, hits: effect.enemyHits }))).toEqual([
      { id: 10, hits: [{ enemyId: "guard-1", damage: 2 }, { enemyId: "guard-2", damage: 1 }] },
      { id: 20, hits: [{ enemyId: "guard-2", damage: 3 }] },
    ]);
    expect(result.delta).toMatchObject({ swordDamage: 6, enemyHpRemoved: 6, discardedDamage: 0 });
    expect(initial.enemies.map(enemy => enemy.hp)).toEqual([0, 2, 4]);
    expect(initial.totals).toEqual(emptyTotals());
    expect(events.map(event => event.id)).toEqual([20, 10]);
  });

  it("discards overkill at the wave boundary while resolving later healing and currency", () => {
    const config: EncounterConfig = {
      ...CONFIG, swordDamage: 9,
      waves: [...CONFIG.waves, {
        id: "next-wave",
        enemies: [{ ...CONFIG.waves[0].enemies[0], id: "reinforcement", chuteId: "reinforcement-chute" }],
      }],
    };
    const result = resolveCombatStep(
      combatState({ playerHp: 5, enemyHps: [2, 4] }),
      [collected(1, "sword"), collected(2, "potion"), collected(3, "diamond")],
      config,
    );
    expect(result.state).toMatchObject({
      enemies: [{ hp: 0 }, { hp: 0 }], playerHp: 9, currency: 10, result: "victory",
    });
    expect(result.effects[0]).toMatchObject({
      enemyDamage: 9, discardedDamage: 3,
      enemyHits: [{ enemyId: "guard-0", damage: 2 }, { enemyId: "guard-1", damage: 4 }],
    });
    expect(result.delta).toMatchObject({ swordDamage: 9, enemyHpRemoved: 6, discardedDamage: 3 });
    expect(result.state.totals.discardedDamage).toBe(3);
    expect(config.waves[1].enemies[0].maxHp).toBe(10);
  });

  it("decides defeat only after wave-clearing damage and all same-batch healing", () => {
    const events = [collected(1, "sword"), detonated(2), collected(3, "potion"), collected(4, "gold")];
    const survived = resolveCombatStep(combatState({ playerHp: 2, enemyHps: [2, 4] }), events, CONFIG);
    expect(survived.state).toMatchObject({ playerHp: 1, currency: 1, result: "victory" });
    const defeated = resolveCombatStep(combatState({ playerHp: 1, enemyHps: [2, 4] }), events, CONFIG);
    expect(defeated.state).toMatchObject({ playerHp: 0, currency: 1, result: "simultaneous-defeat" });
    expect(defeated.delta).toMatchObject({ healingOffered: 4, healingUsed: 4, healingWasted: 0 });
  });

  it("attributes potion offering per event but healing use and waste only to the batch", () => {
    const result = resolveCombatStep(
      combatState(),
      [collected(1, "potion"), collected(2, "skull"), collected(3, "potion")],
      CONFIG,
    );

    expect(result.state.playerHp).toBe(10);
    expect(result.delta).toMatchObject({
      skullDamage: 2,
      healingOffered: 8,
      healingUsed: 2,
      healingWasted: 6,
    });
    expect(result.effects).toEqual([
      expect.objectContaining({ id: 1, healingOffered: 4 }),
      expect.objectContaining({ id: 2, playerDamage: 2 }),
      expect.objectContaining({ id: 3, healingOffered: 4 }),
    ]);
  });

  it("counts healing that offsets same-step damage even when the player still falls", () => {
    const result = resolveCombatStep(
      combatState({ playerHp: 2 }),
      [
        collected(1, "skull"),
        collected(2, "skull"),
        collected(3, "skull"),
        collected(4, "potion"),
      ],
      CONFIG,
    );

    expect(result.state).toMatchObject({ playerHp: 0, result: "defeat" });
    expect(result.delta).toMatchObject({
      skullDamage: 6,
      healingOffered: 4,
      healingUsed: 4,
      healingWasted: 0,
    });
  });

  it("resolves victory, defeat, and simultaneous defeat after the complete batch", () => {
    const victory = resolveCombatStep(
      combatState({ enemyHps: [3] }),
      [collected(1, "sword")],
      CONFIG,
    );
    expect(victory.state.result).toBe("victory");

    const defeat = resolveCombatStep(
      combatState({ playerHp: 2 }),
      [collected(2, "skull")],
      CONFIG,
    );
    expect(defeat.state.result).toBe("defeat");

    const simultaneousEvents = [collected(3, "sword"), collected(4, "skull")];
    for (const events of [simultaneousEvents, [...simultaneousEvents].reverse()]) {
      const simultaneous = resolveCombatStep(
        combatState({ playerHp: 2, enemyHps: [3] }),
        events,
        CONFIG,
      );
      expect(simultaneous.state).toMatchObject({
        playerHp: 0,
        enemies: [{ hp: 0 }],
        result: "simultaneous-defeat",
      });
    }

    const bomb = resolveCombatStep(
      combatState({ playerHp: 2, enemyHps: [2] }),
      [detonated(5)],
      CONFIG,
    );
    expect(bomb.state).toMatchObject({
      playerHp: 0,
      enemies: [{ hp: 0 }],
      currency: 0,
      result: "simultaneous-defeat",
    });
  });

  it("rejects all late events after combat is finalized", () => {
    const finalized = resolveCombatStep(
      combatState({ enemyHps: [3] }),
      [collected(1, "sword")],
      CONFIG,
    ).state;

    const late = resolveCombatStep(
      finalized,
      [collected(2, "diamond"), collected(3, "potion"), detonated(4)],
      CONFIG,
    );

    expect(late.state).toBe(finalized);
    expect(late.delta).toEqual(emptyTotals());
    expect(late.effects).toEqual([]);
  });
});
