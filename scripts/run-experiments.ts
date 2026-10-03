import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  RUN_POLICIES,
  RUN_VERSION,
  type BuildId,
  type ReplayCheck,
  type RunPolicy,
  type RunReportProjection,
  type RunRow,
  type RunRowIdentity,
  type RunRowSummary,
  type RunSelection,
  type RunStudyPhase,
  type RunTrial,
} from "./run-contracts";
import {
  ACTION_LIMIT,
  canonicalJson,
  createManifest,
  digest,
  profileFor,
  runConfigurationEvidence,
  runProtocolDigest,
  validateFrozenSelection,
  validateRunTrial,
  validateSeeds,
} from "./run-protocol";
import { compareReplayRowIdentity, freezeScreenSelection, runRowIdentity, summarizeRunRows, toRunRowSummary } from "./run-report";
import { createRowSpool, readReportProjection, spoolReplayInputs, writeReportStream, type RowSpool } from "./run-storage";
import { invalidRunRow, runWholeTrial } from "./run-trial";

const DEFAULT_WORKERS = 4;
const WORKER_TIMEOUT_MS = 3_600_000;
const WORKER_MAX_BUFFER = 128 * 1024 * 1024;
type CliValues = Record<string, string | undefined>;
interface WorkerRequest {
  trial: RunTrial;
  replayPath?: string;
  spoolDir?: string;
  index?: number;
}

export interface RunCliOptions {
  phase: RunStudyPhase;
  seeds?: number[];
  builds?: BuildId[];
  policies: RunPolicy[];
  actions: number;
  workers: number;
  output?: string;
  selection?: string;
  replay?: string;
  worker?: string;
}

function integer(value: string, label: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function list(value: string | undefined, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry)) throw new Error(`${label} must not contain empty values`);
  if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicate values`);
  return entries;
}

function valuesFrom(argv: readonly string[]): CliValues {
  return parseArgs({
    args: [...argv],
    options: {
      phase: { type: "string" },
      seeds: { type: "string" },
      builds: { type: "string" },
      policies: { type: "string" },
      actions: { type: "string" },
      workers: { type: "string" },
      output: { type: "string" },
      selection: { type: "string" },
      replay: { type: "string" },
      worker: { type: "string" },
    },
    allowPositionals: false,
    strict: true,
  }).values as CliValues;
}

export function parseRunArgs(argv: readonly string[] = process.argv.slice(2)): RunCliOptions {
  const values = valuesFrom(argv);
  const phase = (values.phase ?? "smoke") as RunStudyPhase;
  if (!["smoke", "screen", "evaluate", "replay"].includes(phase))
    throw new Error("Phase must be smoke, screen, evaluate, or replay");
  if (values.worker !== undefined) {
    return { phase, policies: [], actions: 1, workers: 1, worker: values.worker };
  }

  const seedEntries = list(values.seeds, "seeds");
  const seeds = seedEntries?.map((entry) => integer(entry, "Seed", 0, 0xffffffff));
  if (seeds) validateSeeds(seeds);
  const buildEntries = list(values.builds, "builds");
  const builds = buildEntries?.map((entry) => {
    profileFor(entry as BuildId);
    return entry as BuildId;
  });
  const policyEntries = list(values.policies, "policies");
  const policies = (policyEntries ?? (phase === "evaluate" ? ["rule"] : [...RUN_POLICIES])) as RunPolicy[];
  if (!policies.length || policies.some((policy) => !RUN_POLICIES.includes(policy)))
    throw new Error(`Unknown policy; expected ${RUN_POLICIES.join(",")}`);
  const actions = integer(values.actions ?? String(ACTION_LIMIT), "Actions", 1, ACTION_LIMIT);
  const workers = integer(values.workers ?? String(DEFAULT_WORKERS), "Workers", 1, 32);

  if (phase !== "smoke" && (values.seeds !== undefined || values.builds !== undefined))
    throw new Error("Explicit seed and build overrides are only valid for smoke");
  if (phase === "screen") {
    if (canonicalJson([...policies].sort()) !== canonicalJson([...RUN_POLICIES].sort()) || actions !== ACTION_LIMIT)
      throw new Error("Screen requires center, random, and rule with 60 actions");
    if (!values.output) throw new Error("Screen requires --output to retain complete evidence");
  }
  if (phase === "evaluate") {
    if (canonicalJson(policies) !== canonicalJson(["rule"]) || actions !== ACTION_LIMIT)
      throw new Error("Evaluate requires rule policy with 60 actions");
    if (!values.selection) throw new Error("Evaluate requires --selection");
  }
  if (phase === "replay") {
    if (!values.replay) throw new Error("Replay requires --replay");
    if (values.seeds !== undefined || values.builds !== undefined || values.policies !== undefined || values.actions !== undefined)
      throw new Error("Replay decisions and manifest come only from the recorded report");
  } else if (values.replay) throw new Error("--replay is only valid in replay phase");

  return {
    phase,
    ...(seeds ? { seeds } : {}),
    ...(builds ? { builds } : {}),
    policies,
    actions,
    workers,
    ...(values.output ? { output: values.output } : {}),
    ...(values.selection ? { selection: values.selection } : {}),
    ...(values.replay ? { replay: values.replay } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function workerRequest(value: unknown): WorkerRequest {
  const record = asRecord(value);
  if (!("trial" in record)) throw new Error("Worker request must contain a trial");
  const trial = record.trial;
  validateRunTrial(trial);
  const replayPath = record.replayPath;
  if (replayPath !== undefined && typeof replayPath !== "string") throw new Error("Worker replay path must be a string");
  const spoolDir = record.spoolDir;
  if (spoolDir !== undefined && typeof spoolDir !== "string") throw new Error("Worker spool directory must be a string");
  const index = record.index;
  if (index !== undefined && (typeof index !== "number" || !Number.isSafeInteger(index))) throw new Error("Worker row index must be an integer");
  return {
    trial,
    ...(typeof replayPath === "string" ? { replayPath } : {}),
    ...(typeof spoolDir === "string" ? { spoolDir } : {}),
    ...(typeof index === "number" ? { index } : {}),
  };
}

async function replayInput(path: string, trial: RunTrial): Promise<Pick<RunRow, "decisions" | "shops">> {
  const parsed = asRecord(JSON.parse(await readFile(path, "utf8")) as unknown);
  if (!("trial" in parsed) || !("decisions" in parsed) || !("shops" in parsed)) throw new Error("Worker replay input is incomplete");
  const parsedTrial = parsed.trial;
  validateRunTrial(parsedTrial);
  if (canonicalJson(parsedTrial) !== canonicalJson(trial) ||
    !Array.isArray(parsed.decisions) || !Array.isArray(parsed.shops)) throw new Error("Worker replay input is invalid");
  return { decisions: parsed.decisions as RunRow["decisions"], shops: parsed.shops as RunRow["shops"] };
}

async function runRunWorker(request: WorkerRequest): Promise<void> {
  const recorded = request.replayPath ? await replayInput(request.replayPath, request.trial) : undefined;
  const row = await runWholeTrial(request.trial, recorded ? { replay: recorded } : {});
  if (request.spoolDir !== undefined && request.index !== undefined) {
    await writeFile(join(request.spoolDir, `${request.index}.json`), JSON.stringify(row));
  }
  process.stdout.write(JSON.stringify(runRowIdentity(row)));
}

async function executeWorker(trial: RunTrial, spool: RowSpool, index: number, replayPath?: string): Promise<RunRow> {
  const request: WorkerRequest = { trial, ...(replayPath ? { replayPath } : {}), spoolDir: spool.directory, index };
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(import.meta.resolve("tsx/cli")), fileURLToPath(import.meta.url), "--worker", JSON.stringify(request)],
    { maxBuffer: WORKER_MAX_BUFFER, timeout: WORKER_TIMEOUT_MS },
  );
  if (stderr) process.stderr.write(stderr);
  const identity = asRecord(JSON.parse(stdout) as unknown);
  if (!("trial" in identity) || !("digest" in identity)) throw new Error("Worker returned a non-object identity");
  const identityTrial = identity.trial;
  validateRunTrial(identityTrial);
  if (canonicalJson(identityTrial) !== canonicalJson(trial)) throw new Error("Worker returned evidence for the wrong trial");
  const row = await spool.readRow(index);
  if (identity.digest !== digest(row)) throw new Error("Worker identity digest does not match spooled row");
  return row;
}

async function executeManifest(
  manifest: readonly RunTrial[],
  workers: number,
  spool: RowSpool,
  replayPaths?: ReadonlyMap<string, string>,
  onRow?: (row: RunRow, index: number) => Promise<void> | void,
): Promise<{ summaries: RunRowSummary[]; identities: RunRowIdentity[] }> {
  const summaries = new Array<RunRowSummary>(manifest.length);
  const identities = new Array<RunRowIdentity>(manifest.length);
  let cursor = 0;
  const workerCount = Math.min(workers, manifest.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= manifest.length) return;
      const trial = manifest[index]!;
      try {
        const row = await executeWorker(trial, spool, index, replayPaths?.get(trial.id));
        await onRow?.(row, index);
        summaries[index] = toRunRowSummary(row);
        identities[index] = runRowIdentity(row);
      } catch (error) {
        const row = invalidRunRow(trial, error instanceof Error ? error.message : String(error));
        await writeFile(spool.rowPath(index), JSON.stringify(row));
        summaries[index] = toRunRowSummary(row);
        identities[index] = runRowIdentity(row);
      }
    }
  }));
  return { summaries, identities };
}

function buildProjection(
  phase: RunStudyPhase,
  protocolDigest: string,
  manifest: readonly RunTrial[],
  summaries: readonly RunRowSummary[],
  identities: readonly RunRowIdentity[],
): RunReportProjection {
  return {
    version: RUN_VERSION,
    phase,
    protocolDigest,
    configuration: runConfigurationEvidence(),
    manifest: [...manifest],
    rows: [...summaries],
    rowIdentities: [...identities],
    summary: summarizeRunRows(summaries, manifest),
    selectionDigest: null,
    replayChecks: [],
  };
}

export async function runRunCli(argv: readonly string[] = process.argv.slice(2)): Promise<RunReportProjection | null> {
  const options = parseRunArgs(argv);
  const protocolDigest = runProtocolDigest();
  if (options.worker) {
    await runRunWorker(workerRequest(JSON.parse(options.worker) as unknown));
    return null;
  }

  if (options.phase === "replay") {
    const source = await readReportProjection(options.replay!, protocolDigest);
    const replayDirectory = await mkdtemp(join(tmpdir(), "critpusher-run-replay-"));
    const spool = await createRowSpool();
    try {
      const replayInputs = await spoolReplayInputs(options.replay!, replayDirectory, source.manifest);
      const expectedById = new Map(source.rowIdentities.map((identity) => [identity.trial.id, identity]));
      const checks: ReplayCheck[] = new Array(source.manifest.length);
      const { summaries, identities } = await executeManifest(source.manifest, options.workers, spool, replayInputs, async (row, index) => {
        const expected = expectedById.get(row.trial.id);
        if (!expected) throw new Error(`Replay produced unplanned row: ${row.trial.id}`);
        const check = compareReplayRowIdentity(expected, runRowIdentity(row));
        checks[index] = check;
        if (!check.matched) {
          row.status = "invalid";
          row.failurePhase = "replay";
          row.error = check.error;
          await writeFile(spool.rowPath(index), JSON.stringify(row));
        }
      });
      const projection = buildProjection("replay", protocolDigest, source.manifest, summaries, identities);
      const summaryMatched = canonicalJson(source.summary) === canonicalJson(projection.summary);
      const summaryCheck = {
        trialId: "<summary>",
        matched: summaryMatched,
        expectedDigest: digest(source.summary),
        actualDigest: digest(projection.summary),
        error: summaryMatched ? null : "Replay summary differs from recorded denominators, metrics, or gates",
      };
      projection.replayChecks = [...checks, summaryCheck];
      projection.selectionDigest = source.selectionDigest;
      await writeReportStream(projection, source.manifest.map((_, index) => spool.rowPath(index)), options.output);
      if (checks.some((check) => !check.matched) || !summaryMatched) throw new Error("Deterministic replay evidence mismatch");
      if (projection.summary.outcomes.invalid) throw new Error("Replay reproduced invalid trial rows");
      return projection;
    } finally {
      await rm(replayDirectory, { recursive: true, force: true });
      await spool.dispose();
    }
  }

  let manifest: RunTrial[];
  if (options.phase === "smoke") {
    manifest = createManifest("smoke", {
      seeds: options.seeds,
      builds: options.builds,
      policies: options.policies,
      actions: options.actions,
    });
  } else manifest = createManifest(options.phase, { policies: options.policies, actions: options.actions });

  let frozenSelection: RunSelection | undefined;
  if (options.phase === "evaluate") {
    const selection = JSON.parse(await readFile(options.selection!, "utf8")) as unknown;
    validateFrozenSelection(selection, protocolDigest);
    frozenSelection = selection;
    if (canonicalJson(selection.evaluationManifest) !== canonicalJson(manifest))
      throw new Error("Evaluation manifest differs from the frozen selection");
  }
  if (options.phase === "screen" && options.selection) await rm(options.selection, { force: true });

  const spool = await createRowSpool();
  try {
    const { summaries, identities } = await executeManifest(manifest, options.workers, spool);
    const projection = buildProjection(options.phase, protocolDigest, manifest, summaries, identities);
    if (frozenSelection) {
      projection.selectionDigest = frozenSelection.digest;
    } else if (options.phase === "screen" && projection.summary.accepted) {
      const selection = freezeScreenSelection(projection);
      projection.selectionDigest = selection.digest;
      if (options.selection) {
        await mkdir(dirname(options.selection), { recursive: true });
        await writeFile(options.selection, JSON.stringify(selection, null, 2) + "\n");
      }
    }
    await writeReportStream(projection, manifest.map((_, index) => spool.rowPath(index)), options.output);

    if (projection.summary.outcomes.invalid) throw new Error(`${projection.summary.outcomes.invalid} invalid trial row(s); evidence retained`);
    if ((options.phase === "screen" || options.phase === "evaluate") && !projection.summary.accepted)
      throw new Error(`${options.phase} acceptance gates failed; evidence retained`);
    return projection;
  } finally {
    await spool.dispose();
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRunCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
