import { describe, expect, it } from "vitest";
import {
  runReleaseTrial,
  summarizeReleases,
  validateAction,
} from "../scripts/release-trial";

describe("release-level payout accounting", () => {
  it("does not call one large avalanche near-every-release success", () => {
    const windows = Array.from({ length: 10 }, (_, i) => ({
      collected: i === 0 ? 12 : 0,
      idleCollected: 0,
      accepted: 1,
    }));
    const summary = summarizeReleases(windows);
    expect(summary.collectedPerCoin).toBe(1.2);
    expect(summary.hitRate).toBe(0.1);
    expect(summary.longestDry).toBe(9);
    expect(summary.meetsTarget).toBe(false);
  });

  it("requires at least ninety percent, not a rounded percentage", () => {
    const windows = Array.from({ length: 10 }, (_, i) => ({
      collected: i === 0 ? 0 : 1,
      idleCollected: 0,
      accepted: 1,
    }));
    expect(summarizeReleases(windows).meetsTarget).toBe(true);
    windows[1]!.collected = 0;
    expect(summarizeReleases(windows).meetsTarget).toBe(false);
  });

  it("retains negative differences from autonomous payouts and charges all burst coins", () => {
    const summary = summarizeReleases([
      { collected: 2, idleCollected: 5, accepted: 3 },
      { collected: 0, idleCollected: 1, accepted: 3 },
      { collected: 1, idleCollected: 0, accepted: 3 },
    ]);
    expect(summary.hitCount).toBe(2);
    expect(summary.idleHitRate).toBeCloseTo(2 / 3);
    expect(summary.additionalCollections).toBe(-3);
    expect(summary.excessWindows).toBe(1);
    expect(summary.collectedPerCoin).toBeCloseTo(1 / 3);
  });

  it("rejects decisions outside the physical lane and wait choices", () => {
    expect(() => validateAction({ lane: 5, waitQuarters: 0 })).toThrow();
    expect(() => validateAction({ lane: 0.5, waitQuarters: 0 })).toThrow();
    expect(() => validateAction({ lane: 0, waitQuarters: 4 as 0 })).toThrow();
    expect(() =>
      validateAction({ lane: Number.NaN, waitQuarters: 0 }),
    ).toThrow();
  });

  it("admits every physical burst coin in disjoint release windows", async () => {
    const result = await runReleaseTrial({
      seed: 42,
      density: 0,
      stroke: 2,
      shelfFront: 4,
      mode: "chute",
      policy: "center",
      coinsPerRelease: 3,
      releases: 2,
    });
    expect(result.accepted).toBe(6);
    expect(result.active + result.collected).toBe(6);
    expect(result.windows.map((w) => w.accepted)).toEqual([3, 3]);
    expect(result.windows[1]!.startTick).toBe(result.windows[0]!.endTick);
    expect(result.windows.map((w) => w.endTick - w.startTick)).toEqual([
      144, 144,
    ]);
    expect(result.idleCollected).toBe(0);
  });

  it("tracks atomic stack provenance and the full three-coin budget", async () => {
    const result = await runReleaseTrial({
      seed: 42,
      density: 0,
      stroke: 2,
      shelfFront: 4,
      mode: "chute",
      policy: "center",
      coinsPerRelease: 3,
      releases: 1,
      pattern: "stack",
    });

    expect(result.accepted).toBe(3);
    expect(result.acceptedPlayer).toBe(3);
    expect(result.acceptedEnemy).toBe(0);
    expect(result.collections.enemy).toBe(0);
    expect(result.windows[0]!.chutePositions).toEqual([0]);
    expect(result.settledActive + result.accepted).toBe(
      result.active + result.collected,
    );
  });

  it("keeps matching flank inputs in the enemy-only control", async () => {
    const result = await runReleaseTrial({
      seed: 42,
      density: 0,
      stroke: 2,
      shelfFront: 4,
      mode: "chute",
      policy: "center",
      coinsPerRelease: 3,
      releases: 1,
      pattern: "flanks",
      spacing: 1.5,
      enemyCoins: 3,
    });

    expect(result.accepted).toBe(9);
    expect(result.acceptedPlayer).toBe(3);
    expect(result.acceptedEnemy).toBe(6);
    expect(result.windows[0]!.chutePositions).toEqual([-1.5, 0, 1.5]);
    expect(result.windows[0]!.enemyOnlyCollections.player).toBe(0);
    expect(result.totalMinusEnemyOnly).toBe(
      result.collected - result.enemyOnlyCollected,
    );
    expect(result.settledActive + result.accepted).toBe(
      result.active + result.collected,
    );
  });
});
