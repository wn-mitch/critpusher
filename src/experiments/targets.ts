import type { CoinView } from "../contracts";

/** The three presentation lanes, ordered left to right. */
export const TARGET_LANES = [-3, 0, 3] as const;

// Lower-shelf coins have centers above the shelf top (y = 0) and below the
// pusher deck (y = 0.6). The narrow band deliberately rejects bodies already
// falling below the shelf, riding the upper shelf, or still high in the air.
// With no velocity in CoinView, position is the only honest settled-state
// signal available to this snapshot-only playtest probe.
const LOWER_SHELF_MIN_Y = 0;
const LOWER_SHELF_MAX_Y = 0.45;
const FRONT_BAND_DEPTH = 1.5;
const LANE_WIDTH = 1.5;

function laneForX(x: number): number | undefined {
  const lane = Math.round((x + 3) / 3);
  if (lane < 0 || lane >= TARGET_LANES.length) return undefined;
  const center = TARGET_LANES[lane];
  if (center === undefined) return undefined;
  return Math.abs(x - center) <= LANE_WIDTH ? lane : undefined;
}

interface Candidate {
  coin: CoinView;
  lane: number;
}

function isBetterCandidate(candidate: Candidate, current: Candidate): boolean {
  const laneCenter = TARGET_LANES[candidate.lane]!;
  // Prefer the coin nearest the collection edge, then the lowest coin and the
  // one nearest its lane center. Id is only a stable final tie-breaker, making
  // identical-position snapshots independent of Map insertion order.
  if (candidate.coin.position.z !== current.coin.position.z) {
    return candidate.coin.position.z > current.coin.position.z;
  }
  if (candidate.coin.position.y !== current.coin.position.y) {
    return candidate.coin.position.y < current.coin.position.y;
  }
  const candidateLaneDistance = Math.abs(
    candidate.coin.position.x - laneCenter,
  );
  const currentLaneDistance = Math.abs(current.coin.position.x - laneCenter);
  if (candidateLaneDistance !== currentLaneDistance) {
    return candidateLaneDistance < currentLaneDistance;
  }
  return candidate.coin.id < current.coin.id;
}

/**
 * Select at most three current coins for each of the three target lanes.
 * Eligibility uses only this snapshot: a lower-shelf center in the final band
 * before the front edge, never a body already over that edge. Missing lanes
 * stay missing; the selector never substitutes an ineligible coin. Each
 * lane's bounded top-three list uses the ranking documented above.
 */
export function selectTargets(
  coins: ReadonlyMap<number, CoinView>,
  shelfFront: number,
): ReadonlyMap<number, number> {
  if (!Number.isFinite(shelfFront)) return new Map();
  const selected: Candidate[][] = TARGET_LANES.map(() => []);
  for (const coin of coins.values()) {
    const { x, y, z } = coin.position;
    if (
      !Number.isFinite(coin.id) ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      !Number.isFinite(z) ||
      y < LOWER_SHELF_MIN_Y ||
      y > LOWER_SHELF_MAX_Y ||
      z < shelfFront - FRONT_BAND_DEPTH ||
      z > shelfFront
    ) {
      continue;
    }
    const lane = laneForX(x);
    if (lane === undefined) continue;
    const candidate = { coin, lane };
    const candidates = selected[lane]!;
    const insertion = candidates.findIndex((current) =>
      isBetterCandidate(candidate, current),
    );
    if (insertion === -1) candidates.push(candidate);
    else candidates.splice(insertion, 0, candidate);
    if (candidates.length > 3) candidates.pop();
  }

  const result = new Map<number, number>();
  for (let lane = 0; lane < selected.length; lane += 1) {
    for (const candidate of selected[lane]!) {
      result.set(candidate.coin.id, lane);
    }
  }
  return result;
}
