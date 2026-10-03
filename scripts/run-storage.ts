import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chain from "stream-chain";
import { ignore } from "stream-json/filters/ignore.js";
import { pick } from "stream-json/filters/pick.js";
import { parser } from "stream-json/parser.js";
import { streamArray } from "stream-json/streamers/stream-array.js";
import { streamObject } from "stream-json/streamers/stream-object.js";
import { canonicalJson, createManifest, digest, runConfigurationEvidence, validateRunTrial } from "./run-protocol";
import { RUN_VERSION, type RunReportProjection, type RunRow, type RunRowIdentity, type RunRowSummary, type RunTrial } from "./run-contracts";

/** Stream complete raw rows in manifest order, retaining only bounded metadata
 * strings and the current file chunk. Pipeline owns backpressure and errors. */
export async function writeReportStream(
  report: RunReportProjection,
  rowSources: readonly string[],
  path?: string,
): Promise<void> {
  if (path) await mkdir(dirname(path), { recursive: true });
  async function* chunks(): AsyncGenerator<string | Buffer> {
    const header = {
      version: report.version,
      phase: report.phase,
      protocolDigest: report.protocolDigest,
      configuration: report.configuration,
      manifest: report.manifest,
    };
    yield `${JSON.stringify(header).slice(0, -1)},"rows":[`;
    for (let index = 0; index < rowSources.length; index++) {
      if (index) yield ",";
      yield* createReadStream(rowSources[index]!);
    }
    const footer = {
      summary: report.summary,
      selectionDigest: report.selectionDigest,
      replayChecks: report.replayChecks,
    };
    yield `],${JSON.stringify(footer).slice(1)}\n`;
  }
  await pipeline(
    Readable.from(chunks()),
    path ? createWriteStream(path) : process.stdout,
    { end: path !== undefined },
  );
}

/** Stream raw rows from an arbitrary readable (path- or chunk-fed) one at a time,
 * never retaining a prior row in memory. `onRow` receives the row and its zero-based
 * manifest order index. */
export async function readRowsStream(
  stream: Readable,
  onRow: (row: RunRow, index: number) => void | Promise<void>,
): Promise<number> {
  const pipeline = chain([stream, parser(), pick({ filter: "rows" }), streamArray()]);
  let count = 0;
  try {
    for await (const chunk of pipeline as AsyncIterable<{ key: number; value: unknown }>) {
      const row = chunk.value as RunRow;
      if (!row || typeof row !== "object" || Array.isArray(row) || !row.trial) throw new Error("Malformed trial row");
      await onRow(row, count);
      count++;
    }
  } finally {
    pipeline.destroy();
  }
  return count;
}

/** Stream each raw row of a recorded report one at a time, never retaining a prior row
 * in memory. */
export async function readReportRows(
  path: string,
  onRow: (row: RunRow, index: number) => void | Promise<void>,
): Promise<number> {
  return readRowsStream(createReadStream(path), onRow);
}

/** Read report metadata (everything except the raw `rows` array) from an arbitrary
 * readable with bounded memory: the `rows` field is filtered out before assembly. */
export async function readMetadataStream(stream: Readable): Promise<RunReportProjection> {
  const pipeline = chain([stream, parser(), ignore({ filter: "rows" }), streamObject()]);
  const metadata = {} as Record<string, unknown>;
  try {
    for await (const chunk of pipeline as AsyncIterable<{ key: string; value: unknown }>) {
      if (chunk.key !== undefined) metadata[chunk.key] = chunk.value;
    }
  } finally {
    pipeline.destroy();
  }
  return metadata as unknown as RunReportProjection;
}

/** Read a report's metadata (everything except the raw `rows` array) with bounded
 * memory. */
export async function readReportMetadata(path: string): Promise<RunReportProjection> {
  return readMetadataStream(createReadStream(path));
}

/** Reject duplicate/unplanned/malformed rows as they stream, mirroring
 * `validateManifestRows` without requiring the full rows array in memory. */
export function makeRowValidator(manifest: readonly RunTrial[]): {
  validate: (row: RunRow) => void;
  finish: () => void;
} {
  const planned = new Map<string, RunTrial>();
  for (const trial of manifest) {
    validateRunTrial(trial);
    if (planned.has(trial.id)) throw new Error(`Duplicate planned trial: ${trial.id}`);
    planned.set(trial.id, trial);
  }
  const seen = new Set<string>();
  return {
    validate(row) {
      if (!row || !row.trial) throw new Error("Malformed trial row");
      if (seen.has(row.trial.id)) throw new Error(`Duplicate trial row: ${row.trial.id}`);
      const trial = planned.get(row.trial.id);
      if (!trial || canonicalJson(trial) !== canonicalJson(row.trial)) throw new Error(`Unplanned trial row: ${row.trial.id}`);
      if (!["won", "lost", "unfinished", "invalid"].includes(row.status)) throw new Error(`Invalid row outcome: ${row.trial.id}`);
      seen.add(row.trial.id);
    },
    finish() {
      if (seen.size !== planned.size) throw new Error(`Missing planned rows: ${[...planned.keys()].filter((id) => !seen.has(id)).join(",")}`);
    },
  };
}

/** Stream a recorded report into a bounded projection: metadata plus compact row
 * summaries and full-row identity digests in manifest order. Raw rows (with trace,
 * decisions, shops, finalPhysical) are never retained or joined into one string. */
export async function readReportProjection(path: string, protocolDigest: string): Promise<RunReportProjection> {
  const metadata = await readReportMetadata(path);
  if (!metadata || typeof metadata !== "object") throw new Error("Replay input must be a run report object");
  if (metadata.version !== RUN_VERSION) throw new Error(`Unsupported replay version: ${String(metadata.version)}`);
  if (!metadata.phase || !["smoke", "screen", "evaluate", "replay"].includes(metadata.phase))
    throw new Error("Replay report has an invalid phase");
  if (metadata.protocolDigest !== protocolDigest) throw new Error("Replay protocol/config digest differs from this engine");
  if (!metadata.configuration || !Array.isArray(metadata.manifest) || !metadata.summary)
    throw new Error("Replay report is incomplete");
  if (canonicalJson(metadata.configuration) !== canonicalJson(runConfigurationEvidence()))
    throw new Error("Replay configuration evidence differs from this engine");
  if (metadata.phase === "screen" && canonicalJson(metadata.manifest) !== canonicalJson(createManifest("screen")))
    throw new Error("Recorded screen manifest is not the full preregistered cohort");
  if (metadata.phase === "evaluate" && canonicalJson(metadata.manifest) !== canonicalJson(createManifest("evaluate")))
    throw new Error("Recorded evaluation manifest is not the full held-out cohort");
  const manifest = metadata.manifest as RunTrial[];
  const validator = makeRowValidator(manifest);
  const rows: RunRowSummary[] = [];
  const rowIdentities: RunRowIdentity[] = [];
  await readReportRows(path, (row, index) => {
    validator.validate(row);
    rows[index] = {
      trial: row.trial,
      status: row.status,
      error: row.error,
      failurePhase: row.failurePhase,
      encounters: row.encounters,
      final: row.final,
      finalDigest: row.finalDigest,
    };
    rowIdentities[index] = { trial: row.trial, digest: digest(row) };
  });
  validator.finish();
  return {
    version: metadata.version,
    phase: metadata.phase,
    protocolDigest: metadata.protocolDigest,
    configuration: metadata.configuration,
    manifest,
    rows,
    rowIdentities,
    summary: metadata.summary,
    selectionDigest: metadata.selectionDigest,
    replayChecks: metadata.replayChecks ?? [],
  };
}

/** Stream a recorded report and spool each row's compact replay decisions/shops to a
 * per-trial file under `directory`. Returns a map of trial id to replay file path. */
export async function spoolReplayInputs(
  reportPath: string,
  directory: string,
  manifest: readonly RunTrial[],
): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  const byId = new Map(manifest.map((trial) => [trial.id, trial]));
  await readReportRows(reportPath, async (row, index) => {
    const trial = byId.get(row.trial.id);
    if (!trial || canonicalJson(trial) !== canonicalJson(row.trial)) throw new Error(`Replay row trial mismatch: ${row.trial.id}`);
    const path = join(directory, `${index}.json`);
    await writeFile(path, JSON.stringify({ trial: row.trial, decisions: row.decisions, shops: row.shops }));
    paths.set(row.trial.id, path);
  });
  return paths;
}

export interface RowSpool {
  readonly directory: string;
  rowPath(index: number): string;
  readRow(index: number): Promise<RunRow>;
  dispose(): Promise<void>;
}

/** Own a parent-scoped temporary directory for worker row spills. Workers write their
 * full raw row to `rowPath(index)` and return only the compact identity on stdout; the
 * parent re-reads the raw row for reporting and replay. */
export async function createRowSpool(): Promise<RowSpool> {
  const directory = await mkdtemp(join(tmpdir(), "critpusher-run-rows-"));
  const spool: RowSpool = {
    directory,
    rowPath(index) {
      return join(directory, `${index}.json`);
    },
    async readRow(index) {
      return JSON.parse(await readFile(this.rowPath(index), "utf8")) as RunRow;
    },
    async dispose() {
      await rm(directory, { recursive: true, force: true });
    },
  };
  return spool;
}
