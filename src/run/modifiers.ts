import type { GizmoDefinition, Tuning } from "../contracts";
import { sanitizeTuning } from "../simulation/config";
import type { BaseEffects, EffectLevels, RunInventory, StickerId } from "./types";

export interface ResolvedBuild extends BaseEffects {
  tuning: Tuning;
  stickers: readonly StickerId[];
  effectLevels: EffectLevels;
  detonationPolicy: "physical" | "collected-only";
  releaseMode: "ordinary" | "dump";
  combo: { windowTicks: number; maxMultiplier: number };
  gizmo: GizmoDefinition | null;
}

/** Composition is persistent inventory; physics precedes upgrades and timed multipliers. */
export function resolveBuild(inventory: RunInventory, baseTuning: Tuning, baseEffects: BaseEffects): ResolvedBuild {
  const miniature = inventory.stickers.includes("miniature");
  const collectedOnly = inventory.stickers.includes("collected-only");
  const bell = inventory.stickers.includes("combo-bell");
  const tuning = sanitizeTuning(baseTuning, miniature ? {
    radius: baseTuning.radius * 0.75,
    thickness: baseTuning.thickness * 0.75,
    density: baseTuning.density * 1.5,
  } : undefined);
  return {
    tuning,
    stickers: [...inventory.stickers],
    effectLevels: { ...inventory.effectLevels },
    swordDamage: (miniature ? 2 : baseEffects.swordDamage) + inventory.effectLevels.temperedSwords,
    skullDamage: baseEffects.skullDamage,
    potionHealing: baseEffects.potionHealing + 2 * inventory.effectLevels.restorativeBrew,
    bombDamage: collectedOnly ? 0 : baseEffects.bombDamage,
    detonationPolicy: collectedOnly ? "collected-only" : "physical",
    releaseMode: inventory.stickers.includes("magazine-dump") ? "dump" : "ordinary",
    combo: { windowTicks: bell ? 144 : 0, maxMultiplier: bell ? 3 : 1 },
    gizmo: bell ? { kind: "bell", radius: 0.38, density: 1.5, payout: 3 } : null,
  };
}
