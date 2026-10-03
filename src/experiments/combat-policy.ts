import { randomFactory } from "../random";
import type {
  CombatSolverPolicy,
  CombatSolverState,
  CombatTypeCounts,
  SolverDecision,
} from "./solver-contracts";
import { CENTER_OUT_ORDER, chooseWaitQuarters, laneScore } from "./rule-policy";

function finiteCount(counts: CombatTypeCounts, type: keyof CombatTypeCounts["counts"]): number {
  const value = counts.counts[type];
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function nearThresholdBombs(counts: CombatTypeCounts): number {
  return Number.isFinite(counts.nearThresholdBombs) && counts.nearThresholdBombs > 0
    ? counts.nearThresholdBombs
    : 0;
}

function combatLaneScore(state: CombatSolverState, index: number): number {
  const observation = state.observation;
  const physicalLane = observation.board.lanes[index];
  const summary = state.observation.lanes.find((lane) => lane.index === index);
  if (!physicalLane || !summary) return Number.NEGATIVE_INFINITY;

  const nearEdge = summary.nearEdge;
  const missingPlayerHp = Math.max(
    0,
    observation.playerMaxHp - observation.playerHp,
  );
  const effects = observation.rules;
  const multiplier = observation.combo.ticksRemaining > 0
    ? Math.min(observation.combo.maxMultiplier, observation.combo.chain + 1) : 1;
  const readableEffects =
    effects.swordDamage * multiplier * finiteCount(nearEdge, "sword") -
    effects.skullDamage * finiteCount(nearEdge, "skull") +
    Math.min(effects.potionHealing, missingPlayerHp) *
      finiteCount(nearEdge, "potion");
  const reward =
    finiteCount(nearEdge, "gold") + 10 * finiteCount(nearEdge, "diamond");
  const armedBombPenalty = observation.feed.some(
    (tray) => tray.enabled && tray.preview[0] === "bomb",
  )
    ? effects.bombDamage * nearThresholdBombs(summary.upper)
    : 0;

  return laneScore(physicalLane) + 4 * readableEffects + reward -
    effects.bombDamage * nearThresholdBombs(nearEdge) - armedBombPenalty;
}
/** Always chooses the center candidate and releases without waiting. */
export function chooseCombatCenterAction(): SolverDecision {
  return { action: { lane: 2, waitQuarters: 0 } };
}

/** Seeded uniform placement baseline; timing remains fixed at immediate release. */
export function createCombatRandomPolicy(seed: number): CombatSolverPolicy {
  const random = randomFactory(seed ^ 0x1f123bb5);
  return () => ({
    action: {
      lane: Math.floor(random() * CENTER_OUT_ORDER.length),
      waitQuarters: 0,
    },
  });
}

/** Deterministic combat baseline that scores only the readable projection. */
export function chooseCombatRuleAction(
  state: CombatSolverState,
): SolverDecision {
  let chosen = 2;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const index of CENTER_OUT_ORDER) {
    const score = combatLaneScore(state, index);
    if (score > bestScore) {
      chosen = index;
      bestScore = score;
    }
  }

  return {
    action: {
      lane: chosen,
      waitQuarters: chooseWaitQuarters(state.observation.board.phase),
    },
  };
}
