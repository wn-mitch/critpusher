import type { CoinType } from "../src/contracts";
import { randomFactory } from "../src/random";
import {
  FIGHT_POLICIES,
  type ComparisonMetric,
  type DifferenceInterval,
  type FightComparison,
  type FightMetric,
  type FightOutcome,
  type FightPolicy,
  type FightProfile,
  type FightRow,
  type FightSummary,
  type FightTiming,
  type FightTrial,
  type FrozenSelection,
  type MetricSummary,
  type SelectionCandidate,
} from "./combat-contracts";
import {
  SCREEN_SEEDS,
  SELECTION_GATES,
  canonicalJson,
  digest,
  protocolDigest,
  registeredProfiles,
  validateFightTrial,
  validateRegisteredProfile,
  validateSeeds,
} from "./combat-protocol";

const COIN_TYPES: readonly CoinType[] = ["gold", "diamond", "sword", "skull", "potion", "bomb"];
const OUTCOMES: readonly FightOutcome[] = ["victory", "defeat", "simultaneous-defeat", "budget-exhausted"];
const TIMINGS: readonly FightTiming[] = ["adaptive", "fixed"];
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 0x05a17e11;

type Worst = "min" | "max";

const METRIC_WORST: Readonly<Record<FightMetric, Worst>> = {
  playerHp: "min",
  enemyHp: "max",
  currency: "min",
  swordDamage: "min",
  bombDamageToEnemy: "min",
  enemyHpRemoved: "min",
  discardedDamage: "max",
  skullDamage: "max",
  bombDamageToPlayer: "max",
  healingOffered: "min",
  healingUsed: "min",
  healingWasted: "max",
  detonations: "max",
  safeBombs: "min",
  blastAssociatedDetonations: "max",
  lostCoins: "max",
  acceptedActions: "max",
  elapsedSeconds: "max",
  longestDry: "max",
  longestNoEnemyDamage: "max",
  largestRollingIncoming: "max",
  largestRollingIncomingFraction: "max",
};

const PROFILE_ORDER: Readonly<Record<string, number>> = Object.fromEntries(
  registeredProfiles().map((profile, index) => [profile.name, index]),
);
const POLICY_ORDER: Readonly<Record<FightPolicy, number>> = {
  center: 0,
  random: 1,
  rule: 2,
  jev: 3,
};
const TIMING_ORDER: Readonly<Record<FightTiming, number>> = {
  adaptive: 0,
  fixed: 1,
};

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rate(count: number, denominator: number): number | null {
  return denominator === 0 ? null : count / denominator;
}

function compareNumber(left: number | null, right: number | null, direction: "asc" | "desc"): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function trialKey(trial: Pick<FightTrial, "profile" | "timing" | "seed" | "policy">): string {
  return `${trial.profile.name}\u0000${trial.timing}\u0000${trial.seed}\u0000${trial.policy}`;
}


function sortedTrials(planned: readonly FightTrial[]): FightTrial[] {
  const seen = new Set<string>();
  for (const trial of planned) {
    validateFightTrial(trial);
    const key = trialKey(trial);
    if (seen.has(key)) throw new Error(`Duplicate planned fight trial: ${trial.id}`);
    seen.add(key);
  }
  return [...planned].sort(compareTrial);
}

function compareTrial(left: FightTrial, right: FightTrial): number {
  return (
    (PROFILE_ORDER[left.profile.name] ?? Number.MAX_SAFE_INTEGER) -
      (PROFILE_ORDER[right.profile.name] ?? Number.MAX_SAFE_INTEGER) ||
    (TIMING_ORDER[left.timing] ?? Number.MAX_SAFE_INTEGER) -
      (TIMING_ORDER[right.timing] ?? Number.MAX_SAFE_INTEGER) ||
    left.seed - right.seed ||
    (POLICY_ORDER[left.policy] ?? Number.MAX_SAFE_INTEGER) -
      (POLICY_ORDER[right.policy] ?? Number.MAX_SAFE_INTEGER)
  );
}

function rowsByTrial(rows: readonly FightRow[], planned: readonly FightTrial[]): Map<string, FightRow> {
  const expected = new Map(planned.map((trial) => [trialKey(trial), trial]));
  const result = new Map<string, FightRow>();
  for (const row of rows) {
    const key = trialKey(row.trial);
    const trial = expected.get(key);
    if (!trial || !sameJson(trial, row.trial)) continue;
    if (result.has(key)) throw new Error(`Duplicate result for fight trial: ${row.trial.id}`);
    result.set(key, row);
  }
  return result;
}

function metricValue(row: FightRow, metric: FightMetric): number | null {
  if (row.status !== "complete") return null;
  const totals = row.final?.totals;
  const metrics = row.metrics;
  switch (metric) {
    case "playerHp": return numberOrNull(row.final?.playerHp);
    case "enemyHp": return row.final
      ? numberOrNull(row.final.enemies.reduce((sum, enemy) => sum + enemy.hp, 0))
      : null;
    case "currency": return numberOrNull(row.final?.currency);
    case "swordDamage": return numberOrNull(totals?.swordDamage);
    case "bombDamageToEnemy": return numberOrNull(totals?.bombDamageToEnemy);
    case "enemyHpRemoved": return numberOrNull(totals?.enemyHpRemoved);
    case "discardedDamage": return numberOrNull(totals?.discardedDamage);
    case "skullDamage": return numberOrNull(totals?.skullDamage);
    case "bombDamageToPlayer": return numberOrNull(totals?.bombDamageToPlayer);
    case "healingOffered": return numberOrNull(totals?.healingOffered);
    case "healingUsed": return numberOrNull(totals?.healingUsed);
    case "healingWasted": return numberOrNull(totals?.healingWasted);
    case "detonations": return numberOrNull(totals?.detonations);
    case "safeBombs": return numberOrNull(totals?.safeBombs);
    case "blastAssociatedDetonations": return numberOrNull(totals?.blastAssociatedDetonations);
    case "lostCoins":
      if (!metrics) return null;
      return COIN_TYPES.reduce<number | null>((sum, type) => {
        const count = numberOrNull(metrics.lostByType[type]);
        return sum === null || count === null ? null : sum + count;
      }, 0);
    case "acceptedActions": return numberOrNull(metrics?.acceptedActions);
    case "elapsedSeconds": return numberOrNull(metrics?.elapsedSeconds);
    case "longestDry": return numberOrNull(metrics?.longestDry);
    case "longestNoEnemyDamage": return numberOrNull(metrics?.longestNoEnemyDamage);
    case "largestRollingIncoming": return numberOrNull(metrics?.largestRollingIncoming);
    case "largestRollingIncomingFraction": return numberOrNull(metrics?.largestRollingIncomingFraction);
  }
}

function lostByType(row: FightRow, type: CoinType): number | null {
  return row.status === "complete" ? numberOrNull(row.metrics?.lostByType[type]) : null;
}

export function nearestRank(values: readonly number[], percentile: number): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const clamped = Math.max(0, Math.min(1, percentile));
  return finite[Math.min(finite.length - 1, Math.max(0, Math.ceil(clamped * finite.length) - 1))]!;
}

export function summarizeMetric(values: readonly number[], worst: Worst): MetricSummary {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  return {
    count: finite.length,
    median: nearestRank(finite, 0.5),
    p10: nearestRank(finite, 0.1),
    p90: nearestRank(finite, 0.9),
    worst: finite.length ? (worst === "min" ? finite[0]! : finite[finite.length - 1]!) : null,
  };
}

function summaryForGroup(profile: string, timing: FightTiming, policy: FightPolicy, planned: readonly FightTrial[], rows: Map<string, FightRow>): FightSummary {
  const groupTrials = planned.filter((trial) => trial.profile.name === profile && trial.timing === timing && trial.policy === policy);
  const groupRows = groupTrials.flatMap((trial) => {
    const row = rows.get(trialKey(trial));
    return row ? [row] : [];
  });
  const validRows = groupRows.filter((row) => row.status === "complete");
  const invalid = groupRows.filter((row) => row.status === "invalid").length;
  const metrics = Object.fromEntries(
    (Object.keys(METRIC_WORST) as FightMetric[]).map((metric) => [
      metric,
      summarizeMetric(validRows.flatMap((row) => {
        const value = metricValue(row, metric);
        return value === null ? [] : [value];
      }), METRIC_WORST[metric]),
    ]),
  ) as Record<FightMetric, MetricSummary>;
  const lost = Object.fromEntries(
    COIN_TYPES.map((type) => [
      type,
      summarizeMetric(validRows.flatMap((row) => {
        const value = lostByType(row, type);
        return value === null ? [] : [value];
      }), "max"),
    ]),
  ) as Record<CoinType, MetricSummary>;
  const terminal = validRows.filter((row) => row.result !== "budget-exhausted" && row.result !== null);
  return {
    profile,
    timing,
    policy,
    planned: groupTrials.length,
    valid: validRows.length,
    invalid,
    invalidRate: rate(invalid, groupTrials.length),
    outcomes: Object.fromEntries(OUTCOMES.map((outcome) => [
      outcome,
      { count: validRows.filter((row) => row.result === outcome).length, denominator: validRows.length, rate: rate(validRows.filter((row) => row.result === outcome).length, validRows.length) },
    ])) as FightSummary["outcomes"],
    metrics,
    lostByType: lost,
    finish: {
      terminal: terminal.length,
      censored: validRows.length - terminal.length,
      actions: summarizeMetric(terminal.flatMap((row) => {
        const value = numberOrNull(row.metrics?.terminalActionCount);
        return value === null ? [] : [value];
      }), "max"),
      seconds: summarizeMetric(terminal.flatMap((row) => {
        const value = numberOrNull(row.metrics?.terminalSeconds);
        return value === null ? [] : [value];
      }), "max"),
    },
    seeds: [...new Set(groupTrials.map((trial) => trial.seed))].sort((left, right) => left - right),
  };
}

export function summarizeFightRows(rows: readonly FightRow[], planned: readonly FightTrial[]): FightSummary[] {
  const canonical = sortedTrials(planned);
  const rowMap = rowsByTrial(rows, canonical);
  const groups = new Map<string, { profile: string; timing: FightTiming; policy: FightPolicy }>();
  for (const trial of canonical)
    groups.set(`${trial.profile.name}\u0000${trial.timing}\u0000${trial.policy}`, { profile: trial.profile.name, timing: trial.timing, policy: trial.policy });
  return [...groups.values()]
    .sort((left, right) =>
      (PROFILE_ORDER[left.profile] ?? Number.MAX_SAFE_INTEGER) - (PROFILE_ORDER[right.profile] ?? Number.MAX_SAFE_INTEGER) ||
      (TIMING_ORDER[left.timing] ?? Number.MAX_SAFE_INTEGER) - (TIMING_ORDER[right.timing] ?? Number.MAX_SAFE_INTEGER) ||
      (POLICY_ORDER[left.policy] ?? Number.MAX_SAFE_INTEGER) - (POLICY_ORDER[right.policy] ?? Number.MAX_SAFE_INTEGER),
    )
    .map((group) => summaryForGroup(group.profile, group.timing, group.policy, canonical, rowMap));
}


function bootstrap(values: readonly number[]): DifferenceInterval {
  const difference = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  if (difference === null) return { difference: null, lower95: null, upper95: null };
  const random = randomFactory(BOOTSTRAP_SEED);
  const samples: number[] = [];
  for (let sample = 0; sample < BOOTSTRAP_RESAMPLES; sample++) {
    let total = 0;
    for (let index = 0; index < values.length; index++) total += values[Math.floor(random() * values.length)]!;
    samples.push(total / values.length);
  }
  return { difference, lower95: nearestRank(samples, 0.025), upper95: nearestRank(samples, 0.975) };
}

function comparisonValue(row: FightRow, metric: ComparisonMetric): number | null {
  if (row.status !== "complete") return null;
  if (metric === "victory") return row.result === "victory" ? 1 : row.result === null ? null : 0;
  return metricValue(row, metric);
}

export function compareFightRows(rows: readonly FightRow[], planned: readonly FightTrial[]): FightComparison[] {
  const canonical = sortedTrials(planned);
  const rowMap = rowsByTrial(rows, canonical);
  const profiles = [...new Set(canonical.map((trial) => trial.profile.name))].sort((left, right) => (PROFILE_ORDER[left] ?? Number.MAX_SAFE_INTEGER) - (PROFILE_ORDER[right] ?? Number.MAX_SAFE_INTEGER));
  const comparisons: FightComparison[] = [];
  for (const profile of profiles)
    for (const timing of TIMINGS) {
      const cohort = canonical.filter((trial) => trial.profile.name === profile && trial.timing === timing);
      if (!cohort.length) continue;
      for (let leftIndex = 0; leftIndex < FIGHT_POLICIES.length; leftIndex++)
        for (let rightIndex = leftIndex + 1; rightIndex < FIGHT_POLICIES.length; rightIndex++) {
          const left = FIGHT_POLICIES[leftIndex]!;
          const right = FIGHT_POLICIES[rightIndex]!;
          const leftTrials = new Map(cohort.filter((trial) => trial.policy === left).map((trial) => [trial.seed, trial]));
          const rightTrials = new Map(cohort.filter((trial) => trial.policy === right).map((trial) => [trial.seed, trial]));
          const seeds = [...leftTrials.keys()].filter((seed) => rightTrials.has(seed)).sort((a, b) => a - b);
          const pairs = seeds.flatMap((seed) => {
            const leftRow = rowMap.get(trialKey(leftTrials.get(seed)!));
            const rightRow = rowMap.get(trialKey(rightTrials.get(seed)!));
            return leftRow && rightRow ? [{ left: leftRow, right: rightRow }] : [];
          });
          const validPairs = pairs.filter((pair) => pair.left.status === "complete" && pair.right.status === "complete");
          const metrics = Object.fromEntries(([
            "victory", "playerHp", "currency", "longestDry", "largestRollingIncomingFraction",
          ] as ComparisonMetric[]).map((metric) => [
            metric,
            bootstrap(validPairs.flatMap((pair) => {
              const leftValue = comparisonValue(pair.left, metric);
              const rightValue = comparisonValue(pair.right, metric);
              return leftValue === null || rightValue === null ? [] : [leftValue - rightValue];
            })),
          ])) as Record<ComparisonMetric, DifferenceInterval>;
          comparisons.push({
            profile,
            timing,
            left,
            right,
            plannedPairs: seeds.length,
            validPairs: validPairs.length,
            omittedPairs: seeds.length - validPairs.length,
            metrics,
            seeds,
          });
        }
    }
  return comparisons;
}

function exactScreeningCohort(planned: readonly FightTrial[], profile: FightProfile, seeds: readonly number[]): { complete: boolean; trials: FightTrial[]; reason: string | null } {
  const cohort = planned.filter((trial) => trial.profile.name === profile.name);
  if (cohort.some((trial) => !sameJson(trial.profile, profile)))
    return { complete: false, trials: cohort, reason: "unregistered profile configuration" };
  if (cohort.some((trial) => trial.actions !== 60))
    return { complete: false, trials: cohort, reason: "screen action budget is not preregistered" };
  const expected = new Set<string>();
  for (const seed of seeds)
    for (const policy of FIGHT_POLICIES)
      expected.add(trialKey({ profile, timing: "adaptive", seed, policy }));
  const actual = new Set(cohort.map(trialKey));
  if (actual.size !== cohort.length) return { complete: false, trials: cohort, reason: "duplicate planned trials" };
  if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key)))
    return { complete: false, trials: cohort, reason: "incomplete planned cohort" };
  return { complete: true, trials: cohort, reason: null };
}


function candidateFor(profile: FightProfile, planned: readonly FightTrial[], rows: Map<string, FightRow>, seeds: readonly number[]): SelectionCandidate {
  const cohort = exactScreeningCohort(planned, profile, seeds);
  const expectedCount = seeds.length * FIGHT_POLICIES.length;
  const cohortRows = cohort.trials.flatMap((trial) => {
    const row = rows.get(trialKey(trial));
    return row ? [row] : [];
  });
  const validRows = cohortRows.filter((row) => row.status === "complete");
  const invalid = cohortRows.filter((row) => row.status === "invalid").length;
  const terminalRows = validRows.filter((row) => row.result !== null && row.result !== "budget-exhausted");
  const terminalActions = terminalRows.flatMap((row) => {
    const value = numberOrNull(row.metrics?.terminalActionCount);
    return value === null ? [] : [value];
  });
  const early = terminalRows.filter((row) => {
    const actions = numberOrNull(row.metrics?.terminalActionCount);
    return actions !== null && actions < 5;
  }).length;
  const unfinishedCount = validRows.filter((row) => row.result === "budget-exhausted").length;
  const severeCount = validRows.filter((row) =>
    row.metrics !== null && row.metrics.largestRollingIncomingFraction >= SELECTION_GATES.severeTailDamageFraction,
  ).length;
  const measurementsComplete = validRows.every((row) =>
    row.metrics !== null &&
    row.final !== null &&
    row.result !== null &&
    typeof row.metrics.severeBurst === "boolean" &&
    Number.isFinite(row.metrics.largestRollingIncomingFraction) &&
    row.metrics.largestRollingIncomingFraction >= 0,
  ) && terminalActions.length === terminalRows.length;
  const policyRates = FIGHT_POLICIES.map((policy) => {
    const policyRows = validRows.filter((row) => row.trial.policy === policy);
    return policyRows.length === seeds.length
      ? rate(policyRows.filter((row) => row.result === "simultaneous-defeat").length, policyRows.length)
      : null;
  });
  const jevRows = validRows.filter((row) => row.trial.policy === "jev");
  const jevVictoryRate = jevRows.length ? rate(jevRows.filter((row) => row.result === "victory").length, jevRows.length) : null;
  const medianJevPlayerHp = summarizeMetric(jevRows.flatMap((row) => {
    const value = metricValue(row, "playerHp");
    return value === null ? [] : [value];
  }), "min").median;
  const medianJevCurrency = summarizeMetric(jevRows.flatMap((row) => {
    const value = metricValue(row, "currency");
    return value === null ? [] : [value];
  }), "min").median;
  const candidate: SelectionCandidate = {
    profile,
    eligible: false,
    reasons: [],
    planned: expectedCount,
    valid: validRows.length,
    invalid,
    unfinishedRate: measurementsComplete ? rate(unfinishedCount, validRows.length) : null,
    earlyTerminalRate: measurementsComplete ? rate(early, terminalRows.length) : null,
    medianTerminalActions: terminalActions.length ? nearestRank(terminalActions, 0.5) : null,
    severeTailRate: measurementsComplete ? rate(severeCount, validRows.length) : null,
    worstPolicySimultaneousDefeatRate: policyRates.some((value) => value === null) ? null : Math.max(...policyRates as number[]),
    jevVictoryRate,
    medianJevPlayerHp,
    medianJevCurrency,
  };
  if (!cohort.complete) candidate.reasons.push(cohort.reason!);
  if (cohortRows.length !== expectedCount) candidate.reasons.push("incomplete completed cohort");
  if (invalid > SELECTION_GATES.maxInvalid) candidate.reasons.push("invalid trials");
  if (!measurementsComplete) candidate.reasons.push("incomplete valid measurements");
  if (candidate.unfinishedRate === null || candidate.unfinishedRate > SELECTION_GATES.maxUnfinishedRate) candidate.reasons.push("unfinished rate");
  if (candidate.earlyTerminalRate === null || candidate.earlyTerminalRate > SELECTION_GATES.maxEarlyTerminalRate) candidate.reasons.push("early terminal rate");
  if (candidate.medianTerminalActions === null || candidate.medianTerminalActions < SELECTION_GATES.minMedianTerminalActions || candidate.medianTerminalActions > SELECTION_GATES.maxMedianTerminalActions) candidate.reasons.push("terminal action median");
  if (candidate.severeTailRate === null || candidate.severeTailRate > SELECTION_GATES.maxSevereTailRate) candidate.reasons.push("severe burst tail");
  candidate.eligible = candidate.reasons.length === 0;
  return candidate;
}

function compareCandidates(left: SelectionCandidate, right: SelectionCandidate): number {
  const leftPreferred = left.jevVictoryRate !== null && left.jevVictoryRate >= SELECTION_GATES.preferredJevVictoryMin && left.jevVictoryRate <= SELECTION_GATES.preferredJevVictoryMax;
  const rightPreferred = right.jevVictoryRate !== null && right.jevVictoryRate >= SELECTION_GATES.preferredJevVictoryMin && right.jevVictoryRate <= SELECTION_GATES.preferredJevVictoryMax;
  return (
    Number(rightPreferred) - Number(leftPreferred) ||
    compareNumber(left.earlyTerminalRate, right.earlyTerminalRate, "asc") ||
    compareNumber(left.severeTailRate, right.severeTailRate, "asc") ||
    compareNumber(left.worstPolicySimultaneousDefeatRate, right.worstPolicySimultaneousDefeatRate, "asc") ||
    compareNumber(left.medianJevPlayerHp, right.medianJevPlayerHp, "desc") ||
    compareNumber(left.medianJevCurrency, right.medianJevCurrency, "desc") ||
    (PROFILE_ORDER[left.profile.name] ?? Number.MAX_SAFE_INTEGER) - (PROFILE_ORDER[right.profile.name] ?? Number.MAX_SAFE_INTEGER)
  );
}


export function selectFightProfiles(rows: readonly FightRow[], planned: readonly FightTrial[], screeningSeeds: number[], screeningReportDigest: string): FrozenSelection {
  validateSeeds(screeningSeeds);
  if (!/^[a-f0-9]{64}$/.test(screeningReportDigest)) throw new Error("Screening report digest must be a SHA-256 digest");
  const canonical = sortedTrials(planned);
  const rowMap = rowsByTrial(rows, canonical);
  const ranking = registeredProfiles().map((profile) => candidateFor(profile, canonical, rowMap, screeningSeeds)).sort(compareCandidates);
  const qualified = ranking.filter((candidate) => candidate.eligible);
  const selected = qualified.length ? qualified.slice(0, 2) : ranking.slice(0, Math.min(2, ranking.length));
  const selection: Omit<FrozenSelection, "digest"> = {
    version: "first-fight-selection-v1",
    status: qualified.length ? "selected" : "no-qualified-mixture",
    mode: qualified.length ? "qualified" : "diagnostic",
    screeningSeeds: [...screeningSeeds],
    screeningReportDigest,
    protocolDigest: protocolDigest(),
    gates: { ...SELECTION_GATES },
    profiles: selected.map((candidate) => candidate.profile),
    ranking,
  };
  return { ...selection, digest: digest(selection) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`${label} has an invalid shape`);
}

function finiteOrNull(value: unknown, label: string): asserts value is number | null {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be finite or null`);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} is invalid`);
  return value;
}

function validateCandidate(value: unknown): asserts value is SelectionCandidate {
  const candidate = record(value, "Selection candidate");
  exactKeys(candidate, ["profile", "eligible", "reasons", "planned", "valid", "invalid", "unfinishedRate", "earlyTerminalRate", "medianTerminalActions", "severeTailRate", "worstPolicySimultaneousDefeatRate", "jevVictoryRate", "medianJevPlayerHp", "medianJevCurrency"], "Selection candidate");
  validateRegisteredProfile(candidate.profile);
  if (typeof candidate.eligible !== "boolean" || !Array.isArray(candidate.reasons) || candidate.reasons.some((reason) => typeof reason !== "string")) throw new Error("Selection candidate has invalid eligibility");
  const planned = nonnegativeInteger(candidate.planned, "Selection candidate planned");
  const valid = nonnegativeInteger(candidate.valid, "Selection candidate valid");
  const invalid = nonnegativeInteger(candidate.invalid, "Selection candidate invalid");
  if (valid + invalid > planned)
    throw new Error("Selection candidate counts exceed planned trials");
  for (const key of ["medianTerminalActions", "medianJevPlayerHp", "medianJevCurrency"] as const)
    finiteOrNull(candidate[key], `Selection candidate ${key}`);
  for (const key of ["unfinishedRate", "earlyTerminalRate", "severeTailRate", "worstPolicySimultaneousDefeatRate", "jevVictoryRate"] as const) {
    const rateValue = candidate[key];
    finiteOrNull(rateValue, `Selection candidate ${key}`);
    if (rateValue !== null && (rateValue < 0 || rateValue > 1))
      throw new Error(`Selection candidate ${key} is outside zero through one`);
  }
  if (candidate.eligible !== (candidate.reasons.length === 0))
    throw new Error("Selection candidate eligibility does not match reasons");
}

export function validateSelection(value: unknown): asserts value is FrozenSelection {
  const selection = record(value, "Frozen selection");
  exactKeys(selection, ["version", "status", "mode", "screeningSeeds", "screeningReportDigest", "protocolDigest", "gates", "profiles", "ranking", "digest"], "Frozen selection");
  if (selection.version !== "first-fight-selection-v1") throw new Error("Unknown frozen selection version");
  if (selection.status !== "selected" && selection.status !== "no-qualified-mixture") throw new Error("Unknown frozen selection status");
  if (selection.mode !== "qualified" && selection.mode !== "diagnostic") throw new Error("Unknown frozen selection mode");
  if ((selection.status === "selected") !== (selection.mode === "qualified")) throw new Error("Selection status and mode disagree");
  if (!Array.isArray(selection.screeningSeeds)) throw new Error("Selection screening seeds are invalid");
  validateSeeds(selection.screeningSeeds as number[]);
  if (!sameJson(selection.screeningSeeds, SCREEN_SEEDS)) throw new Error("Selection screening manifest is not preregistered");
  if (selection.protocolDigest !== protocolDigest()) throw new Error("Selection protocol digest does not match current protocol");
  if (!sameJson(selection.gates, SELECTION_GATES)) throw new Error("Selection gates do not match current protocol");
  if (typeof selection.screeningReportDigest !== "string" || !/^[a-f0-9]{64}$/.test(selection.screeningReportDigest)) throw new Error("Selection screening report digest is invalid");
  if (!Array.isArray(selection.profiles) || selection.profiles.length < 1 || selection.profiles.length > 2) throw new Error("Selection profiles are invalid");
  for (const profile of selection.profiles) validateRegisteredProfile(profile);
  const selectedNames = (selection.profiles as FightProfile[]).map((profile) => profile.name);
  if (new Set(selectedNames).size !== selectedNames.length) throw new Error("Selection profiles are duplicated");
  if (!Array.isArray(selection.ranking) || selection.ranking.length !== registeredProfiles().length) throw new Error("Selection ranking is incomplete");
  for (const candidate of selection.ranking) validateCandidate(candidate);
  const ranking = selection.ranking as SelectionCandidate[];
  const rankingNames = ranking.map((candidate) => candidate.profile.name);
  if (new Set(rankingNames).size !== rankingNames.length || !sameJson([...rankingNames].sort(), registeredProfiles().map((profile) => profile.name).sort())) throw new Error("Selection ranking profiles are invalid");
  if (!sameJson(rankingNames, [...ranking].sort(compareCandidates).map((candidate) => candidate.profile.name)))
    throw new Error("Selection ranking is not canonical");
  const eligible = ranking.filter((candidate) => candidate.eligible);
  const expectedProfiles = (selection.status === "selected" ? eligible.slice(0, 2) : ranking.slice(0, 2)).map((candidate) => candidate.profile.name);
  if ((selection.status === "selected" && !eligible.length) || (selection.status === "no-qualified-mixture" && eligible.length) || !sameJson(selectedNames, expectedProfiles)) throw new Error("Selection profiles do not match ranking");
  if (typeof selection.digest !== "string" || !/^[a-f0-9]{64}$/.test(selection.digest)) throw new Error("Selection digest is invalid");
  const { digest: suppliedDigest, ...withoutDigest } = selection;
  if (suppliedDigest !== digest(withoutDigest)) throw new Error("Selection digest does not match contents");
}
