import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FightReport } from "../scripts/combat-contracts";
import { parseFightArgs, runFightCli } from "../scripts/combat-experiments";
import { FIGHT_VERSION } from "../scripts/combat-contracts";


describe("combat study CLI planning", () => {

  it("rejects malformed phase and action inputs before planning", () => {
    expect(() => parseFightArgs(["--phase", "unknown"])).toThrow(/phase/i);
    expect(() => parseFightArgs(["--actions", "0"])).toThrow(/actions/i);
  });

  it("rejects a Jev plan whose worst-case request budget is too small", () => {
    expect(() =>
      parseFightArgs([
        "--phase",
        "smoke",
        "--policies",
        "jev",
        "--max-jev-requests",
        "0",
      ]),
    ).toThrow(/requires 12 Jev requests/i);
  });

  it("requires a report destination before selection-only screening can execute", () => {
    expect(() => parseFightArgs(["--phase", "screen", "--selection", "selection.json"]))
      .toThrow(/--output/);
  });

  it("retains an invalid replay check instead of succeeding on an empty report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "critpusher-empty-replay-"));
    const source = join(directory, "empty.json");
    const output = join(directory, "replay.json");
    try {
      await writeFile(source, JSON.stringify({ version: FIGHT_VERSION, protocol: { plannedTrials: [] }, rows: [] }));
      await expect(runFightCli([
        "--phase", "replay", "--replay", source, "--output", output, "--max-jev-requests", "0",
      ])).rejects.toThrow();
      const report: FightReport = JSON.parse(await readFile(output, "utf8"));
      expect(report.status).toBe("invalid");
      expect(report.invalid).toBe(1);
      expect(report.replay[0]).toMatchObject({ matched: false, initialDigestMatch: false, ledgerMatch: false });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects historical first-fight-v1 replay with the engine-revision error", async () => {
    const directory = await mkdtemp(join(tmpdir(), "critpusher-v1-replay-"));
    const source = join(directory, "v1.json");
    const output = join(directory, "replay.json");
    const error = "Unsupported replay version: first-fight-v1; use its recorded engine revision";
    try {
      await writeFile(source, JSON.stringify({
        version: "first-fight-v1",
        protocol: { plannedTrials: [] },
        rows: [],
      }));
      await expect(runFightCli([
        "--phase", "replay", "--replay", source, "--output", output,
        "--max-jev-requests", "0",
      ])).rejects.toThrow(error);
      const report: FightReport = JSON.parse(await readFile(output, "utf8"));
      expect(report.replay[0]?.error).toBe(error);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("real-engine replay evidence", () => {
    let directory = "";
    let report: FightReport;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "critpusher-cli-"));
      report = await runFightCli([
        "--phase", "smoke", "--policies", "center,random", "--seeds", "42",
        "--actions", "1", "--workers", "1", "--output", join(directory, "report.json"),
      ]);
    }, 30_000);

    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("replays complete real-engine rows", async () => {
      const replay = await runFightCli([
        "--phase", "replay", "--replay", join(directory, "report.json"),
        "--max-jev-requests", "0",
      ]);
      for (const policy of ["center", "random"]) {
        const row = report.rows.find((candidate) => candidate.trial.policy === policy)!;
        expect(row.status).toBe("complete");
        expect(row.result).not.toBeNull();
        expect(replay.replay.find((check) => check.trialId === row.trial.id))
          .toMatchObject({ matched: true, ledgerMatch: true, outcomeMatch: true });
      }
    }, 30_000);

    it.each(["empty", "missing", "duplicate"])("rejects %s evidence", async (name) => {
      const center = report.rows.find((row) => row.trial.policy === "center")!;
      const random = report.rows.find((row) => row.trial.policy === "random")!;
      const rows = name === "empty" ? [] : name === "missing" ? [center] : [center, center];
      const source = join(directory, `${name}.json`);
      const output = join(directory, `${name}-replay.json`);
      await writeFile(source, JSON.stringify({ ...report, rows }));
      await expect(runFightCli([
        "--phase", "replay", "--replay", source, "--output", output,
        "--max-jev-requests", "0",
      ])).rejects.toThrow();
      const invalid: FightReport = JSON.parse(await readFile(output, "utf8"));
      expect(invalid.planned).toBe(report.planned);
      expect(invalid.replay.find((check) => check.trialId === random.trial.id)?.matched).toBe(false);
      expect(invalid.invalid).toBe(name === "missing" ? 1 : 2);
      expect(invalid.replay.find((check) => check.trialId === center.trial.id)?.matched)
        .toBe(name === "missing");
    }, 30_000);
  });
});
