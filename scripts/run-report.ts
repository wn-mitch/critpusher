import { INTER_ENCOUNTER_HEAL } from "../src/run/catalog";
import type {
  BuildId,
  Distribution,
  EncounterMetrics,
  Gate,
  ReplayCheck,
  RunReportProjection,
  RunRow,
  RunRowIdentity,
  RunRowSummary,
  RunSelection,
  RunSummary,
  RunTrial,
} from "./run-contracts";
import {
  ADVERTISED_BUILDS,
  BUILD_PROFILES,
  canonicalJson,
  createManifest,
  digest,
  validateManifestRows,
} from "./run-protocol";

type Worst = "min" | "max";
type BuildMeasure = "admittedRoundEfficiency" | "hpRetention" | "earnings";

const OFFENSIVE_BUILDS: readonly BuildId[] = ["swarm", "volley", "tempo"];
const MEASURES: readonly BuildMeasure[] = ["admittedRoundEfficiency", "hpRetention", "earnings"];
const WORST_BY_METRIC: Readonly<Record<string, Worst>> = {
  terminalHp: "min",
  hpRetention: "min",
  earnedCurrency: "min",
  earnings: "min",
  spentCurrency: "max",
  grossIncoming: "max",
  coinHealingUsed: "min",
  recoveryUsed: "min",
  netAttrition: "max",
  admittedRounds: "max",
  admittedRoundEfficiency: "min",
  discardedDamage: "max",
  lostCoins: "max",
  lostGizmos: "max",
  mechanicalWaitTicks: "max",
  burstStallTicks: "max",
};

export function nearestRank(values: readonly number[], percentile: number): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const rank = Math.ceil(Math.max(0, Math.min(1, percentile)) * finite.length) - 1;
  return finite[Math.max(0, Math.min(finite.length - 1, rank))]!;
}

export function summarizeDistribution(values: readonly number[], worst: Worst): Distribution {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    count: finite.length,
    median: nearestRank(finite, 0.5),
    p10: nearestRank(finite, 0.1),
    p90: nearestRank(finite, 0.9),
    worst: finite.length ? (worst === "min" ? finite[0]! : finite.at(-1)!) : null,
  };
}

function rowMeasures(row: RunRowSummary): Record<BuildMeasure, number | null> {
  if (row.status === "invalid") return { admittedRoundEfficiency: null, hpRetention: null, earnings: null };
  const removed = row.encounters.reduce((total, encounter) => total + encounter.enemyHpRemoved, 0);
  const rounds = row.encounters.reduce((total, encounter) => total + encounter.admittedRounds, 0);
  return {
    admittedRoundEfficiency: rounds > 0 ? removed / rounds : null,
    hpRetention: row.final?.playerHp ?? null,
    earnings: row.final?.earnedCurrency ?? null,
  };
}

function rowMetric(row: RunRowSummary, metric: string): number | null {
  const measures = rowMeasures(row);
  if (metric in measures) return measures[metric as BuildMeasure];
  if (row.status === "invalid") return null;
  switch (metric) {
    case "terminalHp": return row.final?.playerHp ?? null;
    case "earnedCurrency": return row.final?.earnedCurrency ?? null;
    case "spentCurrency": return row.final?.spentCurrency ?? null;
    case "grossIncoming": return row.encounters.reduce((total, encounter) => total + encounter.grossIncoming, 0);
    case "coinHealingUsed": return row.encounters.reduce((total, encounter) => total + encounter.coinHealingUsed, 0);
    case "recoveryUsed": return row.encounters.reduce((total, encounter) => total + encounter.recoveryUsed, 0);
    case "netAttrition": return row.encounters.reduce((total, encounter) => total + encounter.netAttrition, 0);
    case "admittedRounds": return row.encounters.reduce((total, encounter) => total + encounter.admittedRounds, 0);
    case "discardedDamage": return row.encounters.reduce((total, encounter) => total + encounter.discardedDamage, 0);
    case "lostCoins": return row.encounters.reduce((total, encounter) =>
      total + Object.values(encounter.lostCoins).reduce((sum, count) => sum + count, 0), 0);
    case "lostGizmos": return row.encounters.reduce((total, encounter) => total + encounter.lostGizmos, 0);
    case "mechanicalWaitTicks": return row.encounters.reduce((total, encounter) => total + encounter.mechanicalWaitTicks, 0);
    case "burstStallTicks": return row.encounters.reduce((total, encounter) => total + encounter.burstStallTicks, 0);
    default: throw new Error(`Unknown run metric: ${metric}`);
  }
}

function statusCounts(rows: readonly RunRowSummary[]): Record<RunRowSummary["status"], number> {
  const counts: Record<RunRowSummary["status"], number> = { won: 0, lost: 0, unfinished: 0, invalid: 0 };
  for (const row of rows) counts[row.status]++;
  return counts;
}

function profileRows(rows: readonly RunRowSummary[], build: BuildId, policy?: string): RunRowSummary[] {
  return rows.filter((row) => row.trial.build === build && (policy === undefined || row.trial.policy === policy));
}

function matchedEncounterDeltas(
  rows: readonly RunRowSummary[],
  leftBuild: BuildId,
  rightBuild: BuildId,
  select: (encounter: EncounterMetrics) => number,
  /** Purchases land after the shop, so earlier encounters cannot measure them. */
  minimumEncounterIndex = 0,
): number[] {
  const right = new Map<string, RunRowSummary>();
  for (const row of profileRows(rows, rightBuild, "rule")) {
    if (row.status !== "invalid") right.set(String(row.trial.seed), row);
  }
  const deltas: number[] = [];
  for (const left of profileRows(rows, leftBuild, "rule")) {
    if (left.status === "invalid") continue;
    const counterpart = right.get(String(left.trial.seed));
    if (!counterpart) continue;
    const byEncounter = new Map(counterpart.encounters.map((encounter) => [encounter.encounterIndex, encounter]));
    for (const encounter of left.encounters) {
      if (encounter.encounterIndex < minimumEncounterIndex) continue;
      const other = byEncounter.get(encounter.encounterIndex);
      if (other) deltas.push(select(encounter) - select(other));
    }
  }
  return deltas;
}

function buildDistinctiveness(rows: readonly RunRowSummary[]): {
  profiles: Record<string, unknown>;
  universal: string[];
  profilesPassed: boolean;
  universalPassed: boolean;
} {
  const profiles: Record<string, {
    control: BuildId;
    comparisons: number;
    deltas: Record<BuildMeasure, Distribution>;
    strengths: BuildMeasure[];
    tradeoffs: BuildMeasure[];
  }> = {};
  const medians = new Map<BuildId, Record<BuildMeasure, number | null>>();

  for (const build of ADVERTISED_BUILDS) {
    const profile = BUILD_PROFILES.find((candidate) => candidate.id === build)!;
    const control = `no-purchases-${profile.starter}` as BuildId;
    const controlRows = new Map(profileRows(rows, control, "rule").map((row) => [row.trial.seed, row]));
    const deltaValues: Record<BuildMeasure, number[]> = {
      admittedRoundEfficiency: [], hpRetention: [], earnings: [],
    };
    let comparisons = 0;
    for (const row of profileRows(rows, build, "rule")) {
      const baseline = controlRows.get(row.trial.seed);
      if (!baseline || row.status === "invalid" || baseline.status === "invalid") continue;
      comparisons++;
      const actual = rowMeasures(row);
      const reference = rowMeasures(baseline);
      for (const measure of MEASURES) {
        const left = actual[measure];
        const right = reference[measure];
        if (left !== null && right !== null) deltaValues[measure].push(left - right);
      }
    }
    const deltas = Object.fromEntries(MEASURES.map((measure) =>
      [measure, summarizeDistribution(deltaValues[measure], "min")])) as Record<BuildMeasure, Distribution>;
    const strengths: BuildMeasure[] = [];
    const tradeoffs: BuildMeasure[] = [];
    profiles[build] = { control, comparisons, deltas, strengths, tradeoffs };

    const ownRows = profileRows(rows, build, "rule");
    medians.set(build, Object.fromEntries(MEASURES.map((measure) => [measure,
      summarizeDistribution(ownRows.flatMap((row) => {
        const value = rowMeasures(row)[measure];
        return value === null ? [] : [value];
      }), "min").median])) as Record<BuildMeasure, number | null>);
  }

  // Strength and tradeoff are measured between advertised builds: buying upgrades
  // must lead another advertised build somewhere and trail it somewhere, which is
  // what distinct viable builds mean. Control deltas stay reported as evidence.
  for (const build of ADVERTISED_BUILDS) {
    const own = medians.get(build)!;
    const others = ADVERTISED_BUILDS.filter((other) => other !== build).map((other) => medians.get(other)!);
    profiles[build]!.strengths = MEASURES.filter((measure) =>
      own[measure] !== null && others.some((other) => other[measure] !== null && own[measure]! > other[measure]!));
    profiles[build]!.tradeoffs = MEASURES.filter((measure) =>
      own[measure] !== null && others.some((other) => other[measure] !== null && own[measure]! < other[measure]!));
  }

  const universal = ADVERTISED_BUILDS.filter((build) => {
    const candidate = medians.get(build)!;
    if (MEASURES.some((measure) => candidate[measure] === null)) return false;
    let strictlyBetter = false;
    for (const otherBuild of ADVERTISED_BUILDS) {
      if (otherBuild === build) continue;
      const other = medians.get(otherBuild)!;
      if (MEASURES.some((measure) => other[measure] === null || candidate[measure]! < other[measure]!)) return false;
      if (MEASURES.some((measure) => candidate[measure]! > other[measure]!)) strictlyBetter = true;
    }
    return strictlyBetter;
  });
  const profileValues = Object.values(profiles);
  const completeComparisons = profileValues.length === ADVERTISED_BUILDS.length &&
    profileValues.every((profile) => profile.comparisons > 0);
  return {
    profiles,
    universal,
    profilesPassed: completeComparisons && profileValues.every((profile) =>
      profile.strengths.length > 0 && profile.tradeoffs.length > 0),
    universalPassed: completeComparisons && universal.length === 0,
  };
}

function gate(name: string, passed: boolean, evidence: unknown, adjustment: string): Gate {
  return { name, passed, evidence, adjustment: passed ? null : adjustment };
}

export function summarizeRunRows(rows: readonly RunRowSummary[], manifest: readonly RunTrial[]): RunSummary {
  validateManifestRows({ manifest: [...manifest], rows: [...rows] });
  const orderedRows = [...rows].sort((left, right) => left.trial.id.localeCompare(right.trial.id));
  const outcomes = statusCounts(orderedRows);
  const metricNames = Object.keys(WORST_BY_METRIC);
  const byBuild: RunSummary["byBuild"] = {};
  for (const profile of BUILD_PROFILES) {
    const planned = manifest.filter((trial) => trial.build === profile.id).length;
    const grouped = profileRows(orderedRows, profile.id);
    const statuses = statusCounts(grouped);
    byBuild[profile.id] = {
      planned,
      ...statuses,
      winRate: planned ? statuses.won / planned : 0,
      metrics: Object.fromEntries(metricNames.map((metric) => [metric,
        summarizeDistribution(grouped.flatMap((row) => {
          const value = rowMetric(row, metric);
          return value === null ? [] : [value];
        }), WORST_BY_METRIC[metric]!),
      ])),
    };
  }

  const advertisedRule = ADVERTISED_BUILDS.map((build) => {
    const planned = manifest.filter((trial) => trial.build === build && trial.policy === "rule").length;
    const won = profileRows(orderedRows, build, "rule").filter((row) => row.status === "won").length;
    return { build, planned, won, winRate: planned ? won / planned : 0 };
  });
  const viable = advertisedRule.filter((value) => value.planned > 0 && value.winRate >= 0.25);
  const unfinishedRate = manifest.length ? outcomes.unfinished / manifest.length : 1;
  const loadingVictories = orderedRows.flatMap((row) => row.encounters
    .filter((encounter) => encounter.loadingOutcome === "victory" && encounter.acquiredBuild)
    .map((encounter) => ({ trialId: row.trial.id, encounterIndex: encounter.encounterIndex })));
  const offensiveWins = OFFENSIVE_BUILDS.filter((build) => profileRows(orderedRows, build, "rule").some((row) => row.status === "won"));
  const recoveryWins = profileRows(orderedRows, "recovery", "rule").filter((row) => row.status === "won").length;

  const pressureByEncounter = [1, 2].map((encounterIndex) => {
    const values = orderedRows.flatMap((row) => row.trial.build.startsWith("no-purchases-") && row.trial.policy === "rule"
      ? row.encounters.filter((encounter) => encounter.encounterIndex === encounterIndex).map((encounter) => encounter.netAttrition)
      : []);
    return { encounterIndex, distribution: summarizeDistribution(values, "max") };
  });
  const pressurePassed = pressureByEncounter.some(({ distribution }) =>
    distribution.count > 0 && distribution.median !== null && distribution.median > INTER_ENCOUNTER_HEAL);

  const recoveryDeltas = matchedEncounterDeltas(orderedRows, "collector", "recovery",
    (encounter) => encounter.netAttrition, 1);
  const recoveryReduction = summarizeDistribution(recoveryDeltas, "min");
  const reachedShopEncounters = orderedRows.flatMap((row) => row.encounters)
    .filter((encounter) => encounter.legalPurchaseOpportunities + encounter.unaffordablePurchaseOpportunities > 0);
  const affordableShops = reachedShopEncounters.filter((encounter) => encounter.legalPurchaseOpportunities > 0).length;
  const affordabilityRate = reachedShopEncounters.length ? affordableShops / reachedShopEncounters.length : 0;
  const distinctiveness = buildDistinctiveness(orderedRows);

  const gates: Gate[] = [
    gate("zero-invalid-or-accounting-divergence", outcomes.invalid === 0,
      { invalid: outcomes.invalid, causes: orderedRows.filter((row) => row.status === "invalid").map((row) => ({ id: row.trial.id, phase: row.failurePhase, error: row.error })) },
      "Resolve invalid, loader, decision, mechanical, or accounting failures before balance tuning."),
    gate("three-viable-advertised-profiles", viable.length >= 3,
      { required: 3, profiles: advertisedRule },
      "(c) Reduce enemy HP in the failing encounter by 10% of initial values, rounding up, no lower than 60%."),
    gate("unfinished-rate-at-most-ten-percent", unfinishedRate <= 0.1,
      { unfinished: outcomes.unfinished, planned: manifest.length, rate: unfinishedRate },
      "(c) Reduce enemy HP in the failing encounter by 10% of initial values, rounding up, no lower than 60%."),
    gate("acquired-build-full-loading-victory", loadingVictories.length > 0,
      { victories: loadingVictories },
      "(c) Reduce enemy HP in the failing encounter by 10% of initial values, rounding up, no lower than 60%."),
    gate("offensive-and-recovery-runs-complete", offensiveWins.length > 0 && recoveryWins > 0,
      { offensiveWins, recoveryWins },
      "Apply (b) opening potion weight for early defeat/recovery, then (c) enemy HP for viability, within the registered bounds."),
    gate("later-no-purchase-attrition-exceeds-recovery", pressurePassed,
      { fixedRecovery: INTER_ENCOUNTER_HEAL, encounters: pressureByEncounter },
      "(e) Reduce fixed healing from 12 to 8, then opening potion weights by 2 in favor of skulls, no lower than potion 6."),
    gate("recovery-investment-reduces-matched-attrition",
      recoveryReduction.count > 0 && recoveryReduction.median !== null && recoveryReduction.median > 0,
      { definition: "collector net attrition minus recovery net attrition, matched rule seed and encounter", reduction: recoveryReduction },
      "Apply (b) opening potion weight for early recovery failure; retain honest evidence if the bounded adjustment cannot separate the profile."),
    gate("affordable-purchase-at-reached-shops", reachedShopEncounters.length > 0 && affordabilityRate >= 0.9,
      { reached: reachedShopEncounters.length, affordable: affordableShops, rate: affordabilityRate },
      "(a) Reduce affected prices by 2, respecting floors 6/12/20 for packs or upgrades/extra chute."),
    gate("every-build-has-strength-and-tradeoff", distinctiveness.profilesPassed, distinctiveness,
      "Use the registered adjustment order; if miniature alone fails use (d), otherwise retain evidence and request a balance decision."),
    gate("no-universally-superior-profile", distinctiveness.universalPassed, distinctiveness,
      "Retain the evidence and request a specific balance decision if bounded registered adjustments cannot preserve distinct builds."),
  ];
  return { planned: manifest.length, outcomes, byBuild, gates, accepted: gates.every((entry) => entry.passed) };
}

export function stableReportDigest(report: Pick<RunReportProjection,
  "version" | "protocolDigest" | "configuration" | "manifest" | "rowIdentities" | "summary">): string {
  return digest({
    version: report.version,
    protocolDigest: report.protocolDigest,
    configuration: report.configuration,
    manifest: report.manifest,
    rowIdentities: report.rowIdentities,
    summary: report.summary,
  });
}

export function freezeScreenSelection(report: RunReportProjection): RunSelection {
  if (report.phase !== "screen" || !report.summary.accepted ||
    canonicalJson(report.manifest) !== canonicalJson(createManifest("screen"))) {
    throw new Error("Selection requires a passed full screening cohort");
  }
  const payload = {
    version: report.version,
    protocolDigest: report.protocolDigest,
    screenReportDigest: stableReportDigest(report),
    screenManifest: report.manifest,
    gates: report.summary.gates,
    evaluationManifest: createManifest("evaluate"),
  };
  return { ...payload, digest: digest(payload) };
}

export function compareReplayRowIdentity(expected: RunRowIdentity, actual: RunRowIdentity): ReplayCheck {
  const matched = canonicalJson(expected.trial) === canonicalJson(actual.trial) && expected.digest === actual.digest;
  return {
    trialId: expected.trial.id,
    matched,
    expectedDigest: expected.digest,
    actualDigest: actual.digest,
    error: matched ? null : "Replay evidence differs from the recorded actual-engine row",
  };
}

export function toRunRowSummary(row: RunRow): RunRowSummary {
  return {
    trial: row.trial,
    status: row.status,
    error: row.error,
    failurePhase: row.failurePhase,
    encounters: row.encounters,
    final: row.final,
    finalDigest: row.finalDigest,
  };
}

export function runRowIdentity(row: RunRow): RunRowIdentity {
  return { trial: row.trial, digest: digest(row) };
}
