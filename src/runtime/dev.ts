import type { SimulationStats, Tuning } from "../contracts";
import type { ChuteSettings } from "../chutes";
import type { EncounterSnapshot, EncounterStep } from "../combat/types";
import type { PurchasePreview, PurchaseRequest, PurchaseResult, Run, RunSnapshot, StarterId } from "../run/types";

export interface PerformanceReadings {
  fps: number;
  renderMs: number;
  frameMs: number;
  cascadeMs: number;
  droppedSteps: number;
}
interface DevLifecycle {
  paused(): boolean;
  chutes(): ChuteSettings;
  performance: PerformanceReadings;
  reset(tuning?: Partial<Tuning>): void;
  setPaused(value: boolean): void;
  step(): EncounterStep;
  drop(x?: number): boolean;
  purchase(request: PurchaseRequest): PurchaseResult;
  chooseStarter(id: StarterId): boolean;
  continueRun(): boolean;
}
type DevSnapshot = SimulationStats & PerformanceReadings & {
  paused: boolean;
  tuning: Tuning;
  chutes: ChuteSettings;
  encounter: EncounterSnapshot;
  run: RunSnapshot;
  remainingDrops: number;
};
interface CritpusherDevApi {
  simulation: Run["simulation"];
  encounter: Run["encounter"];
  snapshot(): DevSnapshot;
  reset(tuning?: Partial<Tuning>): void;
  setPaused(value: boolean): void;
  step(): EncounterStep;
  drop(x?: number): boolean;
  previewPurchase(request: PurchaseRequest): PurchasePreview;
  purchase(request: PurchaseRequest): PurchaseResult;
  chooseStarter(id: StarterId): boolean;
  continueRun(): boolean;
}
declare global {
  interface Window { __critpusher?: CritpusherDevApi }
}
export function exposeDevApi(run: Run, lifecycle: DevLifecycle): void {
  if (!import.meta.env.DEV) return;
  window.__critpusher = {
    simulation: run.simulation,
    encounter: run.encounter,
    snapshot: () => {
      const snapshot = run.snapshot();
      return {
        ...run.simulation.stats(), ...lifecycle.performance,
        paused: lifecycle.paused(), tuning: { ...run.simulation.tuning },
        chutes: { ...lifecycle.chutes() }, remainingDrops: snapshot.encounter.remainingRounds,
        encounter: snapshot.encounter, run: snapshot,
      };
    },
    reset: lifecycle.reset,
    setPaused: lifecycle.setPaused,
    step: lifecycle.step,
    drop: lifecycle.drop,
    chooseStarter: lifecycle.chooseStarter,
    previewPurchase: (request) => run.previewPurchase(request),
    purchase: lifecycle.purchase,
    continueRun: lifecycle.continueRun,
  };
}
