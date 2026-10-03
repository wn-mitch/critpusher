import { describe, expect, it } from "vitest";
import { createEncounter } from "../src/combat/encounter";
import { DEFAULT_ENCOUNTER_CONFIG, encounterConfig } from "../src/combat/config";
import type { Encounter, EncounterConfig } from "../src/combat/types";
import type { Tuning } from "../src/contracts";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";
import type { CombatSolverPolicy } from "../src/experiments/solver-contracts";
import { runCombatTrial, replayCombatTrial } from "../scripts/combat-trial";
import type { FightProfile, FightTrial } from "../scripts/combat-contracts";

function profile(config: Partial<EncounterConfig> = {}): FightProfile {
  return {
    name: "balanced-standard",
    mixture: "balanced",
    bombPreset: "standard",
    config: encounterConfig(DEFAULT_ENCOUNTER_CONFIG, config),
  };
}

function oneEnemy(maxHp: number): EncounterConfig["waves"] {
  return [{
    id: "study-wave",
    enemies: [{
      id: "study-guard",
      name: "Guard",
      maxHp,
      chuteId: "study-guard-chute",
      bag: ["skull", "skull", "skull", "skull", "gold"],
      kind: "guard",
    }],
  }];
}

function trial(config: Partial<EncounterConfig> = {}, actions = 1): FightTrial {
  return {
    id: `trial-${actions}`,
    profile: profile(config),
    policy: "center",
    timing: "adaptive",
    seed: 42,
    actions,
    maxJevRequests: 0,
  };
}

function emptyPileFactory(patch: Partial<Tuning> = {}) {
  return (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) =>
    createEncounter({ ...tuning, density: 0, ...patch }, config);
}

type EncounterInternals = {
  world: RapierWorld;
  lifecycle: CoinLifecycle;
};

function addPhysicalCoin(encounter: Encounter, type: "skull" | "sword", position: { x: number; y: number; z: number }): number {
  const runtime = encounter.simulation as unknown as EncounterInternals;
  const coin = runtime.lifecycle.spawn(
    position,
    { x: 0, y: 0, z: 0, w: 1 },
    encounter.simulation.tuning.radius,
    encounter.simulation.tuning.thickness,
    type,
  );
  if (!runtime.world.addCylinder(coin.id, coin)) throw new Error("Test fixture coin was not physically admitted");
  return coin.id;
}

describe("combat trial execution", () => {
  it("retains an opening victory and its routed hit and excess evidence", async () => {
    let encounter: Encounter | undefined;
    const factory = async (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) => {
      encounter = await emptyPileFactory()(tuning, config);
      addPhysicalCoin(encounter, "sword", { x: 0, y: -0.7, z: 4.5 });
      return encounter;
    };

    const row = await runCombatTrial(trial({ waves: oneEnemy(1) }), {
      encounterFactory: factory,
    });

    expect(row.status).toBe("complete");
    expect(row.result).toBe("victory");
    expect(row.decisions).toHaveLength(0);
    expect(row.metrics).toMatchObject({
      acceptedActions: 0,
      attemptedActions: 0,
      terminalActionCount: 0,
      elapsedTicks: 1,
    });
    const openingEffect = row.ledger
      .find((entry) => entry.stage === "loading")?.combat.effects[0];
    expect(openingEffect).toMatchObject({
      enemyDamage: 3,
      enemyHits: [{ enemyId: "study-guard", damage: 1 }],
      discardedDamage: 2,
    });
    expect(row.final?.totals).toMatchObject({ enemyHpRemoved: 1, discardedDamage: 2 });
  });

  it("retains an opening defeat without asking a policy for an action", async () => {
    let encounter: Encounter | undefined;
    const factory = async (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) => {
      encounter = await emptyPileFactory()(tuning, config);
      addPhysicalCoin(encounter, "skull", { x: 0, y: -0.7, z: 4.5 });
      return encounter;
    };

    const row = await runCombatTrial(trial({ playerMaxHp: 1 }), {
      encounterFactory: factory,
    });

    expect(row.status).toBe("complete");
    expect(row.result).toBe("defeat");
    expect(row.decisions).toHaveLength(0);
    expect(row.final).toMatchObject({ phase: "finished", playerHp: 0, acceptedActions: 0 });
    expect(row.ledger.some((entry) =>
      entry.stage === "loading" && entry.combat.delta.skullDamage === 2)).toBe(true);
  });
  it("lets waiting physics defeat the player without inventing an admission", async () => {
    let encounter: Encounter | undefined;
    const factory = async (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) => {
      encounter = await emptyPileFactory()(tuning, config);
      return encounter;
    };
    const waitingPolicy: CombatSolverPolicy = () => {
      addPhysicalCoin(encounter!, "skull", { x: 0, y: -0.7, z: 4.5 });
      return { action: { lane: 2, waitQuarters: 1 } };
    };

    const row = await runCombatTrial(trial({ playerMaxHp: 1 }), {
      encounterFactory: factory,
      policy: waitingPolicy,
    });

    expect(row.status).toBe("complete");
    expect(row.result).toBe("defeat");
    expect(row.metrics).toMatchObject({ attemptedActions: 0, acceptedActions: 0, terminalActionCount: 0 });
    expect(row.decisions[0]).toMatchObject({ waitTicks: 36, waitAdvancedTicks: 1, admissions: [] });
    expect(row.ledger.some((entry) => entry.stage === "wait" && entry.events.some((event) => event.type === "skull"))).toBe(true);
  });

  it("keeps waiting catches out of release windows but in encounter totals", async () => {
    let encounter: Encounter | undefined;
    const factory = async (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) => {
      encounter = await emptyPileFactory()(tuning, config);
      return encounter;
    };
    const policy: CombatSolverPolicy = () => {
      addPhysicalCoin(encounter!, "sword", { x: 0, y: -0.7, z: 4.5 });
      return { action: { lane: 2, waitQuarters: 1 } };
    };
    const row = await runCombatTrial(trial(), { encounterFactory: factory, policy });
    expect(row.status).toBe("complete");
    expect(row.windows[0]).toMatchObject({
      catches: 0, enemyDamage: 0, dry: true, noEnemyDamage: true,
    });
    expect(row.metrics).toMatchObject({ longestDry: 1, longestNoEnemyDamage: 1 });
    expect(row.final?.totals.swordDamage).toBe(3);
    expect(row.final?.enemies[0]?.hp).toBe(117);
    expect(row.ledger.find((entry) => entry.combat.delta.swordDamage === 3)?.stage)
      .toBe("wait");
  });

  it("excludes mechanical waiting payouts and retains a full post-admission window", async () => {
    let encounter: Encounter | undefined;
    let waitingCatchId = 0;
    const factory = async (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) => {
      encounter = await emptyPileFactory()(tuning, config);
      return encounter;
    };
    const policy: CombatSolverPolicy = ({ observation }) => {
      const aimedPlayer = observation.candidates[2]!.chutes.find(({ source }) => source === "player")!;
      addPhysicalCoin(encounter!, "sword", { x: aimedPlayer.x, y: 3, z: -3.15 });
      waitingCatchId = addPhysicalCoin(encounter!, "sword", { x: 0, y: -0.7, z: 4.5 });
      return { action: { lane: 2, waitQuarters: 0 } };
    };
    const row = await runCombatTrial(trial(), { encounterFactory: factory, policy });
    expect(row.status).toBe("complete");
    expect(row.decisions[0]!.mechanicalWaitAdvancedTicks).toBeGreaterThan(0);
    expect(row.decisions[0]!.windowAdvancedTicks).toBe(144);
    expect(row.ledger.find((entry) => entry.events.some((event) => event.id === waitingCatchId))?.stage).toBe("wait");
    expect(row.windows[0]!.endTick - row.windows[0]!.admittedAtTick).toBe(144);
    expect(row.decisions[0]?.admissions[0]?.coins.every(({ chuteId, id }) =>
      chuteId.length > 0 && Number.isSafeInteger(id))).toBe(true);
    expect(row.loading?.nativeFeedIds.length).toBeGreaterThan(0);
  });

  it("retains a refused real admission without consuming or retrying the feed", async () => {
    const row = await runCombatTrial(trial(), {
      encounterFactory: emptyPileFactory({ dropRate: 0 }),
    });

    expect(row.status).toBe("invalid");
    expect(row.metrics).toMatchObject({ attemptedActions: 1, acceptedActions: 0 });
    expect(row.decisions).toHaveLength(1);
    expect(row.final).toMatchObject({ acceptedActions: 0, acceptedRounds: 0 });
  });

  it("keeps an accounted out-of-bounds loss valid and effect-free", async () => {
    let encounter: Encounter | undefined;
    const factory = async (tuning?: Partial<Tuning>, config?: Partial<EncounterConfig>) => {
      encounter = await emptyPileFactory()(tuning, config);
      return encounter;
    };
    let lostId: number | undefined;
    const lossPolicy: CombatSolverPolicy = () => {
      lostId = addPhysicalCoin(encounter!, "skull", { x: 10, y: 1, z: 0 });
      return { action: { lane: 2, waitQuarters: 0 } };
    };

    const row = await runCombatTrial(trial(), { encounterFactory: factory, policy: lossPolicy });

    expect(row.status).toBe("complete");
    expect(row.result).toBe("budget-exhausted");
    expect(row.metrics?.lostByType.skull).toBeGreaterThanOrEqual(1);
    const loss = row.ledger.flatMap((entry) => entry.events).find((event) => event.id === lostId);
    expect(loss).toMatchObject({ type: "skull", kind: "lost", reason: "out-of-bounds" });
    expect(row.ledger.flatMap((entry) => entry.combat.effects).some((effect) => effect.id === loss?.id)).toBe(false);
  });

  it("reports a valid censored budget exhaustion after the final observation tail", async () => {
    const row = await runCombatTrial(trial({}, 1), {
      encounterFactory: emptyPileFactory(),
    });

    expect(row.status).toBe("complete");
    expect(row.result).toBe("budget-exhausted");
    expect(row.metrics).toMatchObject({ attemptedActions: 1, acceptedActions: 1, terminalActionCount: null, terminalSeconds: null });
    expect(row.decisions[0]?.windowAdvancedTicks).toBe(144);
    expect(row.metrics?.elapsedTicks).toBe((row.loading?.ticks ?? 0) + 288);
    expect(row.windows).toHaveLength(1);
    expect(row.loading?.plannedStarting).toEqual({ gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 });
    expect(row.loading?.admittedStarting).toEqual(row.loading?.plannedStarting);
  });
});

describe("combat trace replay", () => {
  it("replays the real recorded ledger exactly and rejects digest tampering", async () => {
    const source = await runCombatTrial(trial({}, 1));
    expect(source.status).toBe("complete");

    const replay = await replayCombatTrial(source);
    expect(replay.check).toMatchObject({
      matched: true,
      initialDigestMatch: true,
      ledgerMatch: true,
      simulationDigestMatch: true,
      outcomeMatch: true,
      error: null,
    });

    const tampered = structuredClone(source);
    tampered.initialDigest = "tampered";
    const mismatch = await replayCombatTrial(tampered);
    expect(mismatch.check.matched).toBe(false);
    expect(mismatch.check.initialDigestMatch).toBe(false);
    expect(mismatch.check.error).toContain("initial digest");
  }, 60_000);
});
