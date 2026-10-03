import { describe, expect, it } from "vitest";
import type { CoinType } from "../src/contracts";
import type { CombatTotals, EncounterSnapshot } from "../src/combat/types";
import type { FightPolicy, FightProfile, FightRow, FightTrial } from "../scripts/combat-contracts";
import {
  compareFightRows,
  nearestRank,
  selectFightProfiles,
  summarizeFightRows,
  summarizeMetric,
  validateSelection,
} from "../scripts/combat-report";
import { SCREEN_SEEDS, assertDisjointSeeds, digest, registeredProfiles, trialId } from "../scripts/combat-protocol";
import { invalidateDigestGroups } from "../scripts/combat-experiments";

const TYPES: readonly CoinType[] = ["gold", "diamond", "sword", "skull", "potion", "bomb"];

function counts(value = 0): Record<CoinType, number> {
  return Object.fromEntries(TYPES.map((type) => [type, value])) as Record<CoinType, number>;
}

function trial(profile = registeredProfiles()[0]!, seed = 7, policy: FightPolicy = "center"): FightTrial {
  return { id: trialId(profile, "adaptive", seed, policy), profile, seed, policy, timing: "adaptive", actions: 60, maxJevRequests: 60 };
}

function row(input: {
  trial?: FightTrial;
  status?: "complete" | "invalid";
  result?: FightRow["result"];
  playerHp?: number;
  enemyHp?: number;
  currency?: number;
  terminalActions?: number | null;
  severeBurst?: boolean;
} = {}): FightRow {
  const currentTrial = input.trial ?? trial();
  const result = input.result === "budget-exhausted" ? null : input.result ?? "victory";
  const definition = currentTrial.profile.config.waves[0]!.enemies[0]!;
  const enemyHp = input.enemyHp ??
    (result === "victory" || result === "simultaneous-defeat" ? 0 : definition.maxHp);
  const totals: CombatTotals = {
    swordDamage: 0,
    skullDamage: 0,
    bombDamageToEnemy: 0,
    bombDamageToPlayer: 0,
    enemyHpRemoved: definition.maxHp - enemyHp,
    discardedDamage: 0,
    healingOffered: 0,
    healingUsed: 0,
    healingWasted: 0,
    currencyGained: input.currency ?? 0,
    safeBombs: 0,
    detonations: 0,
    blastAssociatedDetonations: 0,
  };
  const final: EncounterSnapshot = {
    phase: result === null ? "active" : "finished",
    result,
    playerHp: input.playerHp ?? 100,
    playerMaxHp: 100,
    enemies: [{
      id: definition.id,
      name: definition.name,
      hp: enemyHp,
      maxHp: definition.maxHp,
      chuteId: definition.chuteId,
      admittedRounds: 0,
      kind: definition.kind,
    }],
    frontEnemyId: enemyHp > 0 ? definition.id : null,
    waveIndex: 0,
    waveCount: 1,
    livingWaveHp: enemyHp,
    currency: input.currency ?? 0,
    acceptedActions: input.terminalActions ?? 12,
    acceptedRounds: input.terminalActions ?? 12,
    queuedRounds: 0,
    remainingRounds: 0,
    interruptedRounds: 0,
    completionSerial: result === null ? 0 : 1,
    tick: 720,
    chuteSlots: [],
    playerChutes: [{
      id: "player-0",
      bag: ["sword", "sword", "sword", "sword", "bomb"],
    }],
    chuteSettings: { chuteSpacing: 0.66, dropDelay: 0.3, dropsPerAction: 1 },
    feedStreams: [],
    config: currentTrial.profile.config,
    totals,
    lastAdmission: null,
    paused: false,
    error: null,
    loading: { ticks: 720, collectedByType: counts(), lostByType: counts(), detonated: 0 },
    recentEffects: [],
  };
  return {
    trial: currentTrial,
    status: input.status ?? "complete",
    result: input.status === "invalid" ? null : input.result ?? "victory",
    error: input.status === "invalid" ? "worker failed" : null,
    loading: null,
    initialDigest: null,
    simulationDigest: null,
    final: input.status === "invalid" ? null : final,
    finalFeed: input.status === "invalid" ? null : [],
    physicalFinal: null,
    metrics: input.status === "invalid" ? null : {
      acceptedActions: input.terminalActions ?? 12,
      attemptedActions: input.terminalActions ?? 12,
      decisionOpportunities: input.terminalActions ?? 12,
      elapsedTicks: 144,
      elapsedSeconds: 2.4,
      finalTick: 144,
      terminalActionCount: input.result === "budget-exhausted" ? null : input.terminalActions ?? 12,
      terminalSeconds: input.result === "budget-exhausted" ? null : 2.4,
      longestDry: 0,
      longestNoEnemyDamage: 0,
      largestRollingIncoming: 0,
      largestRollingIncomingFraction: 0,
      severeBurst: input.severeBurst ?? false,
      lostByType: counts(),
    },
    api: null,
    ledger: [],
    decisions: [],
    windows: [],
    wallSeconds: 0,
  };
}

function screenRows(): { planned: FightTrial[]; rows: FightRow[] } {
  const planned: FightTrial[] = [];
  const rows: FightRow[] = [];
  for (const profile of registeredProfiles())
    for (const seed of SCREEN_SEEDS)
      for (const policy of ["center", "random", "rule", "jev"] as const) {
        const current = trial(profile, seed, policy);
        planned.push(current);
        rows.push(row({ trial: current }));
      }
  return { planned, rows };
}

describe("combat report statistics", () => {
  it("uses null nearest-rank statistics for no measurements and retains zero measurements", () => {
    expect(nearestRank([], 0.5)).toBeNull();
    expect(summarizeMetric([], "max")).toEqual({ count: 0, median: null, p10: null, p90: null, worst: null });
    const current = trial();
    const summary = summarizeFightRows([row({ trial: current, playerHp: 0, currency: 0 })], [current])[0]!;
    expect(summary.metrics.playerHp).toMatchObject({ count: 1, median: 0, worst: 0 });
    expect(summary.metrics.currency).toMatchObject({ count: 1, median: 0, worst: 0 });
    const unfinished = row({ trial: current, result: "budget-exhausted", enemyHp: 37 });
    const unfinishedSummary = summarizeFightRows([unfinished], [current])[0]!;
    expect(unfinishedSummary.metrics.enemyHp).toMatchObject({ count: 1, median: 37, worst: 37 });
  });

  it("keeps missing rows in the manifest denominator and rejects duplicate evidence", () => {
    const first = trial(undefined, 7, "center");
    const second = trial(undefined, 42, "center");
    const completed = row({ trial: first });
    expect(summarizeFightRows([completed], [first, second])[0])
      .toMatchObject({ planned: 2, valid: 1, invalid: 0 });
    expect(() => summarizeFightRows([completed, completed], [first, second]))
      .toThrow(/duplicate result/i);
  });

  it("keeps invalid rows in planned denominators and censors budget-exhausted finishes", () => {
    const first = trial(undefined, 7, "center");
    const second = trial(undefined, 42, "center");
    const summary = summarizeFightRows([
      row({ trial: first, result: "budget-exhausted" }),
      row({ trial: second, status: "invalid" }),
    ], [first, second])[0]!;
    expect(summary).toMatchObject({ planned: 2, valid: 1, invalid: 1, invalidRate: 0.5 });
    expect(summary.outcomes["budget-exhausted"]).toEqual({ count: 1, denominator: 1, rate: 1 });
    expect(summary.finish).toMatchObject({ terminal: 0, censored: 1 });
    expect(summary.finish.actions.count).toBe(0);
  });

  it("reports only matched valid policy pairs and has deterministic bootstrap intervals", () => {
    const profile = registeredProfiles()[0]!;
    const planned = [
      trial(profile, 7, "center"), trial(profile, 7, "random"),
      trial(profile, 42, "center"), trial(profile, 42, "random"),
    ];
    const rows = [
      row({ trial: planned[0]!, playerHp: 10 }), row({ trial: planned[1]!, playerHp: 0 }),
      row({ trial: planned[2]!, status: "invalid" }), row({ trial: planned[3]!, playerHp: 10 }),
    ];
    const report = compareFightRows(rows, planned).find((item) => item.left === "center" && item.right === "random")!;
    expect(report).toMatchObject({ plannedPairs: 2, validPairs: 1, omittedPairs: 1 });
    expect(report.metrics.playerHp).toEqual({ difference: 10, lower95: 10, upper95: 10 });
    expect(compareFightRows(rows, planned)).toEqual(compareFightRows([...rows].reverse(), [...planned].reverse()));
  });

  it("rejects early terminal and severe-tail candidates without relaxing selection gates", () => {
    const { planned, rows } = screenRows();
    const early = registeredProfiles()[0]!;
    const tail = registeredProfiles()[1]!;
    for (const current of rows.filter((item) => item.trial.profile.name === early.name).slice(0, 5)) {
      current.metrics!.terminalActionCount = 4;
      current.metrics!.acceptedActions = 4;
    }
    for (const current of rows.filter((item) => item.trial.profile.name === tail.name).slice(0, 5)) {
      current.metrics!.severeBurst = true;
      current.metrics!.largestRollingIncomingFraction = 0.5;
    }
    const selection = selectFightProfiles(rows, planned, [...SCREEN_SEEDS], digest({ screen: true }));
    const earlyCandidate = selection.ranking.find((candidate) => candidate.profile.name === early.name)!;
    const tailCandidate = selection.ranking.find((candidate) => candidate.profile.name === tail.name)!;
    expect(earlyCandidate.eligible).toBe(false);
    expect(earlyCandidate.reasons).toContain("early terminal rate");
    expect(tailCandidate.eligible).toBe(false);
    expect(tailCandidate.reasons).toContain("severe burst tail");
  });

  it("preserves valid peers when a worker fails before producing an initial digest", () => {
    const valid = row();
    valid.initialDigest = digest({ pile: "shared" });
    const failed = row({ status: "invalid", trial: trial(valid.trial.profile, valid.trial.seed, "jev") });
    invalidateDigestGroups([valid, failed]);
    expect(valid.status).toBe("complete");
    expect(valid.result).toBe("victory");
    expect(failed.status).toBe("invalid");
    expect(failed.error).toBe("worker failed");
  });

  it("rejects a complete row missing its digest without contaminating its peer", () => {
    const missing = row();
    const valid = row({ trial: trial(missing.trial.profile, missing.trial.seed, "random") });
    valid.initialDigest = digest({ pile: "shared" });
    invalidateDigestGroups([missing, valid]);
    expect(missing.status).toBe("invalid");
    expect(missing.result).toBeNull();
    expect(missing.error).toMatch(/missing initial digest/i);
    expect(valid.status).toBe("complete");
  });

  it("invalidates a group when two actual digests disagree, including failed rows", () => {
    const valid = row();
    valid.initialDigest = digest({ pile: "first" });
    const failed = row({ status: "invalid", trial: trial(valid.trial.profile, valid.trial.seed, "jev") });
    failed.initialDigest = digest({ pile: "different" });
    invalidateDigestGroups([valid, failed]);
    expect(valid.status).toBe("invalid");
    expect(valid.result).toBeNull();
    expect(failed.error).toMatch(/worker failed; Initial digest mismatch/);
  });

  it.each([0.3, 0.499999, 0.5])("separates reporting bursts from selection tails at fraction %s", (fraction) => {
    const { planned, rows } = screenRows();
    const profile = registeredProfiles()[0]!;
    for (const current of rows.filter((item) => item.trial.profile.name === profile.name).slice(0, 5)) {
      current.metrics!.severeBurst = true;
      current.metrics!.largestRollingIncomingFraction = fraction;
    }
    const selection = selectFightProfiles(rows, planned, [...SCREEN_SEEDS], digest({ screen: fraction }));
    const candidate = selection.ranking.find((item) => item.profile.name === profile.name)!;
    expect(candidate.eligible).toBe(fraction < 0.5);
    expect(candidate.severeTailRate).toBe(fraction < 0.5 ? 0 : 5 / 48);
  });

  it.each([NaN, Infinity, -0.1])("rejects incomplete selection burst measurements: %s", (fraction) => {
    const { planned, rows } = screenRows();
    const first = rows[0]!;
    first.metrics!.largestRollingIncomingFraction = fraction;
    const selection = selectFightProfiles(rows, planned, [...SCREEN_SEEDS], digest({ screen: "invalid-fraction" }));
    const candidate = selection.ranking.find((item) => item.profile.name === first.trial.profile.name)!;
    expect(candidate.eligible).toBe(false);
    expect(candidate.reasons).toContain("incomplete valid measurements");
  });

  it("ranks a preferred Jev victory range before the preregistered profile tie order", () => {
    const { planned, rows } = screenRows();
    const preferred = registeredProfiles()[1]!;
    const jevRows = rows.filter((item) => item.trial.profile.name === preferred.name && item.trial.policy === "jev");
    for (const [index, current] of jevRows.entries()) current.result = index < 6 ? "victory" : "defeat";
    const selection = selectFightProfiles(rows, planned, [...SCREEN_SEEDS], digest({ screen: "rank" }));
    expect(selection.profiles[0]!.name).toBe(preferred.name);
  });

  it("validates frozen selection digests and preregistered, disjoint cohorts", () => {
    const { planned, rows } = screenRows();
    const selection = selectFightProfiles(rows, planned, [...SCREEN_SEEDS], digest({ screen: "valid" }));
    expect(() => validateSelection(selection)).not.toThrow();
    expect(() => assertDisjointSeeds(SCREEN_SEEDS, [SCREEN_SEEDS[0]!])).toThrow(/overlap/);
    const tampered = structuredClone(selection);
    tampered.digest = digest({ tampered: true });
    expect(() => validateSelection(tampered)).toThrow(/digest/);
    tampered.digest = selection.digest;
    tampered.screeningSeeds = [7];
    expect(() => validateSelection(tampered)).toThrow(/manifest/);
  });
});
