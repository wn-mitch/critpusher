import { describe, expect, it } from "vitest";
import { DEFAULT_ENCOUNTER_CONFIG, emptyTotals } from "../src/combat/config";
import { createEncounter } from "../src/combat/encounter";
import type {
  CombatStepResult,
  Encounter,
  EncounterSnapshot,
  FeedTray,
  FeedLayout,
} from "../src/combat/types";
import type {
  CoinType,
  CoinView,
  Simulation,
  GizmoView,
  SimulationStats,
} from "../src/contracts";
import { createCombatObserver } from "../src/experiments/combat-observation";
import { laneForX } from "../src/experiments/lanes";
import { DEFAULT_TUNING } from "../src/simulation";
import { FEED_TRAY_COS, FEED_TRAY_ROTATION, FEED_TRAY_SIN, getFeedTrayGeometry } from "../src/feed-geometry";
import { createSyntheticSlots } from "../src/experiments/chutes";
import { PLAYER_DROP_Z } from "../src/simulation/config";

function coin(
  id: number,
  type: CoinType,
  x: number,
  y: number,
  z: number,
  patch: Partial<Pick<CoinView, "rotation" | "bombHits">> = {},
): CoinView {
  return {
    id,
    type,
    bombHits: patch.bombHits ?? 0,
    position: { x, y, z },
    rotation: patch.rotation ?? { x: 0, y: 0, z: 0, w: 1 },
    radius: DEFAULT_TUNING.radius,
    thickness: DEFAULT_TUNING.thickness,
  };
}

function snapshot(recentEffects: readonly CombatStepResult[] = []): EncounterSnapshot {
  const enemies = [{
    id: "encounter-1-wave-1-guard",
    name: "Guard",
    hp: 91,
    maxHp: 120,
    chuteId: "enemy-guard",
    admittedRounds: 2,
    kind: "guard" as const,
  }];
  return {
    phase: "active",
    result: null,
    playerHp: 73,
    combo: { chain: 0, lastSwordTick: null },
    build: null,
    playerMaxHp: DEFAULT_ENCOUNTER_CONFIG.playerMaxHp,
    enemies,
    frontEnemyId: enemies[0]!.id,
    waveIndex: 0,
    waveCount: 1,
    livingWaveHp: 91,
    currency: 14,
    acceptedActions: 2,
    acceptedRounds: 2,
    queuedRounds: 0,
    remainingRounds: 0,
    interruptedRounds: 0,
    completionSerial: 0,
    tick: 12,
    config: {
      ...DEFAULT_ENCOUNTER_CONFIG,
      openingMix: { ...DEFAULT_ENCOUNTER_CONFIG.openingMix },
      bomb: { ...DEFAULT_ENCOUNTER_CONFIG.bomb },
      waves: DEFAULT_ENCOUNTER_CONFIG.waves.map((wave) => ({
        ...wave,
        enemies: wave.enemies.map((enemy) => ({ ...enemy, bag: [...enemy.bag] })),
      })),
    },
    chuteSlots: createSyntheticSlots(2),
    playerChutes: [{ id: "player-0", bag: ["sword", "bomb", "sword", "sword", "sword"] }],
    chuteSettings: { chuteSpacing: 0.66, dropDelay: 0.3, dropsPerAction: 1 },
    feedStreams: [],
    lastAdmission: {
      accepted: true,
      tick: 12,
      action: 2,
      round: 1,
      aimX: 0,
      newRound: true,
      coins: [
        { chuteId: "player-0", id: 6001, type: "sword" },
        { chuteId: "enemy-0", id: 6002, type: "skull" },
      ],
    },
    paused: false,
    error: null,
    loading: {
      ticks: 720,
      collectedByType: { ...DEFAULT_ENCOUNTER_CONFIG.openingMix },
      lostByType: { ...DEFAULT_ENCOUNTER_CONFIG.openingMix },
      detonated: 0,
    },
    recentEffects,
  };
}

function encounterFixture(
  initialCoins: readonly CoinView[],
  recentEffects: readonly CombatStepResult[] = [],
  gizmos: readonly GizmoView[] = [],
): Encounter {
  const coins = new Map(initialCoins.map((value) => [value.id, value]));
  const stats: SimulationStats = {
    time: 12,
    active: coins.size,
    sleeping: 0,
    spawned: coins.size,
    collected: 0,
    collectedByType: {
      gold: 0,
      diamond: 0,
      sword: 0,
      skull: 0,
      potion: 0,
      bomb: 0,
    },
    detonated: 0,
    lost: 0,
    pendingRain: 0,
    physicsMs: 0,
    pusherZ: -3,
    phase: 0.25,
    gizmos: { spawned: gizmos.length, active: gizmos.length, collected: 0, lost: 0, pending: 0 },
  };
  const simulation: Simulation = {
    coins,
    gizmos: new Map(gizmos.map((view) => [view.id, view])),
    tuning: { ...DEFAULT_TUNING },
    config: {
      openingMix: { ...DEFAULT_ENCOUNTER_CONFIG.openingMix },
      bomb: { ...DEFAULT_ENCOUNTER_CONFIG.bomb },
    },
    setBombsActive() {},
    configureGizmo() { throw new Error("Observation fixtures are read-only"); },
    drainGizmoEvents: () => [],
    startFeedBurst: () => false,
    cancelFeedBurst() {},
    drainFeedAdmissions: () => [],
    setFeedLayout() { throw new Error("Observation fixtures are read-only"); },
    feedTrays: () => trays,
    releaseFeed: () => null,
    step() {},
    drop: () => false,
    releaseChutes: () => null,
    cancelRain() {},
    reset() {},
    configure() {},
    drainEvents: () => [],
    stats: () => stats,
    dispose() {},
  };
  const layouts: FeedLayout[] = [
    {
      ...createSyntheticSlots(2)[0]!,
      x: 0,
      source: "player",
      preview: ["sword", "bomb", "sword", "sword", "sword"],
    },
    {
      ...createSyntheticSlots(2)[1]!,
      x: -0.66,
      source: "enemy",
      preview: ["skull", "skull", "skull", "skull", "skull"],
    },
    {
      ...createSyntheticSlots(2)[2]!,
      x: 0.66,
      source: "enemy",
      preview: ["skull", "skull", "skull", "skull", "skull"],
    },
  ];
  const { spacing } = getFeedTrayGeometry(DEFAULT_TUNING.radius, DEFAULT_TUNING.thickness, DEFAULT_TUNING.dropHeight);
  const trays: FeedTray[] = layouts.map((layout, tray) => ({
    ...layout,
    gateOpen: false,
    burst: { phase: "idle", cohort: [], trapRetracted: false },
    coins: layout.preview.map((type, slot) => coin(
      -1 - tray * 6 - slot, type, layout.x,
      DEFAULT_TUNING.dropHeight + slot * spacing * FEED_TRAY_SIN,
      PLAYER_DROP_Z - slot * spacing * FEED_TRAY_COS,
      { rotation: FEED_TRAY_ROTATION },
    )),
  }));
  return {
    simulation,
    step: () => ({
      events: [],
      gizmoEvents: [],
      combat: {
        state: {
          playerHp: 73,
          enemies: snapshot().enemies,
          currency: 14,
          result: null,
          totals: emptyTotals(),
          combo: { chain: 0, lastSwordTick: null },
        },
        delta: emptyTotals(),
        effects: [],
      },
      admissions: [],
      waveEvents: [],
    }),
    setAim() {},
    drop: () => false,
    cancelDrops() {},
    setPaused() {},
    snapshot: () => snapshot(recentEffects),
    preview: () => trays,
    reset() {},
    dispose() {},
  };
}

function advance(encounter: Encounter, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) encounter.step();
}

describe("combat-readable observation", () => {
  it("does not reveal an unobstructed cap outside the camera frame", () => {
    const observer = createCombatObserver();
    try {
      const observation = observer.observe(
        encounterFixture([coin(501, "skull", 50, 0.2, 1)]),
      );
      expect(observation.exposedCoins).toEqual([]);
    } finally {
      observer.dispose();
    }
  });

  it("keeps buried types hidden while reading exposed, transformed, and armed caps", () => {
    const threshold = DEFAULT_ENCOUNTER_CONFIG.bomb.hitThreshold;
    const hiddenSword = coin(101, "sword", 0, 0.07, 1);
    const exposedGold = coin(102, "gold", 0, 0.22, 1);
    const armedBomb = coin(103, "bomb", -2.2, 0.12, 3.5, {
      bombHits: threshold - 1,
    });
    const transformedPotion = coin(104, "potion", 2.204, 0.344, 1.254, {
      rotation: {
        x: Math.SQRT1_2,
        y: 0,
        z: 0,
        w: Math.SQRT1_2,
      },
    });
    const delta = emptyTotals();
    delta.currencyGained = 10;
    const recent: CombatStepResult = {
      state: {
        playerHp: 73,
        enemies: snapshot().enemies,
        currency: 14,
        result: null,
        totals: { ...delta },
        combo: { chain: 0, lastSwordTick: null },
      },
      delta,
      effects: [
        {
          id: 909,
          type: "diamond",
          position: { x: 0.123, y: -0.5, z: 4.2 },
          enemyDamage: 0,
          swordMultiplier: 0,
          enemyHits: [],
          discardedDamage: 0,
          playerDamage: 0,
          healingOffered: 0,
          currency: 10,
          safeBomb: false,
          detonated: false,
          blastAssociated: false,
        },
      ],
    };
    const encounter = encounterFixture(
      [hiddenSword, exposedGold, armedBomb, transformedPotion],
      [recent],
    );
    const observer = createCombatObserver();

    try {
      const observation = observer.observe(encounter);
      expect(observation.exposedCoins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "gold",
            position: { x: 0, y: 0.22, z: 1 },
          }),
          expect.objectContaining({
            type: "potion",
            position: { x: 2.2, y: 0.34, z: 1.25 },
          }),
          expect.objectContaining({
            type: "bomb",
            bombHits: threshold - 1,
            nearThreshold: true,
          }),
        ]),
      );
      expect(
        observation.exposedCoins.some((value) => value.type === "sword"),
      ).toBe(false);
      expect(observation.board.active).toBe(3);
      expect(observation.board.lanes[2]!.lowerMiddle.count).toBe(1);
      const bombLane = laneForX(armedBomb.position.x)!;
      expect(observation.lanes[bombLane]!.nearEdge).toMatchObject({
        counts: { bomb: 1 },
        nearThresholdBombs: 1,
      });
      expect(observation.board.phase).toBe(0.25);
      expect(observation).toMatchObject({
        playerHp: 73,
        enemies: [{ id: "encounter-1-wave-1-guard", hp: 91, maxHp: 120 }],
        frontEnemyId: "encounter-1-wave-1-guard",
        waveIndex: 0,
        waveCount: 1,
        livingWaveHp: 91,
        currency: 14,
        rules: {
          swordDamage: DEFAULT_ENCOUNTER_CONFIG.swordDamage,
          skullDamage: DEFAULT_ENCOUNTER_CONFIG.skullDamage,
          potionHealing: DEFAULT_ENCOUNTER_CONFIG.potionHealing,
          bombDamage: 5,
          bomb: DEFAULT_ENCOUNTER_CONFIG.bomb,
        },
      });
      expect(observation.recentEffects[0]!.delta.currencyGained).toBe(10);
      expect(observation.recentEffects[0]!.effects[0]).not.toHaveProperty("id");
      expect(observation.exposedCoins[0]).not.toHaveProperty("id");
      expect(observation).not.toHaveProperty("lastAdmission");
      expect(observation).not.toHaveProperty("setup");
      expect(observation).not.toHaveProperty("openingMix");
      expect(observation.feed[0]!.preview).toEqual([
        "sword",
        "bomb",
        "sword",
        "sword",
        "sword",
      ]);
    } finally {
      observer.dispose();
    }
  });

  it("derives five safe candidates and their real synchronized chute coordinates", () => {
    const encounter = encounterFixture([]);
    const observer = createCombatObserver();
    try {
      const observation = observer.observe(encounter);
      expect(observation.candidates).toHaveLength(5);
      expect(observation.candidates.map(({ aimX }) => aimX)).toEqual(
        observation.candidates
          .map(({ aimX }) => aimX)
          .slice()
          .sort((left, right) => left - right),
      );
      for (const candidate of observation.candidates) {
        expect(candidate.chutes).toEqual([
          expect.objectContaining({
            x: candidate.aimX,
            source: "player",
            id: "study-player",
            ownerId: "study-player",
            slot: 0,
            enabled: true,
          }),
          expect.objectContaining({
            x: candidate.aimX - 0.66,
            source: "enemy",
            id: "study-enemy-0",
            ownerId: "study-enemy-0",
            slot: -1,
            enabled: true,
          }),
          expect.objectContaining({
            x: candidate.aimX + 0.66,
            source: "enemy",
            id: "study-enemy-1",
            ownerId: "study-enemy-1",
            slot: 1,
            enabled: true,
          }),
        ]);
        expect(candidate.chutes.every(({ x }) => Math.abs(x) < 5)).toBe(true);
      }
    } finally {
      observer.dispose();
    }
  });

  it("projects the exact face-up feed consumed by a real admitted round", async () => {
    const encounter = await createEncounter({ density: 0, seed: 307 }, {
      waves: [{
        id: "observation-wave",
        enemies: [{
          id: "observation-guard",
          name: "Guard",
          maxHp: 120,
          chuteId: "observation-guard-chute",
          bag: ["skull", "skull", "skull", "skull", "skull"],
          kind: "guard",
        }],
      }],
    });
    const observer = createCombatObserver();
    try {
      advance(encounter, 720);
      expect(encounter.snapshot().phase).toBe("active");
      const before = observer.observe(encounter).feed;
      const beforePlayer = before.find((tray) => tray.source === "player")!;
      expect(beforePlayer.preview).toHaveLength(5);

      expect(encounter.drop(0)).toBe(true);
      expect(encounter.snapshot().lastAdmission?.coins.find(({ chuteId }) => chuteId === beforePlayer.id)?.type).toBe(
        beforePlayer.preview[0],
      );

      const after = observer.observe(encounter).feed;
      expect(after.find((tray) => tray.source === "player")!).not.toHaveProperty("coins");
      expect(after.find((tray) => tray.source === "player")!.preview.slice(0, 4)).toEqual(
        beforePlayer.preview.slice(1),
      );
    } finally {
      observer.dispose();
      encounter.dispose();
    }
  });
  it("does not expose a coin cap hidden by the physical mascot silhouette", () => {
    const visible = coin(911, "gold", 0, 0.22, 1);
    const mascot: GizmoView = { id: 912, kind: "bell", radius: 0.38, density: 1.5, payout: 3,
      position: { x: 0, y: 0.75, z: 1.3 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
    const observer = createCombatObserver();
    try {
      expect(observer.observe(encounterFixture([visible])).exposedCoins.map(({ type }) => type)).toEqual(["gold"]);
      const covered = observer.observe(encounterFixture([visible], [], [mascot]));
      expect(covered.exposedCoins).toEqual([]);
      expect(covered.board.active).toBe(0);
    } finally { observer.dispose(); }
  });
});
