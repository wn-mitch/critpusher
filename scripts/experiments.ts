import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import process from "node:process";
import {
  runTrial,
  SETTLE_TICKS,
  TAIL_TICKS,
  type Result,
  type Strategy,
  type Trial,
} from "./experiment-trial";

const { values } = parseArgs({
  options: {
    suite: { type: "string", default: "smoke" },
    seeds: { type: "string", default: "7,42,1337" },
    density: { type: "string", default: "300" },
    stroke: { type: "string", default: "2" },
    front: { type: "string", default: "4" },
    drops: { type: "string", default: "30" },
    interval: { type: "string", default: "72" },
    workers: { type: "string", default: "4" },
    output: { type: "string" },
    worker: { type: "string" },
  },
});

function number(
  value: string,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < minimum ||
    n > maximum ||
    (integer && !Number.isInteger(n))
  )
    throw new Error(`Invalid numeric argument: ${value}`);
  return n;
}

function plan(): Trial[] {
  const seeds = values
    .seeds!.split(",")
    .map((s) => number(s, 0, 2147483647, true));
  const base: Trial = {
    variant: "candidate",
    seed: seeds[0]!,
    density: number(values.density!, 1, 1000, true),
    stroke: number(values.stroke!, 0, 4),
    shelfFront: number(values.front!, 2.5, 4),
    mode: "chute",
    strategy: "center",
    lane: 0,
    phase: 0,
    drops: number(values.drops!, 1, 1800, true),
    interval: number(values.interval!, 10, 600, true),
  };
  const trials: Trial[] = [];
  if (values.suite === "smoke")
    return [
      base,
      { ...base, mode: "back-row", strategy: "target" },
      { ...base, mode: "back-row", strategy: "none" },
    ];
  if (values.suite === "throughput") {
    const variants = [
      { variant: "baseline", stroke: 1.4, shelfFront: 4 },
      { variant: "stroke", stroke: 2, shelfFront: 4 },
      { variant: "short", stroke: 1.4, shelfFront: 3 },
      { variant: "combined", stroke: 2, shelfFront: 3 },
    ];
    for (const variant of variants)
      for (const density of [200, 300, 400])
        for (const seed of seeds)
          for (const strategy of ["none", "center"] as const)
            trials.push({ ...base, ...variant, density, seed, strategy });
  } else if (values.suite === "skill") {
    const strategies: Strategy[] = [
      "none",
      "target",
      "opposite",
      "center",
      "alternating",
      "random",
    ];
    for (const seed of seeds)
      for (const lane of [0, 2])
        for (const mode of ["chute", "back-row"] as const)
          for (const strategy of strategies)
            trials.push({ ...base, seed, lane, mode, strategy });
  } else if (values.suite === "timing") {
    for (const seed of seeds)
      for (const phase of [0, 36, 72, 108])
        for (const strategy of ["none", "center"] as const)
          trials.push({ ...base, seed, phase, strategy });
  } else if (values.suite === "stability") {
    for (const seed of seeds)
      for (const mode of ["chute", "back-row"] as const)
        trials.push({
          ...base,
          seed,
          mode,
          strategy: "alternating",
          drops: 900,
          interval: 10,
        });
  } else throw new Error(`Unknown suite: ${values.suite}`);
  return trials;
}

const mean = (values: number[]): number | null =>
  values.length
    ? Number((values.reduce((sum, n) => sum + n, 0) / values.length).toFixed(3))
    : null;
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const pairKey = (r: Result): string =>
  [
    r.variant,
    r.seed,
    r.density,
    r.stroke,
    r.shelfFront,
    r.phase,
    r.lane,
    r.mode,
    r.drops,
    r.interval,
  ].join("/");

// Restricted mean target delay in drop windows: unreleased targets and payouts
// after feeding both cost the full budget. This avoids survivor-only averages.
function targetDelay(row: Result): number | null {
  if (!row.targetCount) return null;
  const collectedDelay = row.targetPayouts.reduce(
    (sum, event) => sum + Math.min(row.drops, (event.tick + 1) / row.interval),
    0,
  );
  return (
    (collectedDelay + (row.targetCount - row.targetCollected) * row.drops) /
    row.targetCount
  );
}

function comparePlacement(rows: Result[]) {
  const comparisons = [];
  for (const mode of ["chute", "back-row"] as const) {
    const targets = rows.filter(
      (row) => row.mode === mode && row.strategy === "target",
    );
    for (const against of [
      "none",
      "opposite",
      "center",
      "alternating",
      "random",
    ] as const) {
      const controls = new Map(
        rows
          .filter((row) => row.strategy === against)
          .map((row) => [pairKey(row), row]),
      );
      const advantages: number[] = [];
      const localAdvantages: number[] = [];
      let excluded = 0;
      for (const target of targets) {
        const control = controls.get(pairKey(target));
        if (
          !control ||
          !target.targetCount ||
          target.rejected ||
          control.rejected
        ) {
          excluded++;
          continue;
        }
        if (JSON.stringify(target.targets) !== JSON.stringify(control.targets))
          throw new Error("Paired trial targets differ before player input");
        advantages.push(targetDelay(control)! - targetDelay(target)!);
        if (target.localAdvance !== null && control.localAdvance !== null)
          localAdvantages.push(target.localAdvance - control.localAdvance);
      }
      if (targets.length)
        comparisons.push({
          mode,
          against,
          pairedTrials: advantages.length,
          excluded,
          fasterByOneDrop: advantages.filter((n) => n >= 1).length,
          withinOneDrop: advantages.filter((n) => n > -1 && n < 1).length,
          slowerByOneDrop: advantages.filter((n) => n <= -1).length,
          meanDropWindowAdvantage: mean(advantages),
          meanThreePushAdvanceAdvantage: mean(localAdvantages),
        });
    }
  }
  return comparisons;
}
function summarize(rows: Result[]) {
  const controls = new Map(
    rows.filter((r) => r.strategy === "none").map((r) => [pairKey(r), r]),
  );
  const groups = new Map<string, Result[]>();
  for (const r of rows) {
    const key = [
      r.variant,
      r.density,
      r.mode,
      r.strategy,
      `phase${r.phase}`,
    ].join("/");
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }
  return [...groups].map(([group, trials]) => ({
    group,
    trials: trials.length,
    collected: mean(trials.map((r) => r.collected)),
    addedOverIdle: mean(
      trials.flatMap((r) => {
        const c = controls.get(pairKey(r));
        return c ? [r.collected - c.collected] : [];
      }),
    ),
    firstPayoutMedian: median(
      trials.flatMap((r) =>
        r.firstPayoutDrop === null ? [] : [r.firstPayoutDrop],
      ),
    ),
    noPayoutTrials: trials.filter((r) => r.firstPayoutDrop === null).length,
    longestDryMedian: median(trials.map((r) => r.longestDry)),
    paidWindows: mean(trials.map((r) => r.paidDropWindows)),
    targetCollected: mean(trials.map((r) => r.targetCollected)),
    targetDelay: mean(
      trials.flatMap((row) => {
        const delay = targetDelay(row);
        return delay === null ? [] : [delay];
      }),
    ),
    targetTrialsWon: trials.filter((r) => r.targetCollected > 0).length,
    targetFirstMedian: median(
      trials.flatMap((r) =>
        r.firstTargetDrop === null ? [] : [r.firstTargetDrop],
      ),
    ),
    localAdvance: mean(
      trials.flatMap((r) => (r.localAdvance === null ? [] : [r.localAdvance])),
    ),
    smallBursts: mean(trials.map((r) => r.bursts.filter((n) => n <= 3).length)),
    largestBurst: Math.max(...trials.flatMap((r) => r.bursts), 0),
    lost: trials.reduce((sum, r) => sum + r.lost + r.setupLost, 0),
    rejected: trials.reduce((sum, r) => sum + r.rejected, 0),
  }));
}

async function main(): Promise<void> {
  if (values.worker) {
    const jobs: Trial[] = JSON.parse(values.worker);
    const rows: Result[] = [];
    for (const trial of jobs) rows.push(await runTrial(trial));
    process.stdout.write(JSON.stringify(rows));
    return;
  }
  const trials = plan();
  const workers = Math.min(trials.length, number(values.workers!, 1, 8, true));
  const chunks = Array.from({ length: workers }, (_, i) =>
    trials.filter((_, index) => index % workers === i),
  );
  console.log(
    `Running ${trials.length} matched fixed-step trials on ${workers} workers.`,
  );
  const execute = promisify(execFile);
  const started = performance.now();
  const results = await Promise.all(
    chunks.map(async (chunk, index) => {
      const { stdout, stderr } = await execute(
        process.execPath,
        [
          fileURLToPath(import.meta.resolve("tsx/cli")),
          fileURLToPath(import.meta.url),
          "--worker",
          JSON.stringify(chunk),
        ],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      if (stderr) process.stderr.write(stderr);
      console.log(`Worker ${index + 1}: ${chunk.length} trials complete.`);
      return JSON.parse(stdout) as Result[];
    }),
  );
  const rows = results.flat();
  const summary = summarize(rows);
  const report = {
    protocol: {
      suite: values.suite,
      fixedDt: 1 / 60,
      settleTicks: SETTLE_TICKS,
      tailTicks: TAIL_TICKS,
      notes: [
        "All trial inputs pinned independently of interactive defaults.",
        "First 12 seconds of warmup payouts excluded; no-input controls continue the same machine for the same duration.",
        "First-payout and first-target medians exclude censored trials; absence counts are reported separately.",
        "Payout windows count actual spills, not causal credit. addedOverIdle is the paired total difference.",
        "Placement strategies use visible initial targets only, not future simulation outcomes.",
        "Sides are balanced on the same seeded piles, not geometrically mirrored snapshots.",
        "Direct back-row feed is an isolation experiment, not the normal interactive chute.",
        "Raw accepted/rejected budgets, target availability, all payout steps and ids retained for audit.",
        "Target delay is mean release time in drop windows, capped at the input budget for unreleased or tail-only targets. Lower is better.",
        "Placement comparisons match seed/geometry/density/side/timing/feed and identical initial target ids/positions; rejected budgets are excluded.",
        "A meaningful paired advantage is at least one drop window; smaller differences are reported as within one drop.",
        "Burst metrics use a 39-tick quiet gap and 180-tick cap; no rewards are generated by grouping.",
      ],
    },
    elapsedSeconds: (performance.now() - started) / 1000,
    summary,
    placementComparisons: comparePlacement(rows),
    rows,
  };
  if (values.output)
    await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  console.table(summary);
  if (report.placementComparisons.length)
    console.table(report.placementComparisons);
  console.log(
    `Finished in ${report.elapsedSeconds.toFixed(1)}s${values.output ? `; raw results: ${values.output}` : ""}`,
  );
}
await main();
