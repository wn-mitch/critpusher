import type { CoinEvent, CoinView, Simulation } from "../contracts";
import { MACHINE_GEOMETRY } from "../machine-geometry";
import {
  SOLVER_LANE_CENTERS,
  type LaneBoard,
  type LaneObserver,
  type SolverLane,
  type SurfaceCell,
} from "./solver-contracts";

const LANE_MIN_X = -MACHINE_GEOMETRY.shelfHalfWidth;
const LANE_WIDTH = MACHINE_GEOMETRY.shelfHalfWidth * 2 / SOLVER_LANE_CENTERS.length;
const PUSHER_DECK_Y = MACHINE_GEOMETRY.pusherTop;
const LOWER_BAND_REAR_Z = MACHINE_GEOMETRY.pusherRearZ + MACHINE_GEOMETRY.pusherFrontOffset;

export type SupportClassification =
  | "upper"
  | "lowerRear"
  | "lowerMiddle"
  | "lowerFront"
  | "airborne"
  | "falling";
interface PositionSample {
  x: number;
  y: number;
  z: number;
}

interface CellAccumulator {
  count: number;
  heightTotal: number;
  speedTotal: number;
  speedSamples: number;
}

interface LaneAccumulator {
  upper: CellAccumulator;
  lower: [CellAccumulator, CellAccumulator, CellAccumulator];
  nearEdge: number;
  edgeGap: number | null;
}

export function laneForX(x: number): number | null {
  if (!Number.isFinite(x) || x < LANE_MIN_X || x > MACHINE_GEOMETRY.shelfHalfWidth) return null;
  return Math.min(SOLVER_LANE_CENTERS.length - 1, Math.floor((x - LANE_MIN_X) / LANE_WIDTH));
}

function emptyCell(): CellAccumulator {
  return { count: 0, heightTotal: 0, speedTotal: 0, speedSamples: 0 };
}

function emptyLane(): LaneAccumulator {
  return {
    upper: emptyCell(),
    lower: [emptyCell(), emptyCell(), emptyCell()],
    nearEdge: 0,
    edgeGap: null,
  };
}

function finishCell(cell: CellAccumulator): SurfaceCell {
  return {
    count: cell.count,
    meanHeight: cell.count === 0 ? null : cell.heightTotal / cell.count,
    meanForwardSpeed:
      cell.speedSamples === 0 ? null : cell.speedTotal / cell.speedSamples,
  };
}

function validCoin(coin: CoinView): boolean {
  const { x, y, z } = coin.position;
  return (
    Number.isFinite(coin.id) &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Number.isFinite(z) &&
    Number.isFinite(coin.radius) &&
    Number.isFinite(coin.thickness) &&
    coin.radius > 0 &&
    coin.thickness > 0
  );
}

function addCoin(
  cell: CellAccumulator,
  coin: CoinView,
  previous: PositionSample | undefined,
  sampleSeconds: number,
): void {
  cell.count += 1;
  cell.heightTotal += coin.position.y;
  if (previous === undefined || sampleSeconds <= 0) return;

  const speed = (coin.position.z - previous.z) / sampleSeconds;
  if (!Number.isFinite(speed)) return;
  cell.speedTotal += speed;
  cell.speedSamples += 1;
}

export function lowerBand(z: number, shelfFront: number): 0 | 1 | 2 {
  const depth = shelfFront - LOWER_BAND_REAR_Z;
  const offset = Math.max(0, z - LOWER_BAND_REAR_Z);
  return Math.min(2, Math.floor(offset / (depth / 3))) as 0 | 1 | 2;
}

export function supportClassification(
  coin: Pick<CoinView, "position" | "radius" | "thickness">,
  pusherFront: number,
  shelfFront: number,
): SupportClassification {
  const { y, z } = coin.position;
  if (y < MACHINE_GEOMETRY.shelfTop || z > shelfFront) return "falling";

  const upperHeight = y >= PUSHER_DECK_Y - coin.thickness;
  const onUpper = z <= pusherFront && upperHeight;
  const supportY = onUpper ? PUSHER_DECK_Y : MACHINE_GEOMETRY.shelfTop;
  if (y > supportY + 3 * coin.radius) return "airborne";
  if (onUpper) return "upper";
  return (["lowerRear", "lowerMiddle", "lowerFront"] as const)[
    lowerBand(z, shelfFront)
  ];
}

/**
 * Builds an observation from public simulation snapshots only. Classification
 * is necessarily geometric: a center behind the real pusher front and near or
 * above its 0.6-high deck is upper; a center ahead, or below deck height, is
 * lower. That height exception retains lower-rear coins exposed as the pusher
 * moves. We allow roughly three coin radii of stack height above the inferred
 * support before calling a body airborne. Bodies below the shelf or whose
 * centers crossed its front are already falling and cannot be useful targets.
 */
export function createLaneObserver(): LaneObserver {
  let previousPositions = new Map<number, PositionSample>();
  let previousTime: number | null = null;
  const pendingCollected = [0, 0, 0, 0, 0];

  return {
    observe(simulation: Simulation, visibleIds?: ReadonlySet<number>): LaneBoard {
      const stats = simulation.stats();
      const time = Number.isFinite(stats.time) ? stats.time : 0;
      const period =
        Number.isFinite(simulation.tuning.period) &&
        simulation.tuning.period > 0
          ? simulation.tuning.period
          : 0;
      const shelfFront = Number.isFinite(simulation.tuning.shelfFront)
        ? simulation.tuning.shelfFront
        : 0;
      const pusherFront = Number.isFinite(stats.pusherZ)
        ? stats.pusherZ + MACHINE_GEOMETRY.pusherFrontOffset
        : 0;
      const sampleSeconds =
        previousTime !== null && time > previousTime ? time - previousTime : 0;
      const accumulators = SOLVER_LANE_CENTERS.map(emptyLane);
      const currentPositions = new Map<number, PositionSample>();
      let active = 0;
      let airborne = 0;
      let falling = 0;

      for (const coin of simulation.coins.values()) {
        if (visibleIds !== undefined && !visibleIds.has(coin.id)) continue;

        const isValid = validCoin(coin);
        if (isValid) {
          currentPositions.set(coin.id, {
            x: coin.position.x,
            y: coin.position.y,
            z: coin.position.z,
          });
        }

        const laneIndex = isValid ? laneForX(coin.position.x) : null;
        if (laneIndex === null || !isValid) {
          falling += 1;
          continue;
        }
        const lane = accumulators[laneIndex]!;
        const support = supportClassification(coin, pusherFront, shelfFront);
        if (support === "falling") {
          falling += 1;
          continue;
        }
        if (support === "airborne") {
          airborne += 1;
          continue;
        }

        active += 1;
        const previous = previousPositions.get(coin.id);
        if (support === "upper") {
          addCoin(lane.upper, coin, previous, sampleSeconds);
          continue;
        }

        const band =
          support === "lowerRear" ? 0 : support === "lowerMiddle" ? 1 : 2;
        addCoin(lane.lower[band], coin, previous, sampleSeconds);
        const gap = shelfFront - (coin.position.z + coin.radius);
        lane.edgeGap =
          lane.edgeGap === null ? gap : Math.min(lane.edgeGap, gap);
        if (shelfFront - coin.position.z <= 2 * coin.radius) {
          lane.nearEdge += 1;
        }
      }

      const lanes: SolverLane[] = accumulators.map((lane, index) => ({
        index,
        aimX: SOLVER_LANE_CENTERS[index]!,
        upper: finishCell(lane.upper),
        lowerRear: finishCell(lane.lower[0]),
        lowerMiddle: finishCell(lane.lower[1]),
        lowerFront: finishCell(lane.lower[2]),
        nearEdge: lane.nearEdge,
        edgeGap: lane.edgeGap,
        recentCollected: pendingCollected[index]!,
      }));

      pendingCollected.fill(0);
      previousPositions = currentPositions;
      previousTime = time;

      return {
        time,
        sampleSeconds,
        phase: Number.isFinite(stats.phase) ? stats.phase : 0,
        period,
        pusherFront,
        shelfFront,
        active,
        airborne,
        falling,
        lanes,
      };
    },

    record(events: readonly CoinEvent[]): void {
      for (const event of events) {
        if (event.kind !== "collected") continue;
        const lane = laneForX(event.position.x);
        if (lane !== null) pendingCollected[lane]! += 1;
      }
    },

    reset(): void {
      previousPositions.clear();
      previousTime = null;
      pendingCollected.fill(0);
    },
  };
}
