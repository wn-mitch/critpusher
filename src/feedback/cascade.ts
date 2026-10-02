import type { CollectionEvent } from "../contracts";

export const CASCADE_QUIET_SECONDS = 0.65;
export const CASCADE_MAX_SECONDS = 3;

export interface CollectionBurstUpdate {
  burstId: number;
  total: number;
  added: number;
  startedAt: number;
  updatedAt: number;
}

export interface CollectionBurstTracker {
  collect(
    events: readonly CollectionEvent[],
    simulationTime: number,
  ): CollectionBurstUpdate | null;
  advance(simulationTime: number): void;
  reset(): void;
}

interface ActiveBurst {
  id: number;
  total: number;
  startedAt: number;
  updatedAt: number;
}

export function createCollectionBurstTracker(): CollectionBurstTracker {
  let active: ActiveBurst | undefined;
  let nextBurstId = 1;

  const advance = (simulationTime: number): void => {
    if (
      active &&
      (simulationTime - active.updatedAt >= CASCADE_QUIET_SECONDS ||
        simulationTime - active.startedAt >= CASCADE_MAX_SECONDS)
    ) {
      active = undefined;
    }
  };

  return {
    collect(events, simulationTime) {
      advance(simulationTime);
      let added = 0;
      for (const event of events) {
        if (event.kind === "collected") added += 1;
      }
      if (added === 0) return null;

      if (!active) {
        active = {
          id: nextBurstId,
          total: 0,
          startedAt: simulationTime,
          updatedAt: simulationTime,
        };
        nextBurstId += 1;
      }
      active.total += added;
      active.updatedAt = simulationTime;

      return {
        burstId: active.id,
        total: active.total,
        added,
        startedAt: active.startedAt,
        updatedAt: active.updatedAt,
      };
    },
    advance,
    reset() {
      active = undefined;
    },
  };
}
