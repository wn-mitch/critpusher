import { COIN_TYPES, type CoinType } from "../contracts";
import type { BombConfig, CoinMix, EncounterConfig, EncounterEntry, EnemyDefinition, EnemyState, SimulationConfig, CombatTotals, CombatState, WaveDefinition } from "./types";
import { validateBag } from "./feed";

export const BOMB_DAMAGE = 5;
export const DEFAULT_ENCOUNTER_CONFIG: EncounterConfig = {
  playerMaxHp: 100,
  waves: [{
    id: "diagnostic-wave",
    enemies: [{ id: "diagnostic-guard", name: "Guard", maxHp: 120, chuteId: "diagnostic-guard-chute",
      bag: ["skull", "skull", "skull", "skull", "gold"], kind: "guard" }],
  }],
  swordDamage: 3, skullDamage: 2, potionHealing: 4,
  openingMix: { gold: 25, diamond: 1, sword: 35, skull: 28, potion: 10, bomb: 1 },
  bomb: { hitThreshold: 3, minClosingSpeed: 0.75, blastRadius: 2.25, blastDeltaSpeed: 6 },
};
export const GOLD_ONLY_MIX: CoinMix = { gold: 100, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0 };

export function normalizeMix(mix: CoinMix): CoinMix {
  if (!mix || typeof mix !== "object") throw new Error("Opening mix must specify all six coin weights");
  let total = 0;
  for (const type of COIN_TYPES) {
    const weight = mix[type];
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0)
      throw new Error(`Invalid opening weight: ${type}`);
    total += weight;
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error("Opening mix must have a positive finite total");
  return Object.fromEntries(COIN_TYPES.map(type => [type, mix[type] / total * 100])) as CoinMix;
}
function bounded(value: number, name: string, min: number, max: number, integer = false): number {
  if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
    throw new Error(`Invalid ${name}: expected ${integer ? "integer " : ""}${min}–${max}`);
  return value;
}
export function validateBomb(bomb: BombConfig): BombConfig {
  if (!bomb || typeof bomb !== "object") throw new Error("Bomb configuration must specify all four values");
  return {
    hitThreshold: bounded(bomb.hitThreshold, "bomb hit threshold", 1, 10, true),
    minClosingSpeed: bounded(bomb.minClosingSpeed, "minimum closing speed", 0.1, 10),
    blastRadius: bounded(bomb.blastRadius, "blast radius", 0.1, 5),
    blastDeltaSpeed: bounded(bomb.blastDeltaSpeed, "blast delta speed", 0.1, 10),
  };
}
export function simulationConfig(base: SimulationConfig = DEFAULT_ENCOUNTER_CONFIG, patch?: Partial<SimulationConfig>): SimulationConfig {
  return { openingMix: normalizeMix(patch?.openingMix === undefined ? base.openingMix : patch.openingMix), bomb: validateBomb(patch?.bomb === undefined ? base.bomb : patch.bomb) };
}
function claimId(id: string, ids: Set<string>): void {
  if (typeof id !== "string" || id.trim().length === 0 || ids.has(id))
    throw new Error(`Invalid or duplicate identifier: ${id}`);
  ids.add(id);
}
function validateWaves(waves: readonly WaveDefinition[]): WaveDefinition[] {
  if (!Array.isArray(waves) || waves.length === 0)
    throw new Error("Encounter must contain at least one wave");
  const ids = new Set<string>();
  const kinds: readonly EnemyDefinition["kind"][] = ["trainee", "guard", "escalator", "foreman", "escort"];
  return Array.from(waves, (wave: WaveDefinition) => {
    if (!wave || typeof wave !== "object") throw new Error("Invalid wave definition");
    claimId(wave.id, ids);
    if (!Array.isArray(wave.enemies) || wave.enemies.length === 0 || wave.enemies.length > 3)
      throw new Error("Wave must contain one to three enemies");
    return {
      id: wave.id,
      enemies: Array.from(wave.enemies, (enemy: EnemyDefinition) => {
        if (!enemy || typeof enemy !== "object") throw new Error("Invalid enemy definition");
        claimId(enemy.id, ids);
        claimId(enemy.chuteId, ids);
        if (typeof enemy.name !== "string" || enemy.name.trim().length === 0)
          throw new Error("Enemy must have a display name");
        if (!kinds.includes(enemy.kind)) throw new Error("Invalid enemy kind");
        return { ...enemy, maxHp: bounded(enemy.maxHp, "enemy HP", 1, Number.MAX_SAFE_INTEGER, true),
          bag: validateBag(enemy.bag) };
      }),
    };
  });
}
export function encounterConfig(base: EncounterConfig = DEFAULT_ENCOUNTER_CONFIG, patch?: Partial<EncounterConfig>): EncounterConfig {
  const next = { ...base, ...patch, ...simulationConfig(base, patch) };
  for (const key of ["playerMaxHp", "swordDamage", "skullDamage", "potionHealing"] as const)
    bounded(next[key], key, 1, Number.MAX_SAFE_INTEGER, true);
  return { ...next, waves: validateWaves(next.waves) };
}
export function validateEntry(config: EncounterConfig, entry?: EncounterEntry): EncounterEntry {
  const next: EncounterEntry = entry === undefined ? {
    playerHp: config.playerMaxHp,
    currency: 0,
    playerChutes: [{ id: "player-0", bag: ["sword", "sword", "sword", "sword", "bomb"] as CoinType[] }],
  } : entry;
  if (!next || typeof next !== "object") throw new Error("Invalid encounter entry");
  const playerHp = bounded(next.playerHp, "entry HP", 1, config.playerMaxHp, true);
  const currency = bounded(next.currency, "entry currency", 0, Number.MAX_SAFE_INTEGER, true);
  if (!Array.isArray(next.playerChutes) || next.playerChutes.length === 0 || next.playerChutes.length > 3)
    throw new Error("Entry must contain one to three player chutes");
  const ids = new Set<string>();
  for (const wave of config.waves) {
    ids.add(wave.id);
    for (const enemy of wave.enemies) {
      ids.add(enemy.id);
      ids.add(enemy.chuteId);
    }
  }
  const playerChutes = Array.from(next.playerChutes, chute => {
    if (!chute || typeof chute !== "object") throw new Error("Invalid player chute");
    claimId(chute.id, ids);
    return { id: chute.id, bag: validateBag(chute.bag) };
  });
  return { playerHp, currency, playerChutes, ...(next.build ? { build: structuredClone(next.build) } : {}) };
}
export function enemyStates(wave: WaveDefinition): EnemyState[] {
  return wave.enemies.map(enemy => ({
    id: enemy.id, name: enemy.name, hp: enemy.maxHp, maxHp: enemy.maxHp,
    chuteId: enemy.chuteId, kind: enemy.kind, admittedRounds: 0,
  }));
}
export function emptyTotals(): CombatTotals {
  return { swordDamage: 0, skullDamage: 0, bombDamageToEnemy: 0, bombDamageToPlayer: 0, enemyHpRemoved: 0,
    discardedDamage: 0, healingOffered: 0, healingUsed: 0, healingWasted: 0, currencyGained: 0, safeBombs: 0, detonations: 0, blastAssociatedDetonations: 0 };
}
export function initialCombatState(config: EncounterConfig, entry?: EncounterEntry): CombatState {
  const validated = validateEntry(config, entry);
  return { playerHp: validated.playerHp, enemies: enemyStates(config.waves[0]!), currency: validated.currency,
    result: null, totals: emptyTotals(), combo: { chain: 0, lastSwordTick: null } };
}
