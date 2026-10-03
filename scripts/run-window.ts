import type { EncounterSnapshot, FeedTray } from "../src/combat/types";

import { MECHANICAL_LIMIT, WINDOW_TICKS } from "./run-protocol";

type NativeActionTray = Pick<FeedTray, "enabled"> & {
  readonly burst: Pick<FeedTray["burst"], "phase">;
  readonly coins: { readonly length: number };
};

export function nativeActionPending(
  snapshot: Pick<EncounterSnapshot, "remainingRounds">,
  trays: readonly NativeActionTray[],
): boolean {
  return snapshot.remainingRounds > 0 || trays.some((tray) =>
    tray.enabled && (tray.burst.phase !== "idle" || tray.coins.length < 5));
}

/** A row starts at its first fragment; a window ends only after the whole cohort drains. */
export class RunActionWindow {
  ticks = 0;
  firstAdmission: number | null = null;
  lastAdmission: number | null = null;
  mechanicalWaitTicks = 0;
  stallTicks = 0;
  private withoutProgress = 0;
  advance(fragments: number, pendingCohort: boolean, interrupted: boolean): "continue" | "complete" | "stalled" {
    this.ticks++;
    if (fragments > 0) {
      this.firstAdmission ??= this.ticks;
      this.lastAdmission = this.ticks;
      this.withoutProgress = 0;
    } else if (this.firstAdmission === null || pendingCohort) {
      this.withoutProgress++;
      if (this.firstAdmission === null) this.mechanicalWaitTicks++;
      else this.stallTicks++;
    }
    if (interrupted) return "complete";
    if (this.firstAdmission !== null && !pendingCohort && this.ticks - this.firstAdmission + 1 >= WINDOW_TICKS) return "complete";
    if ((this.firstAdmission === null || pendingCohort) && this.withoutProgress >= MECHANICAL_LIMIT) return "stalled";
    return "continue";
  }
}
