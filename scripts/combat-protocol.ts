import { createHash } from "node:crypto";
import { DEFAULT_CHUTES } from "../src/chutes";
import { DEFAULT_ENCOUNTER_CONFIG, encounterConfig } from "../src/combat/config";
import type { EncounterConfig } from "../src/combat/types";
import { DEFAULT_TUNING } from "../src/simulation/config";
import { FIGHT_POLICIES, FIGHT_VERSION, type FightProfile, type FightTrial, type SelectionGates } from "./combat-contracts";

export const SCREEN_SEEDS = Object.freeze([7, 42, 1337, 19, 71, 113, 211, 307, 401, 503, 601, 709]);
export const EVALUATION_SEEDS = Object.freeze([1009, 1013, 1019, 1021, 1031, 1033, 1039, 1049, 1051, 1061, 1063, 1069, 1087, 1091, 1093, 1097, 1103, 1109, 1117, 1123, 1129, 1151, 1153, 1163]);
export const MECHANICAL_WAIT_LIMIT_TICKS = 1440;
export const SELECTION_GATES: Readonly<SelectionGates> = Object.freeze({
  maxInvalid: 0,
  maxUnfinishedRate: 0.2,
  maxEarlyTerminalRate: 0.1,
  minMedianTerminalActions: 10,
  maxMedianTerminalActions: 45,
  maxSevereTailRate: 0.1,
  severeTailDamageFraction: 0.5,
  preferredJevVictoryMin: 0.3,
  preferredJevVictoryMax: 0.8,
});
const MIXTURES = {
  balanced: { gold: 25, diamond: 1, sword: 35, skull: 25, potion: 10, bomb: 4 },
  recovery: { gold: 23, diamond: 1, sword: 30, skull: 26, potion: 16, bomb: 4 },
  pressure: { gold: 21, diamond: 1, sword: 35, skull: 33, potion: 6, bomb: 4 },
} as const;
const BOMB_PRESETS = {
  sensitive: { hitThreshold: 2, minClosingSpeed: 0.5 },
  standard: { hitThreshold: 3, minClosingSpeed: 0.75 },
  resistant: { hitThreshold: 5, minClosingSpeed: 1 },
} as const;

const STUDY_WAVES: EncounterConfig["waves"] = [{
  id: "first-fight-wave",
  enemies: [{
    id: "first-fight-guard",
    name: "Guard",
    maxHp: 120,
    chuteId: "first-fight-guard-chute",
    bag: ["skull", "skull", "skull", "skull", "gold"],
    kind: "guard",
  }],
}];

export function registeredProfiles(): FightProfile[] {
  return Object.entries(MIXTURES).flatMap(([mixture, openingMix]) =>
    Object.entries(BOMB_PRESETS).map(([bombPreset, preset]) => ({
      name: `${mixture}-${bombPreset}`,
      mixture: mixture as FightProfile["mixture"],
      bombPreset: bombPreset as FightProfile["bombPreset"],
      config: encounterConfig(DEFAULT_ENCOUNTER_CONFIG, {
        openingMix,
        bomb: { ...preset, blastRadius: 1.75, blastDeltaSpeed: 3 },
        waves: STUDY_WAVES,
      }),
    })),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)));
  });
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function protocolDigest(): string {
  return digest({
    version: FIGHT_VERSION,
    profiles: registeredProfiles(),
    screeningSeeds: SCREEN_SEEDS,
    evaluationSeeds: EVALUATION_SEEDS,
    gates: SELECTION_GATES,
    physical: { ...DEFAULT_TUNING, seed: 0 },
    chutes: DEFAULT_CHUTES,
    actions: 60,
    cycleTicks: 144,
    playerBag: ["sword", "sword", "sword", "sword", "bomb"],
    bootstrapResamples: 2000,
    bootstrapSeed: 0x05a17e11,
  });
}
export function validateSeeds(seeds: readonly number[]): void {
  if (seeds.length === 0) throw new Error("At least one seed is required");
  const seen = new Set<number>();
  for (const seed of seeds) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error("Seeds must be unsigned 32-bit integers");
    if (seen.has(seed)) throw new Error(`Duplicate seed ${seed}`);
    seen.add(seed);
  }
}
export function assertDisjointSeeds(screening: readonly number[], evaluation: readonly number[]): void {
  validateSeeds(screening);
  validateSeeds(evaluation);
  const screened = new Set(screening);
  const overlap = evaluation.filter((seed) => screened.has(seed));
  if (overlap.length) throw new Error(`Evaluation seeds overlap screening: ${overlap.join(",")}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function validateFightTrial(value: unknown): asserts value is FightTrial {
  const trial = record(value, "Trial");
  if (typeof trial.id !== "string" || !trial.id) throw new Error("Trial ID is required");
  if (!FIGHT_POLICIES.some((policy) => policy === trial.policy)) throw new Error("Unknown fight policy");
  if (trial.timing !== "adaptive" && trial.timing !== "fixed") throw new Error("Unknown fight timing");
  if (typeof trial.seed !== "number") throw new Error("Seed must be numeric");
  validateSeeds([trial.seed]);
  if (typeof trial.actions !== "number" || !Number.isSafeInteger(trial.actions) || trial.actions < 1 || trial.actions > 60)
    throw new Error("Action budget must be an integer from 1 to 60");
  if (typeof trial.maxJevRequests !== "number" || !Number.isSafeInteger(trial.maxJevRequests) || trial.maxJevRequests < 0)
    throw new Error("Jev request budget must be a nonnegative safe integer");
  const profile = record(trial.profile, "Profile");
  if (typeof profile.name !== "string" || !profile.name) throw new Error("Profile name is required");
  if (typeof profile.mixture !== "string" || !Object.hasOwn(MIXTURES, profile.mixture)) throw new Error("Unknown mixture");
  if (typeof profile.bombPreset !== "string" || !Object.hasOwn(BOMB_PRESETS, profile.bombPreset)) throw new Error("Unknown bomb preset");
  const config = record(profile.config, "Encounter config");
  for (const key of Object.keys(DEFAULT_ENCOUNTER_CONFIG)) {
    if (config[key] === undefined) throw new Error(`Encounter config missing ${key}`);
  }
  const bomb = record(config.bomb, "Bomb config");
  for (const key of Object.keys(DEFAULT_ENCOUNTER_CONFIG.bomb)) {
    if (bomb[key] === undefined) throw new Error(`Bomb config missing ${key}`);
  }
  encounterConfig(DEFAULT_ENCOUNTER_CONFIG, config);
}
export function validateRegisteredProfile(profile: unknown): asserts profile is FightProfile {
  const value = record(profile, "Study profile");
  const registered = registeredProfiles().find((candidate) => candidate.name === value.name);
  if (!registered || canonicalJson(registered) !== canonicalJson(profile))
    throw new Error("Study profile must match a preregistered mixture and bomb preset");
}
export function trialId(profile: FightProfile, timing: "adaptive" | "fixed", seed: number, policy: FightTrial["policy"]): string {
  return `${profile.name}/${timing}/${seed}/${policy}`;
}
