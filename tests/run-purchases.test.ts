import { describe, expect, it } from "vitest";
import { createRun } from "../src/run/run";
import type { PurchaseFailure, PurchaseRequest, Run } from "../src/run/types";
import type { CoinType } from "../src/contracts";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";
import { createChuteFeed } from "../src/combat/feed";
import { bagCounts } from "../src/run/purchases";

function catchCoin(run: Run, type: CoinType): void {
  const native = run.simulation as unknown as { world: RapierWorld; lifecycle: CoinLifecycle };
  const coin = native.lifecycle.spawn({ x: 0, y: -0.7, z: 4.5 }, { x: 0, y: 0, z: 0, w: 1 },
    run.simulation.tuning.radius, run.simulation.tuning.thickness, type);
  expect(native.world.addCylinder(coin.id, coin)).toBe(true);
  run.step();
}
async function shop(diamonds = 0): Promise<Run> {
  const run = await createRun({ density: 0, seed: 503 });
  try {
    run.chooseStarter("collector");
    for (let index = 0; index < diamonds; index++) catchCoin(run, "diamond");
    for (let index = 0; index < 100 && run.snapshot().phase === "encounter"; index++) catchCoin(run, "sword");
    expect(run.snapshot().phase).toBe("shop");
    return run;
  } catch (error) { run.dispose(); throw error; }
}
function rejectedWithoutMutation(run: Run, request: PurchaseRequest, code: PurchaseFailure): void {
  const before = run.snapshot();
  const preview = run.previewPurchase(request);
  expect(preview).toMatchObject({ allowed: false, blocker: code });
  expect(run.snapshot()).toEqual(before);
  expect(run.purchase(request)).toEqual({ success: false, code, preview });
  expect(run.snapshot()).toEqual(before);
}

describe("transactional run shop", () => {
  it("previews a legal swap without consuming feed state and commits exactly that transition", async () => {
    const run = await shop();
    try {
      const before = run.snapshot();
      const request = { offerId: "potion-pack", chuteId: "player-0", replaceType: "sword" } as const;
      const preview = run.previewPurchase(request);
      expect(preview).toMatchObject({ allowed: true, blocker: null, cost: 8, remainingMoney: 4,
        resultingChuteCount: 1, resultingStickerCount: 1 });
      expect(preview.currentCounts[0]!.counts).toEqual({ sword: 3, potion: 1, gold: 1, diamond: 0, skull: 0, bomb: 0 });
      expect(preview.resultingCounts[0]!.counts).toEqual({ sword: 2, potion: 2, gold: 1, diamond: 0, skull: 0, bomb: 0 });
      expect(run.snapshot()).toEqual(before);
      expect(run.purchase(request)).toEqual({ success: true, preview });
      expect(run.snapshot()).toMatchObject({ currency: 4, earnedCurrency: 12, spentCurrency: 8,
        purchases: [{ encounterIndex: 0, request, cost: 8 }] });
      const bag = run.snapshot().playerChutes[0]!.bag;
      const feed = createChuteFeed(113, bag);
      for (let cycle = 0; cycle < 4; cycle++) {
        const emitted: CoinType[] = [];
        for (let coin = 0; coin < 5; coin++) {
          const expected = feed.preview()[0];
          expect(feed.preview()[0]).toBe(expected);
          emitted.push(feed.consume());
          expect(emitted.at(-1)).toBe(expected);
        }
        expect(bagCounts(emitted)).toEqual(preview.resultingCounts[0]!.counts);
      }
      run.continueRun();
      for (let tick = 0; tick < 720; tick++) run.step();
      const nativeLane = run.encounter.preview().find(({ id }) => id === "player-0")!;
      expect(bagCounts(nativeLane.preview)).toEqual(preview.resultingCounts[0]!.counts);
      expect(nativeLane.coins.map(({ type }) => type)).toEqual(nativeLane.preview);
      const admitted: CoinType[] = [];
      for (let round = 0; round < 10; round++) {
        expect(run.drop(0)).toBe(true);
        for (let tick = 0; tick < 500 && admitted.length <= round; tick++) {
          const step = run.step();
          for (const fragment of step.admissions) {
            for (const coin of fragment.coins) if (coin.chuteId === "player-0") admitted.push(coin.type);
          }
        }
        expect(admitted).toHaveLength(round + 1);
        for (let tick = 0; tick < 180; tick++) run.step();
      }
      expect(bagCounts(admitted.slice(0, 5))).toEqual(preview.resultingCounts[0]!.counts);
      expect(bagCounts(admitted.slice(5, 10))).toEqual(preview.resultingCounts[0]!.counts);
    } finally { run.dispose(); }
  });

  it("retains an unaffordable outcome preview but rejects the transaction without a partial charge", async () => {
    const run = await shop();
    try {
      const preview = run.previewPurchase({ offerId: "tempered-swords" });
      expect(preview).toMatchObject({ allowed: false, blocker: "insufficient-currency", cost: 16, remainingMoney: -4,
        currentBuild: { swordDamage: 3 }, resultingBuild: { swordDamage: 4 } });
      rejectedWithoutMutation(run, { offerId: "tempered-swords" }, "insufficient-currency");
      expect(run.purchase({ offerId: "potion-pack", chuteId: "player-0", replaceType: "sword" }).success).toBe(true);
      rejectedWithoutMutation(run, { offerId: "potion-pack", chuteId: "player-0", replaceType: "sword" }, "insufficient-currency");
    } finally { run.dispose(); }
  });

  it("rejects unknown offers, missing chutes, unavailable source tokens and prohibited swaps", async () => {
    const run = await shop(10);
    try {
      rejectedWithoutMutation(run, { offerId: "unknown" } as unknown as PurchaseRequest, "unknown-offer");
      rejectedWithoutMutation(run, { offerId: "potion-pack", chuteId: "missing", replaceType: "sword" }, "unknown-chute");
      rejectedWithoutMutation(run, { offerId: "extra-chute", chuteId: "missing" }, "unknown-chute");
      rejectedWithoutMutation(run, { offerId: "potion-pack", chuteId: "player-0", replaceType: "bomb" }, "invalid-replacement");
      rejectedWithoutMutation(run, { offerId: "potion-pack", chuteId: "player-0", replaceType: "potion" }, "invalid-replacement");
      rejectedWithoutMutation(run, { offerId: "diamond-mint", chuteId: "player-0", replaceType: "sword" }, "invalid-replacement");
      rejectedWithoutMutation(run, { offerId: "gold-pack", chuteId: "player-0", replaceType: "skull" }, "invalid-replacement");
      rejectedWithoutMutation(run, { offerId: "sword-pack", chuteId: "player-0" } as PurchaseRequest, "invalid-replacement");
    } finally { run.dispose(); }
  });

  it("revalidates stale previews and allows repeated packs only while the selected source exists", async () => {
    const run = await shop(10);
    try {
      const request = { offerId: "sword-pack", chuteId: "player-0", replaceType: "gold" } as const;
      expect(run.previewPurchase(request).allowed).toBe(true);
      expect(run.purchase(request).success).toBe(true);
      rejectedWithoutMutation(run, request, "invalid-replacement");
      const repeat = { offerId: "potion-pack", chuteId: "player-0", replaceType: "sword" } as const;
      for (let index = 0; index < 4; index++) expect(run.purchase(repeat).success).toBe(true);
      expect(run.snapshot().playerChutes[0]!.bag).toEqual(Array(5).fill("potion"));
      expect(run.snapshot()).toMatchObject({ currency: 72, spentCurrency: 40 });
      rejectedWithoutMutation(run, repeat, "invalid-replacement");
    } finally { run.dispose(); }
  });

  it("clones the selected current composition independently and rejects a fourth chute", async () => {
    const run = await shop(20);
    try {
      run.purchase({ offerId: "potion-pack", chuteId: "player-0", replaceType: "sword" });
      const clone = run.previewPurchase({ offerId: "extra-chute", chuteId: "player-0" });
      expect(clone).toMatchObject({ allowed: true, cost: 28, resultingChuteCount: 2 });
      expect(clone.resultingCounts[1]!.counts).toEqual(clone.currentCounts[0]!.counts);
      expect(run.purchase({ offerId: "extra-chute", chuteId: "player-0" }).success).toBe(true);
      expect(run.purchase({ offerId: "potion-pack", chuteId: "player-0", replaceType: "sword" }).success).toBe(true);
      expect(bagCounts(run.snapshot().playerChutes[0]!.bag)).toMatchObject({ sword: 1, potion: 3 });
      expect(bagCounts(run.snapshot().playerChutes[1]!.bag)).toMatchObject({ sword: 2, potion: 2 });
      expect(run.purchase({ offerId: "extra-chute", chuteId: "player-1" }).success).toBe(true);
      expect(run.snapshot().playerChutes.map(({ id }) => id)).toEqual(["player-0", "player-1", "player-2"]);
      expect(run.snapshot().playerChutes[2]!.bag).toEqual(run.snapshot().playerChutes[1]!.bag);
      rejectedWithoutMutation(run, { offerId: "extra-chute", chuteId: "player-2" }, "limit-reached");
    } finally { run.dispose(); }
  });

  it("caps effect upgrades at two and applies physical modifiers before additive upgrades", async () => {
    const run = await shop(20);
    try {
      for (let index = 0; index < 2; index++) {
        expect(run.purchase({ offerId: "tempered-swords" }).success).toBe(true);
        expect(run.purchase({ offerId: "restorative-brew" }).success).toBe(true);
      }
      rejectedWithoutMutation(run, { offerId: "tempered-swords" }, "limit-reached");
      rejectedWithoutMutation(run, { offerId: "restorative-brew" }, "limit-reached");
      expect(run.snapshot().build).toMatchObject({ swordDamage: 5, potionHealing: 8 });
      const preview = run.previewPurchase({ offerId: "miniature" });
      expect(preview.resultingBuild).toMatchObject({ swordDamage: 4, potionHealing: 8, tuning: { radius: 0.24, thickness: 0.0975 } });
      expect(run.purchase({ offerId: "miniature" }).success).toBe(true);
      expect(run.snapshot().build).toEqual(preview.resultingBuild);
    } finally { run.dispose(); }
  });

  it("owns unique stickers only once, counts the starter slot, and never charges for a fourth", async () => {
    const run = await shop(20);
    try {
      rejectedWithoutMutation(run, { offerId: "collected-only" }, "already-owned");
      expect(run.purchase({ offerId: "combo-bell" }).success).toBe(true);
      rejectedWithoutMutation(run, { offerId: "combo-bell" }, "already-owned");
      expect(run.purchase({ offerId: "magazine-dump" }).success).toBe(true);
      expect(run.snapshot()).toMatchObject({ stickers: ["collected-only", "combo-bell", "magazine-dump"], spentCurrency: 42, currency: 170 });
      rejectedWithoutMutation(run, { offerId: "miniature" }, "limit-reached");
      rejectedWithoutMutation(run, { offerId: "combo-bell" }, "already-owned");
    } finally { run.dispose(); }
  });

  it("supports gold and diamond composition, and protects ownership from mutable returned data", async () => {
    const run = await shop(10);
    try {
      expect(run.purchase({ offerId: "gold-pack", chuteId: "player-0", replaceType: "sword" }).success).toBe(true);
      expect(run.purchase({ offerId: "diamond-mint", chuteId: "player-0", replaceType: "gold" }).success).toBe(true);
      expect(bagCounts(run.snapshot().playerChutes[0]!.bag)).toMatchObject({ sword: 2, gold: 1, diamond: 1, potion: 1 });
      const snapshot = run.snapshot();
      (snapshot.playerChutes[0]!.bag as CoinType[])[0] = "skull";
      snapshot.effectLevels.temperedSwords = 99;
      const preview = run.previewPurchase({ offerId: "extra-chute", chuteId: "player-0" });
      preview.resultingCounts[0]!.counts.skull = 5;
      expect(run.snapshot().playerChutes[0]!.bag).not.toContain("skull");
      expect(run.snapshot().effectLevels.temperedSwords).toBe(0);
      run.continueRun();
      rejectedWithoutMutation(run, { offerId: "tempered-swords" }, "not-in-shop");
      run.restart();
      rejectedWithoutMutation(run, { offerId: "extra-chute", chuteId: "player-0" }, "not-in-shop");
    } finally { run.dispose(); }
  });
});
