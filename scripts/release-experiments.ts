import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import {
  runReleaseTrial,
  summarizeReleases,
  type ReleasePolicy,
  type ReleaseResult,
  type ReleaseTrial,
} from "./release-trial";

const { values } = parseArgs({
  options: {
    seeds: { type: "string", default: "7,42,1337" },
    densities: { type: "string", default: "300" },
    coins: { type: "string", default: "1,2,3" },
    policies: { type: "string", default: "center,random,rule,jev" },
    modes: { type: "string", default: "chute" },
    patterns: { type: "string", default: "sequential" },
    spacings: { type: "string", default: "1.5" },
    "enemy-coins": { type: "string", default: "1" },
    releases: { type: "string", default: "30" },
    "coin-budget": { type: "string" },
    stroke: { type: "string", default: "2" },
    front: { type: "string", default: "4" },
    workers: { type: "string", default: "4" },
    "max-jev-requests": { type: "string", default: "600" },
    output: { type: "string" },
    worker: { type: "string" },
  },
});

function numeric(
  value: string,
  min: number,
  max: number,
  integer = true,
): number {
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < min ||
    number > max ||
    (integer && !Number.isInteger(number))
  )
    throw new Error(`Invalid numeric option: ${value}`);
  return number;
}

function plan(): ReleaseTrial[] {
  const seeds = [
    ...new Set(values.seeds!.split(",").map((v) => numeric(v, 0, 2147483647))),
  ];
  const densities = [
    ...new Set(values.densities!.split(",").map((v) => numeric(v, 1, 1000))),
  ];
  const coins = [
    ...new Set(values.coins!.split(",").map((v) => numeric(v, 1, 6))),
  ];
  const policies = [...new Set(values.policies!.split(","))];
  const modes = [...new Set(values.modes!.split(","))];
  if (policies.some((p) => !["center", "random", "rule", "jev"].includes(p)))
    throw new Error("Unknown release policy");
  if (modes.some((m) => m !== "chute" && m !== "back-row"))
    throw new Error("Unknown feed mode");
  const patterns = [...new Set(values.patterns!.split(","))];
  if (patterns.some((p) => !["sequential", "stack", "flanks"].includes(p)))
    throw new Error("Unknown release pattern");
  if (patterns.some((p) => p !== "sequential")) {
    if (modes.some((m) => m !== "chute"))
      throw new Error("Simultaneous stacks require chute mode");
    if (coins.some((n) => n !== 1 && n !== 3))
      throw new Error("Stack experiments require one or three player coins");
  }
  const spacings = [
    ...new Set(
      values.spacings!.split(",").map((v) => numeric(v, 0.7, 3, false)),
    ),
  ];
  const enemyCounts = [
    ...new Set(values["enemy-coins"]!.split(",").map((v) => numeric(v, 1, 3))),
  ];
  if (enemyCounts.some((n) => n !== 1 && n !== 3))
    throw new Error("Enemy chutes require one or three coins");
  const releases = numeric(values.releases!, 1, 300);
  const coinBudget =
    values["coin-budget"] === undefined
      ? undefined
      : numeric(values["coin-budget"], 1, 1800);
  if (coinBudget !== undefined && coins.some((n) => coinBudget % n !== 0))
    throw new Error("Equal coin budget must be divisible by every burst size");
  const stroke = numeric(values.stroke!, 0, 4, false);
  const shelfFront = numeric(values.front!, 2.5, 4, false);
  const trials: ReleaseTrial[] = [];
  for (const density of densities)
    for (const seed of seeds)
      for (const coinsPerRelease of coins)
        for (const mode of modes)
          for (const pattern of patterns)
            for (const spacing of pattern === "flanks" ? spacings : [0])
              for (const enemyCoins of pattern === "flanks" ? enemyCounts : [0])
                for (const policy of policies)
                  trials.push({
                    density,
                    seed,
                    coinsPerRelease,
                    mode: mode as ReleaseTrial["mode"],
                    pattern: pattern as ReleaseTrial["pattern"],
                    spacing,
                    enemyCoins,
                    policy: policy as ReleasePolicy,
                    releases:
                      coinBudget === undefined
                        ? releases
                        : coinBudget / coinsPerRelease,
                    stroke,
                    shelfFront,
                  });
  const required = trials
    .filter((t) => t.policy === "jev")
    .reduce((n, t) => n + t.releases, 0);
  const cap = numeric(values["max-jev-requests"]!, 0, 10000);
  if (required > cap)
    throw new Error(
      `Plan requires ${required} Jev requests; cap is ${cap}. Raise --max-jev-requests explicitly.`,
    );
  if (required && !process.env.TYPESAFE_API_KEY)
    throw new Error(
      "TYPESAFE_API_KEY is required for Jev trials; no fallback policy is used",
    );
  return trials;
}

function summarize(rows: ReleaseResult[]) {
  const groups = new Map<string, ReleaseResult[]>();
  for (const row of rows) {
    const key = `${row.density}/${row.mode}/${row.pattern ?? "sequential"}/${row.policy}/${row.coinsPerRelease}/${row.spacing ?? 0}/${row.enemyCoins ?? 0}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, trials]) => {
      const windows = trials.flatMap((t) => t.windows);
      const metrics = summarizeReleases(windows);
      return {
        group,
        trials: trials.length,
        releases: metrics.releases,
        hitRate: Number(metrics.hitRate.toFixed(3)),
        idleHitRate: Number(metrics.idleHitRate.toFixed(3)),
        everySeedMeetsTarget: trials.every(
          (t) => summarizeReleases(t.windows).meetsTarget,
        ),
        minimumSeedHitRate: Math.min(
          ...trials.map((t) => summarizeReleases(t.windows).hitRate),
        ),
        pooledTargetMet: metrics.meetsTarget,
        collectedPerCoin: Number(metrics.collectedPerCoin.toFixed(3)),
        additionalCollections: metrics.additionalCollections,
        maximumDryReleases: Math.max(
          ...trials.map((t) => summarizeReleases(t.windows).longestDry),
        ),
        waitingCollections: windows.reduce((n, w) => n + w.waitingCollected, 0),
        meanSecondsPerRelease: Number(
          (
            trials.reduce((n, t) => n + t.elapsedSeconds, 0) / windows.length
          ).toFixed(3),
        ),
        peakActive: Math.max(...trials.map((t) => t.peakActive)),
        meanSettledActive: Number(
          (
            trials.reduce((n, t) => n + t.settledActive, 0) / trials.length
          ).toFixed(1),
        ),
        warmupCollected: trials.reduce((n, t) => n + t.warmupCollected, 0),
        acceptedPlayer: trials.reduce((n, t) => n + t.acceptedPlayer, 0),
        acceptedEnemy: trials.reduce((n, t) => n + t.acceptedEnemy, 0),
        collections: {
          player: trials.reduce((n, t) => n + t.collections.player, 0),
          enemy: trials.reduce((n, t) => n + t.collections.enemy, 0),
          starting: trials.reduce((n, t) => n + t.collections.starting, 0),
        },
        enemyOnlyHitRate: Number(
          (
            windows.filter((w) => w.enemyOnlyCollected > 0).length /
            windows.length
          ).toFixed(3),
        ),
        totalMinusEnemyOnly: trials.reduce(
          (n, t) => n + t.totalMinusEnemyOnly,
          0,
        ),
        playerCollectionHitRate: Number(
          (
            windows.filter((w) => w.collections.player > 0).length /
            windows.length
          ).toFixed(3),
        ),
        enemyCollectionHitRate: Number(
          (
            windows.filter((w) => w.collections.enemy > 0).length /
            windows.length
          ).toFixed(3),
        ),
      };
    });
}

async function main(): Promise<void> {
  if (values.worker) {
    const trial: ReleaseTrial = JSON.parse(values.worker);
    process.stdout.write(JSON.stringify(await runReleaseTrial(trial)));
    return;
  }
  const trials = plan();
  const workers = numeric(values.workers!, 1, 8);
  const rows: ReleaseResult[] = [];
  const failures: Array<{ trial: ReleaseTrial; message: string }> = [];
  const started = performance.now();
  let next = 0;
  const execute = promisify(execFile);
  console.log(
    `Running ${trials.length} paired release trials on ${Math.min(workers, trials.length)} workers; target >=90% of releases with a payout within one cycle.`,
  );
  const report = () => ({
    status: failures.length
      ? "failed"
      : rows.length === trials.length
        ? "complete"
        : "running",
    protocol: {
      lanes: 5,
      warmupTicks: 720,
      cycleTicks: 144,
      burstIntervalTicks: 10,
      hitTarget: 0.9,
      budget:
        values["coin-budget"] === undefined
          ? "equal releases"
          : "equal player input coins; enemy inputs reported separately",
      plannedTrials: trials.length,
      model: "jev-1.13.0",
      notes: [
        "Only observed current lane state and up to six past release outcomes reach policies; no future physics or seed oracle.",
        "Each release window begins with its first physical coin and spans exactly one pusher cycle. Windows never overlap.",
        "Sequential bursts feed at six coins per second; stacks and flanks release separate non-overlapping bodies simultaneously.",
        "Deliberate pre-release waiting and its payouts are reported separately and cannot increase release hit rate.",
        "Each trial steps an identical no-input pile alongside the player run, including exactly the same deliberate waits.",
        "Flank trials also run an enemy-only control with identical flank positions, inputs and timing; source-labelled payouts are physical provenance, not combat effects.",
        "No-input differences expose autonomous payouts, not proof that a specific preceding coin caused a spill.",
        "Jev probabilities describe action preference, not empirically calibrated payout probability.",
        "A pooled 90% hit rate is not every-seed success or statistical proof; per-seed windows are retained.",
        "Invalid trials retain their errors without retry or budget reduction; independent planned trials still run and the command exits nonzero.",
      ],
    },
    elapsedSeconds: (performance.now() - started) / 1000,
    inputTokens: rows.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: rows.reduce((n, r) => n + r.outputTokens, 0),
    summary: summarize(rows),
    failures,
    rows,
  });
  // Serialize writes so completed workers cannot replace newer evidence with older data.
  let save = Promise.resolve();
  const persist = () => {
    if (!values.output) return;
    const json = JSON.stringify(report(), null, 2) + "\n";
    save = save.then(() => writeFile(values.output!, json));
  };
  persist();
  await Promise.all(
    Array.from({ length: Math.min(workers, trials.length) }, async () => {
      while (next < trials.length) {
        const trial = trials[next++]!;
        try {
          const { stdout, stderr } = await execute(
            process.execPath,
            [
              fileURLToPath(import.meta.resolve("tsx/cli")),
              fileURLToPath(import.meta.url),
              "--worker",
              JSON.stringify(trial),
            ],
            { maxBuffer: 32 * 1024 * 1024, timeout: 900000 },
          );
          if (stderr) process.stderr.write(stderr);
          const result = JSON.parse(stdout) as ReleaseResult;
          rows.push(result);
          const metrics = summarizeReleases(result.windows);
          console.log(
            `${rows.length}/${trials.length}: ${trial.density} coins, ${trial.policy}, ${trial.pattern}, player ${trial.coinsPerRelease}, flank ${trial.enemyCoins}, spacing ${trial.spacing}, seed ${trial.seed}: ${metrics.hitCount}/${metrics.releases} paid, ${metrics.longestDry} longest dry`,
          );
        } catch (error) {
          failures.push({
            trial,
            message: error instanceof Error ? error.message : String(error),
          });
          console.error(
            `Invalid trial: ${JSON.stringify(trial)}; ${failures.at(-1)!.message}`,
          );
        }
        persist();
      }
    }),
  );
  await save;
  console.table(report().summary);
  if (failures.length)
    throw new Error(
      `${failures.length} trial(s) failed; completed evidence retained${values.output ? ` in ${values.output}` : ""}. ${failures[0]!.message}`,
    );
  console.log(
    `Completed ${rows.length} paired trials; ${report().inputTokens} Jev input tokens${values.output ? `; evidence ${values.output}` : ""}.`,
  );
}
await main();
