import type {
  SolverDecision,
  SolverLane,
  SolverState,
  SurfaceCell,
} from "./solver-contracts";

const CENTER_OUT_ORDER = [2, 1, 3, 0, 4] as const;
const RELEASE_PHASE = 0;

function count(cell: SurfaceCell): number {
  return Number.isFinite(cell.count) && cell.count > 0 ? cell.count : 0;
}

/**
 * Rates only visible, actionable cells. A continuous rear-to-front chain is
 * worth more than an isolated pile, while coins at the edge dominate because
 * they can pay out in the next cycle. Upper occupancy is useful feed, but is
 * deliberately weaker than already-supported lower-shelf density.
 */
function laneScore(lane: SolverLane): number {
  const upper = count(lane.upper);
  const rear = count(lane.lowerRear);
  const middle = count(lane.lowerMiddle);
  const front = count(lane.lowerFront);
  const supportedLinks = Math.min(rear, middle) + Math.min(middle, front);
  const edgeGapBonus =
    lane.edgeGap === null || !Number.isFinite(lane.edgeGap)
      ? 0
      : Math.max(-1, Math.min(1, 1 - lane.edgeGap));

  return (
    lane.nearEdge * 8 +
    front * 3 +
    middle * 2 +
    rear +
    supportedLinks * 3 +
    upper * 0.5 +
    edgeGapBonus
  );
}

function chooseLane(lanes: readonly SolverLane[]): number {
  let chosen = 2;
  let bestScore = Number.NEGATIVE_INFINITY;

  // Center-out iteration is the complete tie rule, independent of Map or
  // observation insertion order: center, then inner left/right, then outer.
  for (const index of CENTER_OUT_ORDER) {
    const lane = lanes[index];
    if (lane === undefined) continue;
    const score = laneScore(lane);
    if (score > bestScore) {
      chosen = index;
      bestScore = score;
    }
  }
  return chosen;
}

function phaseDistance(left: number, right: number): number {
  const difference = Math.abs(left - right) % 1;
  return Math.min(difference, 1 - difference);
}

function chooseWaitQuarters(phase: number): 0 | 1 | 2 | 3 {
  const normalized = Number.isFinite(phase) ? ((phase % 1) + 1) % 1 : 0;
  let best: 0 | 1 | 2 | 3 = 0;
  let bestDistance = phaseDistance(normalized, RELEASE_PHASE);

  // Drops near the rear-most pusher phase get the whole forward stroke. The
  // four choices are transparent quarter-cycle offsets; equal timing picks the
  // shortest wait.
  for (const quarters of [1, 2, 3] as const) {
    const projected = (normalized + quarters / 4) % 1;
    const distance = phaseDistance(projected, RELEASE_PHASE);
    if (distance < bestDistance) {
      best = quarters;
      bestDistance = distance;
    }
  }
  return best;
}

/** Deterministic, observation-only baseline policy with no hidden lookahead. */
export function chooseRuleAction(state: SolverState): SolverDecision {
  return {
    action: {
      lane: chooseLane(state.board.lanes),
      waitQuarters: chooseWaitQuarters(state.board.phase),
    },
  };
}
