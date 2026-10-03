import { describe, expect, it } from "vitest";
import { parseRunArgs } from "../scripts/run-experiments";
import { compareReplayRowIdentity, summarizeRunRows } from "../scripts/run-report";
import { actionRoundCost, canScheduleAction, invalidRunRow } from "../scripts/run-trial";
import { nativeActionPending, RunActionWindow } from "../scripts/run-window";
import {
  ACTION_LIMIT,
  BUILD_PROFILES,
  REQUIRED_SCREEN_GATES,
  RUN_VERSION,
  createManifest,
  digest,
  validateFrozenSelection,
  validateManifestRows,
} from "../scripts/run-protocol";
import type { BuildId, EncounterMetrics, Gate, RunRow, RunRowSummary, RunSelection, RunSummary, RunTrial } from "../scripts/run-contracts";

function fixtureEncounter(
  encounterIndex: number,
  overrides: Partial<EncounterMetrics> = {},
): EncounterMetrics {
  return {
    encounterIndex,
    loadingOutcome: encounterIndex === 0 ? "victory" : null,
    acquiredBuild: true,
    completedWaves: 2,
    terminalHp: 100,
    entryHp: 100,
    grossIncoming: 0,
    coinHealingUsed: 0,
    coinHealingWasted: 0,
    recoveryUsed: 0,
    recoveryWasted: 0,
    netAttrition: 0,
    moneyEarned: 0,
    moneySpent: 0,
    moneyCarried: 0,
    legalPurchaseOpportunities: 1,
    unaffordablePurchaseOpportunities: 0,
    bags: [],
    nativeBags: [],
    chuteCount: 1,
    stickers: [],
    swordDamage: 3,
    bombDamage: 5,
    comboDistribution: {},
    acceptedActions: 1,
    admittedRounds: 0,
    burstDurations: [],
    mechanicalWaitTicks: 0,
    burstStallTicks: 0,
    escalationTriggers: [],
    discardedDamage: 0,
    enemyHpRemoved: 0,
    lostCoins: { gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 },
    lostGizmos: 0,
    gizmoCurrency: 0,
    outcome: "victory",
    failurePhase: null,
    failureCause: null,
    ...overrides,
  };
}

type FixtureMeasures = {
  efficiency?: number;
  hp?: number;
  earnings?: number;
  attrition?: readonly [number, number];
  status?: RunRowSummary["status"];
  encounters?: EncounterMetrics[];
};

function fixtureRow(build: BuildId, seed: number, values: FixtureMeasures = {}): RunRowSummary {
  const hasFinal = values.hp !== undefined && values.earnings !== undefined;
  return {
    trial: { id: `${build}/${seed}/rule`, build, seed, policy: "rule", actions: ACTION_LIMIT },
    status: values.status ?? "won",
    error: values.status === "invalid" ? "fixture invalid" : null,
    failurePhase: values.status === "invalid" ? "fixture" : null,
    encounters: values.encounters ?? [
      fixtureEncounter(0, { netAttrition: values.attrition?.[0] ?? 0 }),
      fixtureEncounter(1, {
        netAttrition: values.attrition?.[1] ?? 0,
        admittedRounds: values.efficiency === undefined ? 0 : 1,
        enemyHpRemoved: values.efficiency ?? 0,
      }),
    ],
    final: hasFinal
      ? ({ playerHp: values.hp!, earnedCurrency: values.earnings! } as RunRowSummary["final"])
      : null,
    finalDigest: null,
  };
}

function gate(summary: RunSummary, name: string): Gate {
  const result = summary.gates.find((candidate) => candidate.name === name);
  if (!result) throw new Error(`Missing gate: ${name}`);
  return result;
}

function distinctivenessEvidence(summary: RunSummary): {
  profiles: Record<string, {
    comparisons: number;
    deltas: Record<string, { median: number | null }>;
    strengths: string[];
    tradeoffs: string[];
  }>;
  universal: string[];
} {
  return gate(summary, "every-build-has-strength-and-tradeoff").evidence as {
    profiles: Record<string, {
      comparisons: number;
      deltas: Record<string, { median: number | null }>;
      strengths: string[];
      tradeoffs: string[];
    }>;
    universal: string[];
  };
}

function oneTrial(build: RunTrial["build"] = "collector"): RunTrial {
  return createManifest("smoke", { seeds: [42], builds: [build], policies: ["rule"], actions: ACTION_LIMIT })[0]!;
}

describe("whole-run study protocol", () => {
  it("plans every preregistered row exactly once for screening and evaluation", () => {
    const screen = createManifest("screen");
    const evaluation = createManifest("evaluate");
    expect(screen).toHaveLength(216);
    expect(evaluation).toHaveLength(192);
    expect(new Set(screen.map((trial) => trial.id)).size).toBe(screen.length);
    expect(new Set(evaluation.map((trial) => trial.id)).size).toBe(evaluation.length);

    for (const profile of BUILD_PROFILES) {
      const screenRows = screen.filter((trial) => trial.build === profile.id);
      const evaluationRows = evaluation.filter((trial) => trial.build === profile.id);
      expect(screenRows).toHaveLength(profile.priorities.length ? 36 : 12);
      expect(evaluationRows).toHaveLength(24);
      if (!profile.priorities.length) expect(new Set(screenRows.map((trial) => trial.policy))).toEqual(new Set(["rule"]));
    }
  });

  it("rejects empty, missing, duplicate, and unplanned evidence rows", () => {
    const trial = oneTrial();
    const row = invalidRunRow(trial, "accounting divergence");
    expect(() => validateManifestRows({ manifest: [], rows: [] })).toThrow(/nonempty planned manifest/i);
    expect(() => validateManifestRows({ manifest: [trial], rows: [] })).toThrow(/Missing planned rows/);
    expect(() => validateManifestRows({ manifest: [trial], rows: [row, structuredClone(row)] })).toThrow(/Duplicate trial row/);
    expect(() => validateManifestRows({ manifest: [trial], rows: [invalidRunRow(oneTrial("swarm"), "other")] })).toThrow(/Unplanned trial row/);
  });

  it("keeps invalid accounting rows in denominators and fails empty comparisons", () => {
    const trial = oneTrial();
    const summary = summarizeRunRows([invalidRunRow(trial, "Purchase charge/ownership accounting diverged")], [trial]);
    expect(summary.planned).toBe(1);
    expect(summary.outcomes.invalid).toBe(1);
    expect(summary.accepted).toBe(false);
    expect(summary.gates.find((gate) => gate.name === "zero-invalid-or-accounting-divergence")?.passed).toBe(false);
    expect(summary.gates.find((gate) => gate.name === "recovery-investment-reduces-matched-attrition")?.evidence)
      .toMatchObject({ reduction: { count: 0, median: null } });
    expect([...summary.gates.map((gate) => gate.name)].sort()).toEqual([...REQUIRED_SCREEN_GATES].sort());
  });

  it("keeps favorable no-purchase deltas as evidence while requiring advertised-build tradeoffs", () => {
    const rows = [
      fixtureRow("collector", 7, { efficiency: 5, hp: 90, earnings: 50, attrition: [10, 30] }),
      fixtureRow("swarm", 7, { efficiency: 4, hp: 95, earnings: 55, attrition: [10, 25] }),
      fixtureRow("volley", 7, { efficiency: 6, hp: 85, earnings: 45, attrition: [10, 27] }),
      fixtureRow("tempo", 7, { efficiency: 3, hp: 100, earnings: 60, attrition: [10, 22] }),
      fixtureRow("recovery", 7, { efficiency: 7, hp: 80, earnings: 40, attrition: [10, 20] }),
      fixtureRow("no-purchases-collector", 7, { efficiency: 1, hp: 10, earnings: 1, attrition: [10, 20] }),
      fixtureRow("no-purchases-swarm", 7, { efficiency: 1, hp: 10, earnings: 1, attrition: [10, 20] }),
      fixtureRow("no-purchases-volley", 7, { efficiency: 1, hp: 10, earnings: 1, attrition: [10, 20] }),
    ];
    const summary = summarizeRunRows(rows, rows.map((row) => row.trial));
    const evidence = distinctivenessEvidence(summary);

    for (const build of ["collector", "swarm", "volley", "tempo", "recovery"] as const) {
      const profile = evidence.profiles[build]!;
      expect(profile.comparisons).toBe(1);
      expect(Object.values(profile.deltas).every((distribution) => distribution.median! > 0)).toBe(true);
      expect(profile.strengths.length).toBeGreaterThan(0);
      expect(profile.tradeoffs.length).toBeGreaterThan(0);
    }
    expect(gate(summary, "every-build-has-strength-and-tradeoff").passed).toBe(true);
    expect(gate(summary, "no-universally-superior-profile").passed).toBe(true);
  });

  it("rejects undefined and equal advertised measures as non-distinct", () => {
    const advertised = ["collector", "swarm", "volley", "tempo", "recovery"] as const;
    const controls = ["no-purchases-collector", "no-purchases-swarm", "no-purchases-volley"] as const;
    const undefinedRows = [
      ...advertised.map((build) => fixtureRow(build, 7)),
      ...controls.map((build) => fixtureRow(build, 7)),
    ];
    const equalRows = [
      ...advertised.map((build) => fixtureRow(build, 7, { efficiency: 3, hp: 50, earnings: 10 })),
      ...controls.map((build) => fixtureRow(build, 7, { efficiency: 1, hp: 10, earnings: 1 })),
    ];

    for (const rows of [undefinedRows, equalRows]) {
      const summary = summarizeRunRows(rows, rows.map((row) => row.trial));
      const evidence = distinctivenessEvidence(summary);
      expect(gate(summary, "every-build-has-strength-and-tradeoff").passed).toBe(false);
      for (const build of advertised) {
        expect(evidence.profiles[build]!.comparisons).toBe(1);
        expect(evidence.profiles[build]!.strengths).toEqual([]);
        expect(evidence.profiles[build]!.tradeoffs).toEqual([]);
      }
    }
  });

  it("rejects a paid advertised profile that dominates every other advertised median", () => {
    const advertised = ["collector", "swarm", "volley", "tempo", "recovery"] as const;
    const controls = ["no-purchases-collector", "no-purchases-swarm", "no-purchases-volley"] as const;
    const rows = [
      ...advertised.map((build) => fixtureRow(build, 7, build === "collector"
        ? { efficiency: 10, hp: 100, earnings: 100 }
        : { efficiency: 2, hp: 20, earnings: 20 })),
      ...controls.map((build) => fixtureRow(build, 7, { efficiency: 1, hp: 10, earnings: 1 })),
    ];
    const summary = summarizeRunRows(rows, rows.map((row) => row.trial));

    expect(distinctivenessEvidence(summary).universal).toEqual(["collector"]);
    expect(gate(summary, "no-universally-superior-profile").passed).toBe(false);
  });

  it("measures recovery only after the first shop and only across valid matched encounters", () => {
    const rows = [
      fixtureRow("collector", 7, { efficiency: 1, hp: 80, earnings: 20, attrition: [10, 30] }),
      fixtureRow("recovery", 7, { efficiency: 1, hp: 80, earnings: 20, attrition: [10, 10] }),
      fixtureRow("collector", 42, { efficiency: 1, hp: 80, earnings: 20, attrition: [10, 40] }),
      fixtureRow("recovery", 42, { status: "invalid", attrition: [10, 5] }),
      fixtureRow("collector", 1337, { efficiency: 1, hp: 80, earnings: 20, attrition: [10, 40] }),
      fixtureRow("recovery", 1337, {
        efficiency: 1,
        hp: 80,
        earnings: 20,
        encounters: [fixtureEncounter(0, { netAttrition: 10 })],
      }),
    ];
    const summary = summarizeRunRows(rows, rows.map((row) => row.trial));
    const evidence = gate(summary, "recovery-investment-reduces-matched-attrition").evidence as {
      reduction: { count: number; median: number | null; worst: number | null };
    };

    expect(summary.planned).toBe(6);
    expect(summary.outcomes).toMatchObject({ won: 5, invalid: 1 });
    expect(evidence.reduction).toMatchObject({ count: 1, median: 20, worst: 20 });
    expect(gate(summary, "recovery-investment-reduces-matched-attrition").passed).toBe(true);
  });

  it("compares full raw row identity rather than only terminal state", () => {
    const expected = invalidRunRow(oneTrial(), "mechanical stall");
    const expectedDigest = digest(expected);
    const identity = (row: RunRow) => ({ trial: row.trial, digest: digest(row) });
    expect(compareReplayRowIdentity(identity(expected), identity(structuredClone(expected))))
      .toMatchObject({ matched: true, error: null });

    const changed = structuredClone(expected) as RunRow;
    changed.trace.push({ kind: "entry", encounterIndex: 0, state: { hiddenDifference: true } });
    const mismatch = compareReplayRowIdentity({ trial: expected.trial, digest: expectedDigest }, identity(changed));
    expect(mismatch.matched).toBe(false);
    expect(mismatch.expectedDigest).not.toBe(mismatch.actualDigest);
  });

  it("refuses a frozen selection whose gate set is missing, unrecognized, or unpassed", () => {
    const selection = (gates: Gate[]): RunSelection => {
      const payload = {
        version: RUN_VERSION,
        protocolDigest: "protocol",
        screenReportDigest: "screen-report",
        screenManifest: createManifest("screen"),
        gates,
        evaluationManifest: createManifest("evaluate"),
      };
      return { ...payload, digest: digest(payload) };
    };
    const full = (): Gate[] => REQUIRED_SCREEN_GATES.map((name) => ({ name, passed: true, evidence: {}, adjustment: null }));
    expect(() => validateFrozenSelection(selection(full()), "protocol")).not.toThrow();
    expect(() => validateFrozenSelection(selection(full()), "changed-protocol"))
      .toThrow(/protocol\/config mismatch/);

    const incomplete = full().slice(1);
    expect(() => validateFrozenSelection(selection(incomplete), "protocol"))
      .toThrow(/complete passed screening gate set/);
    const forged = [...full().slice(1), { name: "not-a-preregistered-gate", passed: true, evidence: {}, adjustment: null }];
    expect(() => validateFrozenSelection(selection(forged), "protocol"))
      .toThrow(/complete passed screening gate set/);
    const failed = full().map((gate, index) => index === 0 ? { ...gate, passed: false } : gate);
    expect(() => validateFrozenSelection(selection(failed), "protocol"))
      .toThrow(/complete passed screening gate set/);
  });

  it("enforces the admitted-round ceiling before scheduling an indivisible cohort", () => {
    expect(actionRoundCost("ordinary")).toBe(1);
    expect(actionRoundCost("dump")).toBe(5);
    expect(canScheduleAction(299, "ordinary")).toBe(true);
    expect(canScheduleAction(300, "ordinary")).toBe(false);
    expect(canScheduleAction(295, "dump")).toBe(true);
    expect(canScheduleAction(296, "dump")).toBe(false);
    expect(canScheduleAction(301, "ordinary")).toBe(false);
  });

  it("does not close a window while an admitted dump cohort is still moving", () => {
    const window = new RunActionWindow();
    expect(window.advance(1, true, false)).toBe("continue");
    for (let tick = 1; tick < 144; tick++) expect(window.advance(0, true, false)).toBe("continue");
    expect(window.advance(0, false, false)).toBe("complete");
    expect(window.firstAdmission).toBe(1);
    expect(window.lastAdmission).toBe(1);
    expect(window.stallTicks).toBeGreaterThan(0);
  });

  it("keeps the action boundary closed until enabled native hardware is ready", () => {
    const tray = (phase: "idle" | "emitting" | "rearming", coins = 5, enabled = true) => ({
      enabled,
      coins: { length: coins },
      burst: { phase },
    });
    expect(nativeActionPending({ remainingRounds: 0 }, [tray("rearming")])).toBe(true);
    expect(nativeActionPending({ remainingRounds: 0 }, [tray("emitting")])).toBe(true);
    expect(nativeActionPending({ remainingRounds: 1 }, [tray("idle")])).toBe(true);
    expect(nativeActionPending({ remainingRounds: 0 }, [tray("idle", 0)])).toBe(true);
    expect(nativeActionPending({ remainingRounds: 0 }, [tray("idle", 0, false)])).toBe(false);
    expect(nativeActionPending({ remainingRounds: 0 }, [tray("idle")])).toBe(false);

    const interrupted = new RunActionWindow();
    expect(interrupted.advance(1, true, false)).toBe("continue");
    expect(interrupted.advance(0, true, true)).toBe("complete");
  });

  it("accepts study overrides only where the protocol permits them", () => {
    expect(parseRunArgs(["--phase", "smoke", "--seeds", "7", "--builds", "collector", "--policies", "rule", "--actions", "12"]))
      .toMatchObject({ phase: "smoke", seeds: [7], builds: ["collector"], policies: ["rule"], actions: 12 });
    expect(() => parseRunArgs(["--phase", "screen", "--seeds", "7", "--output", "/tmp/run-screen.json"]))
      .toThrow(/only valid for smoke/);
    expect(() => parseRunArgs(["--phase", "replay", "--replay", "/tmp/run.json", "--actions", "12"]))
      .toThrow(/come only from the recorded report/);
  });
});
