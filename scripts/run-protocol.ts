import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DEFAULT_CHUTES } from "../src/chutes";
import { BOMB_DAMAGE, DEFAULT_ENCOUNTER_CONFIG } from "../src/combat/config";
import { ENCOUNTERS, INTER_ENCOUNTER_HEAL, MAX_EFFECT_LEVEL, MAX_PLAYER_CHUTES, MAX_STICKERS, SHOP_OFFERS, STARTERS, VICTORY_REWARD } from "../src/run/catalog";
import { resolveBuild } from "../src/run/modifiers";
import { DEFAULT_TUNING } from "../src/simulation/config";
import { SCREEN_SEEDS, EVALUATION_SEEDS, canonicalJson, digest, validateSeeds } from "./combat-protocol";
import { RUN_POLICIES, RUN_VERSION, type BuildId, type BuildProfile, type RunConfigurationEvidence, type RunPolicy, type RunRowSummary, type RunSelection, type RunTrial } from "./run-contracts";

export { SCREEN_SEEDS, EVALUATION_SEEDS, canonicalJson, digest, validateSeeds, RUN_VERSION };
export const ACTION_LIMIT = 60;
export const ROUND_LIMIT = 300;
export const LOADING_LIMIT = 1440;
export const MECHANICAL_LIMIT = 1440;
export const WINDOW_TICKS = 144;
export const SHOP_PURCHASE_LIMIT = 8;
export const REQUIRED_SCREEN_GATES = [
  "zero-invalid-or-accounting-divergence",
  "three-viable-advertised-profiles",
  "unfinished-rate-at-most-ten-percent",
  "acquired-build-full-loading-victory",
  "offensive-and-recovery-runs-complete",
  "later-no-purchase-attrition-exceeds-recovery",
  "recovery-investment-reduces-matched-attrition",
  "affordable-purchase-at-reached-shops",
  "every-build-has-strength-and-tradeoff",
  "no-universally-superior-profile",
] as const;

export const REPLACEMENT_ORDER = ["bomb", "gold", "diamond", "sword", "potion"] as const;
export const BUILD_PROFILES: readonly BuildProfile[] = [
  { id: "collector", starter: "collector", priorities: [{ offerId: "potion-pack", cap: 1 }, { offerId: "restorative-brew", cap: 2 }, { offerId: "extra-chute", cap: 1 }, { offerId: "tempered-swords", cap: 2 }] },
  { id: "swarm", starter: "swarm", priorities: [{ offerId: "gold-pack", cap: 1 }, { offerId: "diamond-mint", cap: 1 }, { offerId: "potion-pack", cap: 1 }, { offerId: "tempered-swords", cap: 2 }, { offerId: "extra-chute", cap: 1 }] },
  { id: "volley", starter: "volley", priorities: [{ offerId: "potion-pack", cap: 1 }, { offerId: "tempered-swords", cap: 2 }, { offerId: "extra-chute", cap: 1 }, { offerId: "gold-pack", cap: 1 }] },
  { id: "tempo", starter: "collector", priorities: [{ offerId: "combo-bell", cap: 1 }, { offerId: "tempered-swords", cap: 2 }, { offerId: "potion-pack", cap: 1 }, { offerId: "magazine-dump", cap: 1 }] },
  { id: "recovery", starter: "collector", priorities: [{ offerId: "potion-pack", cap: 2 }, { offerId: "restorative-brew", cap: 2 }, { offerId: "extra-chute", cap: 1 }, { offerId: "tempered-swords", cap: 1 }] },
  ...(["collector", "swarm", "volley"] as const).map((starter) => ({ id: `no-purchases-${starter}` as BuildId, starter, priorities: [] })),
];
export const ADVERTISED_BUILDS = BUILD_PROFILES.filter((profile) => profile.priorities.length).map((profile) => profile.id);
export function profileFor(id: BuildId): BuildProfile {
  const profile = BUILD_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown build: ${id}`);
  return profile;
}
export function validateRunTrial(trial: unknown): asserts trial is RunTrial {
  if (!trial || typeof trial !== "object" || Array.isArray(trial)) throw new Error("Trial must be an object");
  const candidate = trial as Partial<RunTrial>;
  validateSeeds([candidate.seed as number]);
  profileFor(candidate.build as BuildId);
  if (!RUN_POLICIES.includes(candidate.policy as RunPolicy)) throw new Error("Unknown run policy");
  if (!Number.isSafeInteger(candidate.actions) || candidate.actions! < 1 || candidate.actions! > ACTION_LIMIT)
    throw new Error("Actions must be an integer from 1 to 60");
  if (candidate.id !== `${candidate.build}/${candidate.seed}/${candidate.policy}`) throw new Error("Noncanonical trial ID");
}
export function createManifest(phase: "smoke" | "screen" | "evaluate", options: { seeds?: readonly number[]; builds?: readonly BuildId[]; policies?: readonly RunPolicy[]; actions?: number } = {}): RunTrial[] {
  if (phase !== "smoke" && (options.seeds !== undefined || options.builds !== undefined))
    throw new Error("Only smoke accepts seed or build overrides");
  const seeds = phase === "screen" ? SCREEN_SEEDS : phase === "evaluate" ? EVALUATION_SEEDS : options.seeds ?? [42];
  const builds = options.builds ?? BUILD_PROFILES.map((profile) => profile.id);
  const policies = phase === "screen" ? RUN_POLICIES : phase === "evaluate" ? ["rule"] as const : options.policies ?? RUN_POLICIES;
  if (phase !== "smoke" && options.policies && canonicalJson([...options.policies].sort()) !== canonicalJson([...policies].sort()))
    throw new Error(`${phase} requires its complete preregistered policy cohort`);
  if (phase !== "smoke" && options.actions !== undefined && options.actions !== ACTION_LIMIT)
    throw new Error("Screen and evaluate require 60 actions per encounter");
  validateSeeds(seeds);
  if (!builds.length || new Set(builds).size !== builds.length || !policies.length || new Set(policies).size !== policies.length)
    throw new Error("Build and policy cohorts must be nonempty and unique");
  const manifest = builds.flatMap((build) => seeds.flatMap((seed) =>
    (phase !== "smoke" && profileFor(build).priorities.length === 0 ? ["rule"] as const : policies)
      .map((policy) => ({ id: `${build}/${seed}/${policy}`, seed, build, policy, actions: options.actions ?? ACTION_LIMIT }))));
  manifest.forEach(validateRunTrial);
  return manifest;
}

function engineSources(): Record<string, string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sources: Record<string, string> = {};
  const visit = (relative: string): void => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".ts")) sources[path] = digest(readFileSync(join(root, path), "utf8"));
    }
  };
  for (const directory of ["src/run", "src/combat", "src/simulation", "src/experiments"]) visit(directory);
  for (const path of ["src/contracts.ts", "src/random.ts", "src/chutes.ts", "src/feed-geometry.ts", "src/machine-geometry.ts",
    "src/presentation/scene.ts", "src/presentation/camera.ts", "src/presentation/coin-symbols.ts", "package-lock.json"])
    sources[path] = digest(readFileSync(join(root, path), "utf8"));
  for (const entry of readdirSync(join(root, "scripts")).sort())
    if (entry.startsWith("run-") && entry.endsWith(".ts") || ["combat-evidence.ts", "combat-protocol.ts", "release-trial.ts"].includes(entry))
      sources[`scripts/${entry}`] = digest(readFileSync(join(root, "scripts", entry), "utf8"));
  return sources;
}
export function runConfigurationEvidence(): RunConfigurationEvidence {
  const miniature = resolveBuild(
    { playerChutes: [], stickers: ["miniature"], effectLevels: { temperedSwords: 0, restorativeBrew: 0 } },
    DEFAULT_TUNING,
    {
      swordDamage: DEFAULT_ENCOUNTER_CONFIG.swordDamage,
      skullDamage: DEFAULT_ENCOUNTER_CONFIG.skullDamage,
      potionHealing: DEFAULT_ENCOUNTER_CONFIG.potionHealing,
      bombDamage: BOMB_DAMAGE,
    },
  );
  const evidence = {
    catalogDigest: digest({ encounters: ENCOUNTERS, starters: STARTERS, offers: SHOP_OFFERS }),
    mechanicalDigest: digest({
      tuning: DEFAULT_TUNING,
      chutes: DEFAULT_CHUTES,
      bomb: DEFAULT_ENCOUNTER_CONFIG.bomb,
      limits: {
        actionLimit: ACTION_LIMIT,
        roundLimit: ROUND_LIMIT,
        loadingLimit: LOADING_LIMIT,
        mechanicalLimit: MECHANICAL_LIMIT,
        windowTicks: WINDOW_TICKS,
        shopPurchaseLimit: SHOP_PURCHASE_LIMIT,
      },
    }),
    fixedRecovery: INTER_ENCOUNTER_HEAL,
    victoryReward: VICTORY_REWARD,
    miniature: {
      radius: miniature.tuning.radius,
      thickness: miniature.tuning.thickness,
      openingPopulation: miniature.tuning.density,
      coinWeight: miniature.tuning.coinWeight,
      swordDamage: miniature.swordDamage,
    },
    mechanics: {
      actionLimit: ACTION_LIMIT,
      roundLimit: ROUND_LIMIT,
      loadingLimit: LOADING_LIMIT,
      mechanicalLimit: MECHANICAL_LIMIT,
      windowTicks: WINDOW_TICKS,
      shopPurchaseLimit: SHOP_PURCHASE_LIMIT,
    },
  };
  return { digest: digest(evidence), ...evidence };
}
export function runProtocolDigest(): string {
  return digest({ version: RUN_VERSION, sources: engineSources(), profiles: BUILD_PROFILES, encounters: ENCOUNTERS,
    starters: STARTERS, offers: SHOP_OFFERS, reward: VICTORY_REWARD, healing: INTER_ENCOUNTER_HEAL,
    limits: { MAX_EFFECT_LEVEL, MAX_PLAYER_CHUTES, MAX_STICKERS, ACTION_LIMIT, ROUND_LIMIT, LOADING_LIMIT, MECHANICAL_LIMIT, WINDOW_TICKS, SHOP_PURCHASE_LIMIT },
    chutes: DEFAULT_CHUTES, tuning: DEFAULT_TUNING, screening: SCREEN_SEEDS, evaluation: EVALUATION_SEEDS,
    configuration: runConfigurationEvidence(),
  });
}
export function validateManifestRows(report: { manifest: readonly RunTrial[]; rows: readonly RunRowSummary[] }): void {
  if (!Array.isArray(report.manifest) || !report.manifest.length || !Array.isArray(report.rows)) throw new Error("A nonempty planned manifest and rows are required");
  const planned = new Map<string, RunTrial>();
  for (const trial of report.manifest) {
    validateRunTrial(trial);
    if (planned.has(trial.id)) throw new Error(`Duplicate planned trial: ${trial.id}`);
    planned.set(trial.id, trial);
  }
  const seen = new Set<string>();
  for (const row of report.rows) {
    if (!row || !row.trial) throw new Error("Malformed trial row");
    if (seen.has(row.trial.id)) throw new Error(`Duplicate trial row: ${row.trial.id}`);
    const trial = planned.get(row.trial.id);
    if (!trial || canonicalJson(trial) !== canonicalJson(row.trial)) throw new Error(`Unplanned trial row: ${row.trial.id}`);
    if (!["won", "lost", "unfinished", "invalid"].includes(row.status)) throw new Error(`Invalid row outcome: ${row.trial.id}`);
    seen.add(row.trial.id);
  }
  if (seen.size !== planned.size) throw new Error(`Missing planned rows: ${[...planned.keys()].filter((id) => !seen.has(id)).join(",")}`);
}
export function validateFrozenSelection(selection: unknown, protocol: string): asserts selection is RunSelection {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) throw new Error("Frozen selection must be an object");
  const candidate = selection as Partial<RunSelection>;
  if (candidate.version !== RUN_VERSION || candidate.protocolDigest !== protocol) throw new Error("Frozen selection protocol/config mismatch");
  if (typeof candidate.digest !== "string" || !Array.isArray(candidate.gates) ||
    !Array.isArray(candidate.screenManifest) || !Array.isArray(candidate.evaluationManifest) ||
    typeof candidate.screenReportDigest !== "string") throw new Error("Frozen selection is incomplete");
  const { digest: recorded, ...payload } = candidate;
  if (digest(payload) !== recorded) throw new Error("Frozen selection digest mismatch");
  const gateNames = candidate.gates.map((gate) =>
    gate && typeof gate === "object" && !Array.isArray(gate) && typeof gate.name === "string" ? gate.name : null);
  if (canonicalJson([...gateNames].sort()) !== canonicalJson([...REQUIRED_SCREEN_GATES].sort()) ||
    candidate.gates.some((gate) => !gate || typeof gate !== "object" || Array.isArray(gate) || !gate.passed))
    throw new Error("Selection did not contain the complete passed screening gate set");
  if (canonicalJson(candidate.screenManifest) !== canonicalJson(createManifest("screen")) ||
    canonicalJson(candidate.evaluationManifest) !== canonicalJson(createManifest("evaluate"))) throw new Error("Frozen selection cohort mismatch");
}
