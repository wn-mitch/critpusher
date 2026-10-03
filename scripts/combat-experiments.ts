import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { release as osRelease } from "node:os";
import { parseArgs, promisify } from "node:util";
import {
  FIGHT_POLICIES,
  FIGHT_VERSION,
  type FightPhase,
  type FightPolicy,
  type FightReport,
  type FightRow,
  type FightTiming,
  type FightTrial,
  type FrozenSelection,
} from "./combat-contracts";
import {
  SCREEN_SEEDS,
  EVALUATION_SEEDS,
  MECHANICAL_WAIT_LIMIT_TICKS,
  assertDisjointSeeds,
  canonicalJson,
  digest,
  protocolDigest,
  registeredProfiles,
  trialId,
  validateFightTrial,
  validateRegisteredProfile,
  validateSeeds,
} from "./combat-protocol";
import {
  invalidFightRow,
  runCombatTrial,
} from "./combat-trial";
import {
  compareFightRows,
  selectFightProfiles,
  summarizeFightRows,
  validateSelection,
} from "./combat-report";
import { replayFightReport } from "./combat-replay";

const DEFAULT_MAX_JEV_REQUESTS = 10_000;
const DEFAULT_WORKERS = 4;
const SMOKE_SEEDS = [42] as const;
const SMOKE_POLICIES = ["center", "random", "rule"] as const;
const SOURCE_ROOTS = ["src", "scripts", "package.json", "package-lock.json"] as const;

type CliValues = Record<string, string | undefined>;
export interface FightCliOptions {
  phase: FightPhase;
  policies: FightPolicy[];
  seeds: number[];
  actions: number;
  timings: FightTiming[];
  maxJevRequests: number;
  workers: number;
  output?: string;
  selection?: string;
  replay?: string;
  profiles?: string[];
  worker?: string;
}

function numeric(value: string, label: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return number;
}

function list(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.some((entry) => !entry)) throw new Error(`${label} must not contain empty values`);
  if (new Set(entries).size !== entries.length) throw new Error(`${label} contains a duplicate value`);
  return entries;
}

function parseSeeds(value: string | undefined, fallback: readonly number[]): number[] {
  const entries = list(value, "seeds") ?? fallback.map(String);
  const seeds = entries.map((entry) => numeric(entry, "Seed", 0, 0xffffffff));
  validateSeeds(seeds);
  return seeds;
}

function parsePolicies(value: string | undefined, fallback: readonly FightPolicy[]): FightPolicy[] {
  const entries = list(value, "policies") ?? [...fallback];
  if (!entries.length || entries.some((entry) => !FIGHT_POLICIES.includes(entry as FightPolicy)))
    throw new Error(`Unknown fight policy; expected ${FIGHT_POLICIES.join(",")}`);
  return entries as FightPolicy[];
}

function parseTimings(value: string | undefined, phase: FightPhase): FightTiming[] {
  if (value === undefined) return phase === "evaluate" ? ["adaptive", "fixed"] : ["adaptive"];
  const entries = list(value, "timing");
  if (!entries || entries.some((entry) => entry !== "adaptive" && entry !== "fixed"))
    throw new Error("Timing must be adaptive or fixed");
  return entries as FightTiming[];
}

function valuesFrom(argv: readonly string[]): CliValues {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      phase: { type: "string" },
      policies: { type: "string" },
      seeds: { type: "string" },
      actions: { type: "string" },
      timing: { type: "string" },
      "max-jev-requests": { type: "string" },
      workers: { type: "string" },
      output: { type: "string" },
      selection: { type: "string" },
      replay: { type: "string" },
      profiles: { type: "string" },
      worker: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  });
  return parsed.values as CliValues;
}

export function parseFightArgs(argv: readonly string[] = process.argv.slice(2)): FightCliOptions {
  const values = valuesFrom(argv);
  const phase = (values.phase ?? "smoke") as FightPhase;
  if (!["smoke", "screen", "evaluate", "replay"].includes(phase))
    throw new Error("Phase must be smoke, screen, evaluate, or replay");
  if (values.worker !== undefined)
    return {
      phase,
      policies: [],
      seeds: [],
      actions: 1,
      timings: ["adaptive"],
      maxJevRequests: 0,
      workers: 1,
      worker: values.worker,
    };

  const profiles = list(values.profiles, "profiles");
  const policies = parsePolicies(
    values.policies,
    phase === "smoke" ? SMOKE_POLICIES : FIGHT_POLICIES,
  );
  const seeds = parseSeeds(
    values.seeds,
    phase === "screen"
      ? SCREEN_SEEDS
      : phase === "evaluate"
        ? EVALUATION_SEEDS
        : SMOKE_SEEDS,
  );
  const actions = numeric(values.actions ?? (phase === "smoke" ? "12" : "60"), "Actions", 1, 60);
  const timings = parseTimings(values.timing, phase);
  const maxJevRequests = numeric(
    values["max-jev-requests"] ?? String(DEFAULT_MAX_JEV_REQUESTS),
    "max-jev-requests",
    0,
    1_000_000,
  );
  const workers = numeric(values.workers ?? String(DEFAULT_WORKERS), "Workers", 1, 8);

  if (phase === "screen") {
    if (policies.length !== FIGHT_POLICIES.length || policies.some((policy) => !FIGHT_POLICIES.includes(policy)))
      throw new Error("Screen phase requires all four preregistered policies");
    if (canonicalJson(seeds) !== canonicalJson(SCREEN_SEEDS))
      throw new Error("Screen phase requires the preregistered screening seeds");
    if (actions !== 60 || timings.length !== 1 || timings[0] !== "adaptive")
      throw new Error("Screen phase requires 60 actions and adaptive timing");
    if (profiles && canonicalJson(profiles.slice().sort()) !== canonicalJson(registeredProfiles().map((profile) => profile.name).sort()))
      throw new Error("Screen phase requires all nine preregistered profiles");
  }
  if (phase === "evaluate") {
    if (canonicalJson(seeds) !== canonicalJson(EVALUATION_SEEDS))
      throw new Error("Evaluate phase requires the disjoint preregistered evaluation seeds");
    if (actions !== 60) throw new Error("Evaluate phase requires 60 actions");
    if (!values.selection) throw new Error("Evaluate phase requires --selection");
  }
  if (phase === "replay" && !values.replay) throw new Error("Replay phase requires --replay");
  if (phase !== "replay" && values.replay) throw new Error("--replay is only valid in replay phase");
  if (phase !== "screen" && profiles?.some((name) => !registeredProfiles().some((profile) => profile.name === name)))
    throw new Error("Unknown preregistered profile");
  if (phase === "smoke" && profiles && (profiles.length !== 1 || profiles[0] !== "balanced-standard"))
    throw new Error("Smoke phase uses the balanced-standard profile");
  if (phase === "evaluate" && profiles) throw new Error("Evaluate profiles come from the frozen selection");
  const jevTrials = policies.filter((policy) => policy === "jev").length * seeds.length;
  const timingsForBudget = timings.length;
  const profileCount = phase === "screen" ? 9 : profiles?.length ?? 1;
  const requiredRequests = phase === "replay" ? 0 : jevTrials * timingsForBudget * profileCount * actions;
  if (requiredRequests > maxJevRequests)
    throw new Error(`Plan requires ${requiredRequests} Jev requests; cap is ${maxJevRequests}`);
  if (phase === "screen" && !values.output)
    throw new Error("Screen phase requires --output to retain trial and replay evidence");
  const resolvedProfiles =
    phase === "screen"
      ? registeredProfiles().map((profile) => profile.name)
      : phase === "smoke"
        ? ["balanced-standard"]
        : profiles;
  return {
    phase,
    policies,
    seeds,
    actions,
    timings,
    maxJevRequests,
    workers,
    ...(values.output ? { output: values.output } : {}),
    ...(values.selection ? { selection: values.selection } : {}),
    ...(values.replay ? { replay: values.replay } : {}),
    ...(resolvedProfiles ? { profiles: resolvedProfiles } : {}),
  };
}

async function walk(path: string): Promise<string[]> {
  const stat = await readdir(path, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of stat) {
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(child)));
    else files.push(child);
  }
  return files;
}

async function identity(): Promise<FightReport["identity"]> {
  const root = process.cwd();
  const source = createHash("sha256");
  const dependencies = createHash("sha256");
  for (const relative of SOURCE_ROOTS) {
    const path = resolve(root, relative);
    const files = relative.includes(".") ? [path] : await walk(path);
    for (const file of files.sort()) {
      const bytes = await readFile(file);
      source.update(relative + "/" + file.slice(path.length) + "\0").update(bytes);
      if (relative === "package-lock.json") dependencies.update(bytes);
    }
  }
  return {
    sourceDigest: source.digest("hex"),
    dependencyDigest: dependencies.digest("hex"),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: osRelease(),
  };
}

function profileByName(name: string): FightTrial["profile"] {
  const profile = registeredProfiles().find((candidate) => candidate.name === name);
  if (!profile) throw new Error(`Unknown preregistered profile ${name}`);
  validateRegisteredProfile(profile);
  return profile;
}

function profileNames(options: FightCliOptions, selection?: FrozenSelection): string[] {
  if (options.phase === "screen") return registeredProfiles().map((profile) => profile.name);
  if (options.phase === "evaluate") {
    if (!selection) throw new Error("Frozen selection is required");
    return selection.profiles.map((profile) => profile.name);
  }
  return options.profiles ?? ["balanced-standard"];
}

export function planFightTrials(options: FightCliOptions, selection?: FrozenSelection): FightTrial[] {
  const profiles = profileNames(options, selection);
  const trials: FightTrial[] = [];
  for (const profileName of profiles) {
    const profile = profileByName(profileName);
    for (const timing of options.timings)
      for (const seed of options.seeds)
        for (const policy of options.policies) {
          const trial: FightTrial = {
            id: trialId(profile, timing, seed, policy),
            profile,
            policy,
            timing,
            seed,
            actions: options.actions,
            maxJevRequests: options.maxJevRequests,
          };
          validateFightTrial(trial);
          trials.push(trial);
        }
  }
  return trials;
}

function emptyReport(options: FightCliOptions, plannedTrials: FightTrial[], identityValue: FightReport["identity"]): FightReport {
  return {
    version: FIGHT_VERSION,
    phase: options.phase,
    status: "running",
    protocol: {
      loadingMinimumTicks: 720,
      loadingMaximumTicks: 1440,
      cycleTicks: 144,
      actions: options.actions,
      visibilityModel: "three-cap-rays-v3",
      timing: options.timings,
      seeds: options.seeds,
      plannedTrials,
      bootstrapResamples: 2000,
      bootstrapSeed: 0x05a17e11,
      notes: [
        "Loading and active play are one continuous combat lifecycle; opening effects and terminal outcomes remain in evidence.",
        "All policies receive the same readable observation projection and physical profile.",
        "Invalid rows retain their trace and do not reduce the planned denominator.",
        `Mechanical settling waits up to ${MECHANICAL_WAIT_LIMIT_TICKS} ticks for admission; a persistent stall is invalid. The 144-tick release window begins at the first physical admission fragment and excludes earlier waiting effects.`,
        "Jev requests are bounded and never retried or replaced by a fallback policy.",
      ],
    },
    identity: identityValue,
    planned: plannedTrials.length,
    completed: 0,
    invalid: 0,
    rows: [],
    summary: [],
    comparisons: [],
    selection: null,
    replay: [],
    elapsedSeconds: 0,
  };
}

function updateReport(report: FightReport, rows: FightRow[], started: number): void {
  report.rows = rows.slice().sort((left, right) => left.trial.id.localeCompare(right.trial.id));
  report.completed = report.rows.length;
  report.invalid = report.rows.filter((row) => row.status === "invalid").length;
  report.summary = summarizeFightRows(report.rows, report.protocol.plannedTrials);
  report.comparisons = compareFightRows(report.rows, report.protocol.plannedTrials);
  report.elapsedSeconds = (performance.now() - started) / 1000;
}

/** Stable screening evidence excludes wall time, API metadata, and report lifecycle fields. */
function screeningPayload(report: FightReport): unknown {
  return {
    version: report.version,
    protocolDigest: protocolDigest(),
    plannedTrials: report.protocol.plannedTrials,
    rows: report.rows.map((row) => ({
      trial: row.trial,
      status: row.status,
      result: row.result,
      error: row.error,
      loading: row.loading,
      initialDigest: row.initialDigest,
      simulationDigest: row.simulationDigest,
      final: row.final,
      finalFeed: row.finalFeed,
      physicalFinal: row.physicalFinal,
      metrics: row.metrics,
      ledger: row.ledger,
      windows: row.windows,
    })),
    summary: report.summary,
    comparisons: report.comparisons,
  };
}

export function invalidateDigestGroups(rows: FightRow[]): void {
  const groups = new Map<string, FightRow[]>();
  for (const row of rows) {
    if (row.status === "complete" && (typeof row.initialDigest !== "string" || row.initialDigest.length === 0)) {
      row.status = "invalid";
      row.result = null;
      row.error = "Complete trial is missing initial digest evidence";
    }
    const key = `${row.trial.profile.name}/${row.trial.timing}/${row.trial.seed}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const digests = new Set(group.flatMap((row) =>
      typeof row.initialDigest === "string" && row.initialDigest.length > 0 ? [row.initialDigest] : [],
    ));
    if (digests.size < 2) continue;
    const message = `Initial digest mismatch in trial group ${key}`;
    for (const row of group) {
      row.status = "invalid";
      row.result = null;
      row.error = row.error ? `${row.error}; ${message}` : message;
    }
  }
}

async function loadSelection(path: string): Promise<FrozenSelection> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  validateSelection(value);
  const selection = value as FrozenSelection;
  if (selection.protocolDigest !== protocolDigest()) throw new Error("Frozen selection protocol digest does not match this build");
  assertDisjointSeeds(selection.screeningSeeds, EVALUATION_SEEDS);
  if (selection.profiles.length < 1 || selection.profiles.length > 2)
    throw new Error("Frozen selection must contain one or two profiles");
  for (const profile of selection.profiles) validateRegisteredProfile(profile);
  return selection;
}

async function executeWorker(trial: FightTrial): Promise<FightRow> {
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(import.meta.resolve("tsx/cli")), fileURLToPath(import.meta.url), "--worker", JSON.stringify(trial)],
    { maxBuffer: 64 * 1024 * 1024, timeout: 900_000 },
  );
  if (stderr) process.stderr.write(stderr);
  const value = JSON.parse(stdout) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Worker returned a non-object row");
  const row = value as Partial<FightRow>;
  if (!row.trial || typeof row.trial !== "object" || row.trial.id !== trial.id)
    throw new Error("Worker returned a row for the wrong trial");
  try {
    validateFightTrial(row.trial);
  } catch {
    throw new Error("Worker returned a row with an invalid trial contract");
  }
  if (row.status !== "complete" && row.status !== "invalid")
    throw new Error("Worker returned a row with an invalid status");
  if (
    !("loading" in row) ||
    !("finalFeed" in row) ||
    !Array.isArray(row.ledger) ||
    row.ledger.some((entry) => !Array.isArray(entry.admissions) ||
      !Array.isArray(entry.waveEvents) || !Array.isArray(entry.feed) ||
      !Array.isArray(entry.feedStreams)) ||
    !Array.isArray(row.decisions) ||
    row.decisions.some((decision) => !Array.isArray(decision.admissions)) ||
    !Array.isArray(row.windows)
  ) throw new Error("Worker returned a row with incomplete trace evidence");
  return value as FightRow;
}

async function runTrials(options: FightCliOptions, report: FightReport, started: number): Promise<FightRow[]> {
  const rows: FightRow[] = [];
  let next = 0;
  let save = Promise.resolve();
  const persist = () => {
    if (!options.output) return;
    updateReport(report, rows, started);
    save = save.then(() => writeFile(options.output!, JSON.stringify(report, null, 2) + "\n"));
  };
  persist();
  await save;
  const workerCount = Math.min(options.workers, report.protocol.plannedTrials.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = next++;
      const trial = report.protocol.plannedTrials[index];
      if (!trial) return;
      let row: FightRow;
      try {
        row = await executeWorker(trial);
      } catch (error) {
        row = invalidFightRow(trial, error instanceof Error ? error.message : String(error));
      }
      rows.push(row);
      persist();
    }
  }));
  await save;
  invalidateDigestGroups(rows);
  updateReport(report, rows, started);
  return rows;
}

async function runReplay(options: FightCliOptions, report: FightReport, started: number): Promise<void> {
  const parsed = JSON.parse(await readFile(options.replay!, "utf8")) as unknown;
  const { trials, checks } = await replayFightReport(parsed);
  report.protocol.plannedTrials = trials;
  report.protocol.seeds = [...new Set(trials.map((trial) => trial.seed))];
  report.protocol.timing = [...new Set(trials.map((trial) => trial.timing))];
  report.protocol.actions = trials.reduce((maximum, trial) => Math.max(maximum, trial.actions), 0);
  report.replay = checks;
  report.planned = trials.length || checks.length;
  report.completed = checks.length;
  report.invalid = checks.filter((check) => !check.matched).length;
  report.status = report.invalid ? "invalid" : "complete";
  report.elapsedSeconds = (performance.now() - started) / 1000;
}

export async function runFightCli(argv: readonly string[] = process.argv.slice(2)): Promise<FightReport> {
  const options = parseFightArgs(argv);
  const started = performance.now();
  if (options.worker) {
    const trial = JSON.parse(options.worker) as unknown;
    validateFightTrial(trial);
    process.stdout.write(JSON.stringify(await runCombatTrial(trial)));
    return emptyReport(options, [], await identity());
  }
  const selection = options.phase === "evaluate" ? await loadSelection(options.selection!) : undefined;
  const profileCount = selection?.profiles.length ?? (options.phase === "screen" ? 9 : 1);
  const requiredJevRequests = options.phase === "replay" ? 0 :
    options.policies.filter((policy) => policy === "jev").length *
    options.seeds.length *
    options.timings.length *
    profileCount *
    options.actions;
  if (requiredJevRequests > options.maxJevRequests)
    throw new Error(`Plan requires ${requiredJevRequests} Jev requests; cap is ${options.maxJevRequests}`);
  const plannedTrials = options.phase === "replay" ? [] : planFightTrials(options, selection);
  const report = emptyReport(options, plannedTrials, await identity());
  if (options.phase === "replay") {
    await runReplay(options, report, started);
  } else {
    const rows = await runTrials(options, report, started);
    updateReport(report, rows, started);
    if (options.phase === "screen") {
      const screeningReportDigest = digest(screeningPayload(report));
      report.selection = selectFightProfiles(rows, plannedTrials, options.seeds, screeningReportDigest);
      if (options.selection) await writeFile(options.selection, JSON.stringify(report.selection, null, 2) + "\n");
    }
    report.status = report.invalid ? "invalid" : "complete";
  }
  if (options.output) await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
  if (report.invalid) {
    const replayError = report.replay.length === 1 &&
      report.replay[0]?.trialId === "<invalid-report>"
      ? report.replay[0].error
      : null;
    throw new Error(replayError ?? `${report.invalid} invalid trial or replay row(s); evidence retained`);
  }
  return report;
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runFightCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
