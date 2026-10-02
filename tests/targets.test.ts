import { describe, expect, it } from "vitest";
import type { CoinView } from "../src/contracts";
import { selectTargets } from "../src/experiments/targets";

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

describe("placement target selection", () => {
  it("ranks up to three coins per lane deterministically", () => {
    const coins = new Map([
      [9, coin(9, 0.2, 0.25, 3.3)],
      [3, coin(3, -3.1, 0.25, 3.8)],
      [4, coin(4, -2.8, 0.25, 3.4)],
      [7, coin(7, 2.9, 0.25, 3.7)],
      [8, coin(8, 2.7, 0.25, 3.1)],
      [10, coin(10, 0.1, 0.25, 3.3)],
    ]);

    expect([...selectTargets(coins, 4)]).toEqual([
      [3, 0],
      [4, 0],
      [10, 1],
      [9, 1],
      [7, 2],
      [8, 2],
    ]);
    expect([...selectTargets(new Map([...coins].reverse()), 4)]).toEqual([
      [3, 0],
      [4, 0],
      [10, 1],
      [9, 1],
      [7, 2],
      [8, 2],
    ]);
  });

  it("keeps only the three highest-ranked coins in a lane", () => {
    const coins = new Map([
      [1, coin(1, 0, 0.25, 3.1)],
      [2, coin(2, 0, 0.25, 3.9)],
      [3, coin(3, 0, 0.25, 3.8)],
      [4, coin(4, 0, 0.25, 3.7)],
    ]);

    expect([...selectTargets(coins, 4)]).toEqual([
      [2, 1],
      [3, 1],
      [4, 1],
    ]);
  });

  it("excludes upper, airborne, rear-band, and over-edge bodies", () => {
    const coins = new Map([
      [1, coin(1, -3, 0.7, 3.8)],
      [2, coin(2, 0, 1.2, 3.8)],
      [3, coin(3, 3, 0.25, 4.01)],
      [4, coin(4, -3, 0.25, 3.9)],
      [5, coin(5, 0, -0.01, 3.8)],
      [6, coin(6, 3, 0.25, 2.2)],
    ]);

    expect([...selectTargets(coins, 4)]).toEqual([[4, 0]]);
  });
});
