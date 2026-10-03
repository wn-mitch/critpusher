import { describe, expect, it } from "vitest";
import type { CoinType } from "../src/contracts";
import {
  chooseCombatCenterAction,
  chooseCombatRuleAction,
  createCombatRandomPolicy,
} from "../src/experiments/combat-policy";
import type {
  CombatLaneSummary,
  CombatSolverState,
  CombatTypeCounts,
  LaneBoard,
  SolverLane,
  SurfaceCell,
} from "../src/experiments/solver-contracts";

function cell(): SurfaceCell {
  return { count: 0, meanHeight: null, meanForwardSpeed: null };
}

function physicalLane(index: number): SolverLane {
  return {
    index,
    aimX: -4 + index * 2,
    upper: cell(),
    lowerRear: cell(),
    lowerMiddle: cell(),
    lowerFront: cell(),
    nearEdge: 0,
    edgeGap: null,
    recentCollected: 0,
  };
}

function counts(
  patch: Partial<Record<CoinType, number>> = {},
  nearThresholdBombs = 0,
): CombatTypeCounts {
  return {
    counts: {
      gold: 0,
      diamond: 0,
      sword: 0,
      skull: 0,
      potion: 0,
      bomb: 0,
      ...patch,
    },
    nearThresholdBombs,
  };
}

function combatLane(index: number): CombatLaneSummary {
  return {
    index,
    upper: counts(),
    lowerRear: counts(),
    lowerMiddle: counts(),
    lowerFront: counts(),
    nearEdge: counts(),
  };
}

function combatState(): CombatSolverState {
  const lanes = Array.from({ length: 5 }, (_, index) => physicalLane(index));
  const board: LaneBoard = {
    time: 0,
    sampleSeconds: 0.25,
    phase: 0.3,
    period: 2.4,
    pusherFront: -1,
    shelfFront: 4,
    active: 0,
    airborne: 0,
    falling: 0,
    lanes,
  };
  return {
    observation: {
      visibilityModel: "three-cap-rays-v3",
      board,
      playerHp: 90,
      playerMaxHp: 100,
      enemies: [{
        id: "encounter-1-wave-1-guard",
        name: "Guard",
        hp: 100,
        maxHp: 120,
        chuteId: "enemy-guard",
        admittedRounds: 0,
        kind: "guard",
      }],
      frontEnemyId: "encounter-1-wave-1-guard",
      waveIndex: 0,
      waveCount: 1,
      livingWaveHp: 100,
      currency: 0,
      ownedBuild: {
        bags: [], stickers: [], effectLevels: { temperedSwords: 0, restorativeBrew: 0 },
        releaseMode: "ordinary", detonationPolicy: "physical",
        coinRadius: 0.32, coinThickness: 0.13, openingPopulation: 400, coinWeight: 1,
      },
      combo: { chain: 0, lastSwordTick: null, windowTicks: 0, maxMultiplier: 1, ticksRemaining: 0 },
      rules: {
        swordDamage: 3,
        skullDamage: 2,
        potionHealing: 4,
        bombDamage: 5,
        bomb: {
          hitThreshold: 3,
          minClosingSpeed: 0.75,
          blastRadius: 1.75,
          blastDeltaSpeed: 3,
        },
      },
      candidates: Array.from({ length: 5 }, (_, lane) => ({
        aimX: -4 + lane * 2,
        chutes: [
          { id: `player-${lane}`, ownerId: "player", slot: 0, enabled: true, x: -4 + lane * 2, source: "player" as const },
          { id: `enemy-left-${lane}`, ownerId: "guard", slot: -1, enabled: true, x: -4.33 + lane * 2, source: "enemy" as const },
          { id: `enemy-right-${lane}`, ownerId: "guard", slot: 1, enabled: true, x: -3.67 + lane * 2, source: "enemy" as const },
        ],
      })),
      feed: [
        {
          id: "player-0",
          ownerId: "player",
          slot: 0,
          enabled: true,
          x: 0,
          source: "player",
          preview: ["sword", "sword", "sword", "sword", "bomb"],
        },
      ],
      exposedCoins: [],
      lanes: Array.from({ length: 5 }, (_, index) => combatLane(index)),
      recentEffects: [],
    },
    candidateAimXs: [-4, -2, 0, 2, 4],
    timing: "adaptive",
  };
}

describe("combat policies", () => {
  it("prefers helpful exposed effects and avoids harmful ones", () => {
    const helpful = combatState();
    helpful.observation.lanes[0]!.nearEdge.counts.sword = 1;
    helpful.observation.lanes[1]!.nearEdge.counts.skull = 1;
    expect(chooseCombatRuleAction(helpful).action.lane).toBe(0);

    const harmful = combatState();
    harmful.observation.lanes[0]!.nearEdge.counts.skull = 1;
    harmful.observation.lanes[1]!.nearEdge.counts.sword = 1;
    expect(chooseCombatRuleAction(harmful).action.lane).toBe(1);
  });

  it("uses configured damage and caps potion value to missing health", () => {
    const configured = combatState();
    configured.observation.lanes[0]!.nearEdge.counts.sword = 1;
    configured.observation.lanes[1]!.nearEdge.counts.diamond = 2;
    expect(chooseCombatRuleAction(configured).action.lane).toBe(1);
    configured.observation.rules.swordDamage = 6;
    expect(chooseCombatRuleAction(configured).action.lane).toBe(0);

    const healing = combatState();
    healing.observation.playerHp = 98;
    healing.observation.lanes[0]!.nearEdge.counts.potion = 1;
    healing.observation.lanes[1]!.nearEdge.counts.gold = 9;
    expect(chooseCombatRuleAction(healing).action.lane).toBe(1);
    healing.observation.playerHp = 90;
    expect(chooseCombatRuleAction(healing).action.lane).toBe(0);
  });

  it("penalizes armed upper-band bombs only for an upcoming bomb", () => {
    const state = combatState();
    state.observation.lanes[2]!.upper.nearThresholdBombs = 1;
    expect(chooseCombatRuleAction(state).action.lane).toBe(2);

    state.observation.feed[0]!.preview = [
      "bomb",
      "sword",
      "sword",
      "sword",
      "sword",
    ];
    expect(chooseCombatRuleAction(state).action.lane).toBe(1);
  });

  it("avoids a near-edge armed bomb even when the next token is a sword", () => {
    const state = combatState();
    state.observation.board.lanes[2]!.lowerFront.count = 2;
    state.observation.board.lanes[2]!.nearEdge = 2;
    state.observation.lanes[2]!.nearEdge = counts({ bomb: 1, gold: 1 }, 1);
    state.observation.board.lanes[1]!.lowerFront.count = 1;
    state.observation.board.lanes[1]!.nearEdge = 1;
    state.observation.lanes[1]!.nearEdge = counts({ diamond: 1 });
    expect(chooseCombatRuleAction(state).action.lane).toBe(1);
  });

  it("preserves the suggested wait for a separate fixed-timing executor", () => {
    const state = combatState();
    expect(chooseCombatCenterAction().action).toEqual({ lane: 2, waitQuarters: 0 });
    expect(chooseCombatRuleAction(state).action).toEqual({ lane: 2, waitQuarters: 3 });
    state.timing = "fixed";
    expect(chooseCombatRuleAction(state).action).toEqual({ lane: 2, waitQuarters: 3 });
  });

  it("uses a repeatable seeded uniform placement baseline", () => {
    const first = createCombatRandomPolicy(42);
    const second = createCombatRandomPolicy(42);
    const firstActions = Array.from({ length: 8 }, () => first(combatState()).action);
    const secondActions = Array.from({ length: 8 }, () => second(combatState()).action);
    expect(firstActions).toEqual(secondActions);
    expect(firstActions.every((action) => action.waitQuarters === 0)).toBe(true);
    expect(firstActions.every((action) => action.lane >= 0 && action.lane < 5)).toBe(true);
  });
  it("uses zero detonation HP for collected-only without treating skulls as harmless", () => {
    const state = combatState();
    state.observation.feed[0]!.source = "enemy";
    state.observation.feed[0]!.preview = ["bomb", "skull", "gold", "skull", "skull"];
    state.observation.lanes[2]!.upper.nearThresholdBombs = 1;
    state.observation.lanes[2]!.nearEdge = counts({ gold: 1, bomb: 1 }, 1);
    expect(chooseCombatRuleAction(state).action.lane).toBe(1);
    state.observation.rules.bombDamage = 0;
    state.observation.ownedBuild.detonationPolicy = "collected-only";
    state.observation.ownedBuild.stickers = ["collected-only"];
    expect(chooseCombatRuleAction(state).action.lane).toBe(2);
    state.observation.lanes[2]!.nearEdge.counts.skull = 1;
    expect(chooseCombatRuleAction(state).action.lane).toBe(1);
  });

  it("values a live combo but does not carry its multiplier past expiry", () => {
    const state = combatState();
    state.observation.lanes[0]!.nearEdge.counts.sword = 1;
    state.observation.lanes[1]!.nearEdge.counts.gold = 16;
    expect(chooseCombatRuleAction(state).action.lane).toBe(1);
    state.observation.combo = { chain: 1, lastSwordTick: 10, windowTicks: 144, maxMultiplier: 3, ticksRemaining: 143 };
    expect(chooseCombatRuleAction(state).action.lane).toBe(0);
    state.observation.combo = { ...state.observation.combo, chain: 0, lastSwordTick: null, ticksRemaining: 0 };
    expect(chooseCombatRuleAction(state).action.lane).toBe(1);
  });
});
