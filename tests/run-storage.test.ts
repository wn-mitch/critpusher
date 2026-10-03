import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { RunReportProjection, RunRow, RunTrial } from "../scripts/run-contracts";
import { ACTION_LIMIT, canonicalJson, createManifest, runConfigurationEvidence } from "../scripts/run-protocol";
import { runRowIdentity, summarizeRunRows, toRunRowSummary } from "../scripts/run-report";
import { createRowSpool, readReportProjection, readRowsStream, writeReportStream } from "../scripts/run-storage";
import { invalidRunRow } from "../scripts/run-trial";

const PROTOCOL = "storage-test-protocol";

function sampleRows(): { manifest: RunTrial[]; rows: RunRow[] } {
  const manifest = createManifest("smoke", { seeds: [42, 7], builds: ["collector"], policies: ["rule"], actions: ACTION_LIMIT });
  const rowA = invalidRunRow(manifest[0]!, "sword ✂ snowman ☃");
  rowA.trace.push({ kind: "entry", encounterIndex: 0, state: { label: "λambda 日本語" } });
  rowA.finalPhysical = { note: "🎱 eight-ball", depth: 3 };
  const rowB = invalidRunRow(manifest[1]!, "potion 🍵 recovery");
  return { manifest, rows: [rowA, rowB] };
}

function sampleProjection(manifest: RunTrial[], rows: RunRow[]): RunReportProjection {
  const summaries = rows.map(toRunRowSummary);
  return {
    version: "mvp3-run-v1",
    phase: "smoke",
    protocolDigest: PROTOCOL,
    configuration: runConfigurationEvidence(),
    manifest: [...manifest],
    rows: summaries,
    rowIdentities: rows.map(runRowIdentity),
    summary: summarizeRunRows(summaries, manifest),
    selectionDigest: null,
    replayChecks: [],
  };
}

describe("whole-run streaming storage", () => {
  it("round-trips raw rows, summary, and full-row identities in manifest order", async () => {
    const { manifest, rows } = sampleRows();
    const projection = sampleProjection(manifest, rows);
    const directory = await mkdtemp(join(tmpdir(), "critpusher-storage-test-"));
    const spool = await createRowSpool();
    try {
      await writeFile(spool.rowPath(0), JSON.stringify(rows[0]));
      await writeFile(spool.rowPath(1), JSON.stringify(rows[1]));
      const reportPath = join(directory, "report.json");
      await writeReportStream(projection, [spool.rowPath(0), spool.rowPath(1)], reportPath);

      const roundtrip = await readReportProjection(reportPath, PROTOCOL);
      expect(roundtrip.rowIdentities.map((identity) => identity.trial.id)).toEqual(manifest.map((trial) => trial.id));
      expect(roundtrip.rowIdentities.map((identity) => identity.digest)).toEqual(rows.map((row) => runRowIdentity(row).digest));
      expect(canonicalJson(roundtrip.summary)).toBe(canonicalJson(projection.summary));
      expect(roundtrip.rows.map((row) => row.status)).toEqual(["invalid", "invalid"]);
      expect(roundtrip.rows.map((row) => row.error)).toEqual(["sword ✂ snowman ☃", "potion 🍵 recovery"]);
    } finally {
      await spool.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads rows across arbitrary UTF-8 chunk boundaries without losing order or fields", async () => {
    const { manifest, rows } = sampleRows();
    const serialized = Buffer.from(JSON.stringify({ rows, manifest, summary: {} }), "utf8");
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < serialized.length; offset += 3) chunks.push(serialized.subarray(offset, offset + 3));
    const collected: RunRow[] = [];
    const count = await readRowsStream(Readable.from(chunks), (row, index) => { collected[index] = row; });
    expect(count).toBe(2);
    expect(canonicalJson(collected[0])).toBe(canonicalJson(rows[0]));
    expect(canonicalJson(collected[1])).toBe(canonicalJson(rows[1]));
  });

  it("rejects truncated and malformed row streams", async () => {
    await expect(readRowsStream(Readable.from([Buffer.from('{"rows":[')]), () => {})).rejects.toThrow(/Parser/);
    await expect(readRowsStream(Readable.from([Buffer.from("not json at all")]), () => {})).rejects.toThrow(/Parser/);
  });

  it.each(["missing-source", "destination-directory"])(
    "rejects %s I/O errors rather than hanging or emitting an unhandled error", async (failure) => {
      const { manifest, rows } = sampleRows();
      const directory = await mkdtemp(join(tmpdir(), "critpusher-storage-error-"));
      const spool = await createRowSpool();
      try {
        await writeFile(spool.rowPath(0), JSON.stringify(rows[0]));
        await writeFile(spool.rowPath(1), JSON.stringify(rows[1]));
        const sources = failure === "missing-source"
          ? [join(directory, "missing.json"), spool.rowPath(1)]
          : [spool.rowPath(0), spool.rowPath(1)];
        const destination = failure === "destination-directory"
          ? directory
          : join(directory, "report.json");
        await expect(writeReportStream(sampleProjection(manifest, rows), sources, destination))
          .rejects.toMatchObject({ code: failure === "missing-source" ? "ENOENT" : "EISDIR" });
      } finally {
        await spool.dispose();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects a report whose protocol digest or configuration differs from this engine", async () => {
    const { manifest, rows } = sampleRows();
    const projection = sampleProjection(manifest, rows);
    const directory = await mkdtemp(join(tmpdir(), "critpusher-storage-test-"));
    const spool = await createRowSpool();
    try {
      await writeFile(spool.rowPath(0), JSON.stringify(rows[0]));
      await writeFile(spool.rowPath(1), JSON.stringify(rows[1]));
      const reportPath = join(directory, "report.json");
      await writeReportStream(projection, [spool.rowPath(0), spool.rowPath(1)], reportPath);

      await expect(readReportProjection(reportPath, "different-protocol")).rejects.toThrow(/protocol\/config digest/);
      const tampered: RunReportProjection = { ...projection, configuration: { ...projection.configuration, digest: "tampered" } };
      const tamperedPath = join(directory, "tampered.json");
      await writeReportStream(tampered, [spool.rowPath(0), spool.rowPath(1)], tamperedPath);
      await expect(readReportProjection(tamperedPath, PROTOCOL)).rejects.toThrow(/configuration evidence differs/);
    } finally {
      await spool.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
