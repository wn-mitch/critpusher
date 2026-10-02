import { describe, expect, it } from "vitest";
import type {
  CoinView,
  CollectionEvent,
  Simulation,
  SimulationStats,
  Tuning,
} from "../src/contracts";
import { createLaneObserver } from "../src/experiments/lanes";
import { chooseRuleAction } from "../src/experiments/rule-policy";
import type {
  LaneBoard,
  SolverLane,
  SurfaceCell,
} from "../src/experiments/solver-contracts";
import { DEFAULT_TUNING } from "../src/simulation";

function coin(id: number, x: number, y: number, z: number): CoinView {
  return {
    id,
    faction: "ally",
    position: { x, y, z },
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    radius: 0.35,
    thickness: 0.18,
  };
}

function simulationFixture(initialCoins: CoinView[] = []): {
  simulation: Simulation;
  coins: Map<number, CoinView>;
  stats: SimulationStats;
  tuning: Tuning;
} {
  const coins = new Map(initialCoins.map((value) => [value.id, value]));
  const tuning = { ...DEFAULT_TUNING };
  const stats: SimulationStats = {
    time: 0,
    active: coins.size,
    sleeping: 0,
    spawned: coins.size,
    collected: 0,
    allyCollected: 0,
    enemyCollected: 0,
    dudCollected: 0,
    lost: 0,
    pendingRain: 0,
    physicsMs: 0,
    pusherZ: -3,
    phase: 0,
  };
  const simulation: Simulation = {
    coins,
    tuning,
    step() {},
    drop: () => false,
    releaseChutes: () => null,
    reset() {},
    configure() {},
    drainEvents: () => [],
    stats: () => stats,
    dispose() {},
  };
  return { simulation, coins, stats, tuning };
}

const emptyCell = (): SurfaceCell => ({
  count: 0,
  meanHeight: null,
  meanForwardSpeed: null,
});

function lane(index: number, patch: Partial<SolverLane> = {}): SolverLane {
  return {
    index,
    aimX: -4 + index * 2,
    upper: emptyCell(),
    lowerRear: emptyCell(),
    lowerMiddle: emptyCell(),
    lowerFront: emptyCell(),
    nearEdge: 0,
    edgeGap: null,
    recentCollected: 0,
    ...patch,
  };
}

function board(lanes: SolverLane[], phase = 0): LaneBoard {
  return {
    time: 1,
    sampleSeconds: 1 / 60,
    phase,
    period: 2.4,
    pusherFront: -2,
    shelfFront: 4,
    active: 0,
    airborne: 0,
    falling: 0,
    lanes,
  };
}

describe("five-lane physical observation", () => {
  it("assigns every shared lane boundary exactly once", () => {
    const fixture = simulationFixture([
      coin(1, -5, 0.1, 0),
      coin(2, -3, 0.1, 0),
      coin(3, -1, 0.1, 0),
      coin(4, 1, 0.1, 0),
      coin(5, 3, 0.1, 0),
      coin(6, 5, 0.1, 0),
      coin(7, 5.001, 0.1, 0),
    ]);

    const observation = createLaneObserver().observe(fixture.simulation);

    expect(observation.lanes.map((value) => value.lowerMiddle.count)).toEqual([
      1, 1, 1, 1, 2,
    ]);
    expect(observation.active).toBe(6);
    expect(observation.falling).toBe(1);
  });

  it("separates stacked upper and lower coins and counts exclusions", () => {
    const fixture = simulationFixture([
      coin(1, 0, 0.68, -2.4),
      coin(2, 0, 1.2, -2.5),
      coin(3, 0, 0.1, -1),
      coin(4, 0, 0.7, -0.5),
      coin(5, 0, -0.01, 1),
      coin(6, 0, 0.1, 4.01),
      coin(7, 0, 2, -2.5),
      coin(8, 0, 1.2, -1),
    ]);

    const observation = createLaneObserver().observe(fixture.simulation);
    const center = observation.lanes[2]!;

    expect(center.upper.count).toBe(2);
    expect(center.lowerRear.count).toBe(2);
    expect(center.upper.meanHeight).toBeCloseTo(0.94);
    expect(observation).toMatchObject({ active: 4, airborne: 2, falling: 2 });
  });

  it("uses shelf-relative thirds and clamps lower rear positions", () => {
    const fixture = simulationFixture([
      coin(1, 0, 0.1, -3.5),
      coin(2, 0, 0.1, -2),
      coin(3, 0, 0.1, 0),
      coin(4, 0, 0.1, 2),
      coin(5, 0, 0.1, 3.8),
    ]);
    const laneAtFour = createLaneObserver().observe(fixture.simulation)
      .lanes[2]!;
    expect([
      laneAtFour.lowerRear.count,
      laneAtFour.lowerMiddle.count,
      laneAtFour.lowerFront.count,
    ]).toEqual([2, 1, 2]);

    fixture.tuning.shelfFront = 3;
    fixture.coins.clear();
    fixture.coins.set(6, coin(6, 0, 0.1, -0.4));
    fixture.coins.set(7, coin(7, 0, 0.1, 0));
    fixture.coins.set(8, coin(8, 0, 0.1, 1.4));
    const laneAtThree = createLaneObserver().observe(fixture.simulation)
      .lanes[2]!;
    expect([
      laneAtThree.lowerRear.count,
      laneAtThree.lowerMiddle.count,
      laneAtThree.lowerFront.count,
    ]).toEqual([1, 1, 1]);
  });

  it("copies positions, omits velocity for new IDs, prunes departed IDs, and resets", () => {
    const moving = coin(1, 0, 0.1, 1);
    const fixture = simulationFixture([moving]);
    const observer = createLaneObserver();
    observer.observe(fixture.simulation);

    fixture.stats.time = 0.5;
    moving.position.z = 1.5;
    fixture.coins.set(2, coin(2, 0, 0.1, 1.5));
    let cell = observer.observe(fixture.simulation).lanes[2]!.lowerMiddle;
    expect(cell.meanForwardSpeed).toBe(1);

    fixture.stats.time = 1;
    fixture.coins.clear();
    observer.observe(fixture.simulation);
    fixture.stats.time = 1.5;
    fixture.coins.set(1, moving);
    cell = observer.observe(fixture.simulation).lanes[2]!.lowerMiddle;
    expect(cell.meanForwardSpeed).toBeNull();

    observer.reset();
    fixture.stats.time = 2;
    moving.position.z = 1.75;
    cell = observer.observe(fixture.simulation).lanes[2]!.lowerMiddle;
    expect(cell.meanForwardSpeed).toBeNull();
    expect(observer.observe(fixture.simulation).sampleSeconds).toBe(0);
  });

  it("reports rim overhang and drains only real collection events per lane", () => {
    const fixture = simulationFixture([coin(1, -4, 0.1, 3.8)]);
    const observer = createLaneObserver();
    const events: CollectionEvent[] = [
      {
        id: 2,
        kind: "collected",
        faction: "ally",
        position: { x: -3, y: -1, z: 4 },
      },
      {
        id: 3,
        kind: "collected",
        faction: "ally",
        position: { x: 5, y: -1, z: 4 },
      },
      { id: 4, kind: "lost", faction: "ally", position: { x: 0, y: -1, z: 4 } },
    ];
    observer.record(events);

    let observation = observer.observe(fixture.simulation);
    expect(observation.lanes.map((value) => value.recentCollected)).toEqual([
      0, 1, 0, 0, 1,
    ]);
    expect(observation.lanes[0]!.nearEdge).toBe(1);
    expect(observation.lanes[0]!.edgeGap).toBeCloseTo(-0.15);

    observation = observer.observe(fixture.simulation);
    expect(
      observation.lanes.every((value) => value.recentCollected === 0),
    ).toBe(true);
    observer.record(events);
    observer.reset();
    expect(
      observer
        .observe(fixture.simulation)
        .lanes.every((value) => value.recentCollected === 0),
    ).toBe(true);
  });
});

describe("rule policy", () => {
  it("responds to a materially denser supported path and near-edge payout", () => {
    const sparseEdge = lane(0, {
      lowerFront: { ...emptyCell(), count: 1 },
      nearEdge: 1,
      edgeGap: 0.1,
    });
    const supported = lane(4, {
      lowerRear: { ...emptyCell(), count: 3 },
      lowerMiddle: { ...emptyCell(), count: 3 },
      lowerFront: { ...emptyCell(), count: 3 },
    });
    const lanes = [sparseEdge, lane(1), lane(2), lane(3), supported];

    expect(
      chooseRuleAction({
        board: board(lanes),
        releaseCoins: 3,
        feed: "chute",
        recent: [],
      }).action.lane,
    ).toBe(4);

    lanes[1] = lane(1, {
      lowerFront: { ...emptyCell(), count: 4 },
      nearEdge: 4,
      edgeGap: -0.1,
    });
    expect(
      chooseRuleAction({
        board: board(lanes),
        releaseCoins: 1,
        feed: "back-row",
        recent: [],
      }).action.lane,
    ).toBe(1);
  });

  it("uses center-out ties and a fixed rear-phase quarter alignment", () => {
    const lanes = [lane(0), lane(1), lane(2), lane(3), lane(4)];
    expect(
      chooseRuleAction({
        board: board(lanes, 0.3),
        releaseCoins: 1,
        feed: "chute",
        recent: [],
      }).action,
    ).toEqual({ lane: 2, waitQuarters: 3 });
  });
});
