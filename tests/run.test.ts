import { describe, expect, it } from "vitest";
import { createRun } from "../src/run/run";
import type { Run, StarterId } from "../src/run/types";
import type { CoinType } from "../src/contracts";
import { CoinLifecycle } from "../src/simulation/lifecycle";
import { RapierWorld } from "../src/simulation/rapier-world";
import { deriveSeed } from "../src/random";

function catchCoin(run: Run, type: CoinType) {
  const native = run.simulation as unknown as { world: RapierWorld; lifecycle: CoinLifecycle };
  const coin = native.lifecycle.spawn({ x: 0, y: -0.7, z: 4.5 }, { x: 0, y: 0, z: 0, w: 1 },
    run.simulation.tuning.radius, run.simulation.tuning.thickness, type);
  expect(native.world.addCylinder(coin.id, coin)).toBe(true);
  return run.step();
}
function winEncounter(run: Run): void {
  for (let count = 0; count < 200 && run.snapshot().phase === "encounter"; count++) catchCoin(run, "sword");
  expect(["shop", "won"]).toContain(run.snapshot().phase);
}

describe("run ownership and completion", () => {
  it("stays physically idle until a valid kit and refuses replacement selections", async () => {
    const run = await createRun({ seed: 71 });
    try {
      const initial = run.snapshot();
      expect(initial).toMatchObject({ phase: "starter", playerChutes: [], stickers: [], currency: 0, playerHp: 100 });
      expect(run.simulation.stats().pendingRain).toBe(0);
      expect(run.chooseStarter("missing" as StarterId)).toBe(false);
      expect(run.chooseStarter(undefined as unknown as StarterId)).toBe(false);
      for (let tick = 0; tick < 3; tick++) run.step();
      expect(run.drop(0)).toBe(false);
      expect(run.continueRun()).toBe(false);
      expect(run.snapshot()).toEqual(initial);
      expect(run.chooseStarter("collector")).toBe(true);
      const selected = run.snapshot();
      expect(selected).toMatchObject({ phase: "encounter", selectedStarterId: "collector", stickers: ["collected-only"] });
      expect(selected.playerChutes[0]!.bag).toEqual(["sword", "sword", "sword", "potion", "gold"]);
      expect(run.simulation.tuning.seed).toBe(deriveSeed(71, 0, 0x4f50454e));
      expect(run.chooseStarter("volley")).toBe(false);
      expect(run.snapshot()).toEqual(selected);
    } finally { run.dispose(); }
  });

  it("distinguishes wave entry from opening victory and services payout and capped healing once", async () => {
    const run = await createRun({ density: 0 });
    try {
      run.chooseStarter("collector");
      catchCoin(run, "skull");
      catchCoin(run, "diamond");
      while (run.snapshot().encounter.waveIndex === 0) catchCoin(run, "sword");
      expect(run.snapshot()).toMatchObject({ phase: "encounter", playerHp: 98, currency: 10, completedEncounters: 0,
        recoveries: [], completionServices: [] });
      winEncounter(run);
      const finished = run.snapshot();
      expect(finished).toMatchObject({ phase: "shop", playerHp: 100, currency: 22, earnedCurrency: 22, completedEncounters: 1 });
      expect(finished.encounter).toMatchObject({ acceptedActions: 0, acceptedRounds: 0, playerHp: 98 });
      expect(finished.recoveries).toEqual([{ encounterIndex: 0, offered: 12, used: 2, wasted: 10 }]);
      expect(finished.completionServices).toEqual([{ serial: finished.encounter.completionSerial, encounterIndex: 0,
        reward: 12, recovery: finished.recoveries[0] }]);
      const stats = run.simulation.stats();
      for (let tick = 0; tick < 10; tick++) run.step();
      expect(run.drop(0)).toBe(false);
      expect(run.snapshot()).toEqual(finished);
      expect(run.simulation.stats()).toEqual(stats);
    } finally { run.dispose(); }
  });

  it("freezes canceled partial opening rain and creates only the next encounter's fresh rain", async () => {
    const run = await createRun({ density: 400 });
    try {
      run.chooseStarter("collector");
      const simulation = run.simulation;
      winEncounter(run);
      expect(run.snapshot().encounter.acceptedActions).toBe(0);
      expect(simulation.stats().pendingRain).toBe(0);
      const ids = new Set(simulation.coins.keys());
      expect(run.continueRun()).toBe(true);
      expect(run.simulation).toBe(simulation);
      expect(simulation.coins.size).toBe(0);
      expect(simulation.stats().pendingRain).toBe(400);
      run.step();
      expect([...simulation.coins.keys()].some((id) => ids.has(id))).toBe(false);
      expect(run.snapshot().encounterIndex).toBe(1);
    } finally { run.dispose(); }
  });

  it("offers no reward, recovery, or shop on lethal loading", async () => {
    const run = await createRun({ density: 0 });
    try {
      run.chooseStarter("collector");
      for (let count = 0; count < 50; count++) catchCoin(run, "skull");
      const lost = run.snapshot();
      expect(lost).toMatchObject({ phase: "lost", playerHp: 0, currency: 0, earnedCurrency: 0,
        completedEncounters: 0, recoveries: [] });
      expect(lost.completionServices).toEqual([{ serial: lost.encounter.completionSerial, encounterIndex: 0, reward: 0, recovery: null }]);
      expect(run.continueRun()).toBe(false);
      run.step();
      expect(run.snapshot()).toEqual(lost);
    } finally { run.dispose(); }
  });

  it("rewards all three encounters but never heals or opens a fourth shop after the final win", async () => {
    const run = await createRun({ density: 0 });
    try {
      run.chooseStarter("collector");
      for (let index = 0; index < 3; index++) {
        catchCoin(run, "skull");
        winEncounter(run);
        if (index < 2) expect(run.continueRun()).toBe(true);
      }
      expect(run.snapshot()).toMatchObject({ phase: "won", completedEncounters: 3, playerHp: 98, currency: 36, earnedCurrency: 36 });
      expect(run.snapshot().recoveries).toHaveLength(2);
      expect(run.snapshot().completionServices.map(({ reward, recovery }) => [reward, recovery?.used ?? null])).toEqual([[12, 2], [12, 2], [12, null]]);
      expect(run.continueRun()).toBe(false);
      run.step();
      expect(run.snapshot().currency).toBe(36);
    } finally { run.dispose(); }
  });

  it("carries purchases, exact HP and money into fresh native lanes and upgraded combat", async () => {
    const run = await createRun({ density: 0, seed: 113 });
    try {
      run.chooseStarter("collector");
      for (let index = 0; index < 10; index++) catchCoin(run, "skull");
      for (let index = 0; index < 6; index++) catchCoin(run, "diamond");
      winEncounter(run);
      const chuteId = run.snapshot().playerChutes[0]!.id;
      expect(run.purchase({ offerId: "potion-pack", chuteId, replaceType: "sword" }).success).toBe(true);
      expect(run.purchase({ offerId: "tempered-swords" }).success).toBe(true);
      expect(run.purchase({ offerId: "extra-chute", chuteId }).success).toBe(true);
      const shop = run.snapshot();
      expect(shop).toMatchObject({ playerHp: 92, currency: 20, earnedCurrency: 72, spentCurrency: 52 });
      const native = run.simulation as unknown as { world: RapierWorld };
      const oldWorld = native.world;
      expect(run.continueRun()).toBe(true);
      expect(native.world).not.toBe(oldWorld);
      expect(run.snapshot()).toMatchObject({ playerHp: 92, currency: 20, playerChutes: shop.playerChutes, effectLevels: { temperedSwords: 1, restorativeBrew: 0 } });
      expect(catchCoin(run, "sword").combat.delta.swordDamage).toBe(4);
      for (let tick = 1; tick < 720; tick++) run.step();
      expect(run.snapshot().encounter.phase).toBe("active");
      const lanes = run.encounter.preview().filter(({ source }) => source === "player");
      expect(lanes.map(({ id }) => id)).toEqual(shop.playerChutes.map(({ id }) => id));
      for (const lane of lanes) expect([...lane.preview].sort()).toEqual([...shop.playerChutes.find(({ id }) => id === lane.id)!.bag].sort());
    } finally { run.dispose(); }
  });

  it.each(["loading", "shop", "lost", "won"] as const)("restarts %s to empty ownership while preserving seed and pause", async (state) => {
    const run = await createRun({ density: 0, seed: 211 });
    try {
      run.chooseStarter("collector");
      if (state === "shop") winEncounter(run);
      if (state === "lost") for (let count = 0; count < 50; count++) catchCoin(run, "skull");
      if (state === "won") for (let index = 0; index < 3; index++) { winEncounter(run); if (index < 2) run.continueRun(); }
      run.setPaused(true);
      run.restart();
      expect(run.snapshot()).toMatchObject({ phase: "starter", seed: 211, playerHp: 100, currency: 0, playerChutes: [],
        stickers: [], selectedStarterId: null, purchases: [], recoveries: [], completionServices: [], earnedCurrency: 0, spentCurrency: 0,
        encounter: { paused: true, acceptedActions: 0, remainingRounds: 0, tick: 0, recentEffects: [] } });
      expect(run.simulation.coins.size).toBe(0);
      expect(run.simulation.stats().pendingRain).toBe(0);
      expect(run.encounter.preview()).toEqual([]);
      run.chooseStarter("swarm");
      run.step();
      expect(run.snapshot().encounter.tick).toBe(0);
      run.setPaused(false);
      run.step();
      expect(run.snapshot().encounter.tick).toBe(1);
    } finally { run.dispose(); }
  });

  it("restarts an admitted volley without leaving queue or native stock and reproduces canonical geometry", async () => {
    const run = await createRun({ density: 4, seed: 307 });
    try {
      run.chooseStarter("volley");
      run.step();
      const original = [...run.simulation.coins.values()].map((coin) => structuredClone(coin));
      for (let tick = 1; tick < 720; tick++) run.step();
      expect(run.drop(0)).toBe(true);
      run.step();
      run.restart();
      expect(run.encounter.preview()).toEqual([]);
      expect(run.snapshot().encounter.remainingRounds).toBe(0);
      run.chooseStarter("volley");
      run.step();
      const reset = [...run.simulation.coins.values()];
      expect(reset.every(({ id }) => id > original.at(-1)!.id)).toBe(true);
      expect(reset.map(({ id: _id, ...coin }) => coin)).toEqual(original.map(({ id: _id, ...coin }) => coin));
    } finally { run.dispose(); }
  });

  it("keeps immutable physical tuning for the next reset while applying supported live controls", async () => {
    const run = await createRun({ density: 0, seed: 71 });
    try {
      run.chooseStarter("swarm");
      const before = run.snapshot();
      run.setTuning({ radius: 0.4, thickness: 0.2, density: 10, seed: 113, friction: 0.7 });
      expect(run.simulation.tuning).toMatchObject({ radius: 0.24, thickness: 0.0975, density: 0, friction: 0.7 });
      expect(run.snapshot().playerChutes).toEqual(before.playerChutes);
      run.restart();
      run.chooseStarter("swarm");
      expect(run.simulation.tuning.radius).toBeCloseTo(0.3);
      expect(run.simulation.tuning.thickness).toBeCloseTo(0.15);
      expect(run.simulation.tuning.density).toBe(15);
      expect(run.simulation.tuning.seed).toBe(deriveSeed(113, 0, 0x4f50454e));
    } finally { run.dispose(); }
  });
});
