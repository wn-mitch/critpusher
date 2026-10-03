import type { CoinEvent } from "../contracts";
import type { CombatStepResult } from "../combat/types";

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
    events: readonly CoinEvent[],
    simulationTime: number,
  ): CollectionBurstUpdate | null;
  advance(simulationTime: number): void;
  reset(): void;
}

export interface CombatBurstUpdate {
  burstId: number;
  outgoingDamage: number;
  incomingDamage: number;
  healingUsed: number;
  currency: number;
  detonations: number;
  startedAt: number;
  updatedAt: number;
}

export interface CombatBurstTracker {
  collect(
    batch: CombatStepResult,
    simulationTime: number,
  ): CombatBurstUpdate | null;
  advance(simulationTime: number): void;
  reset(): void;
}

interface ActiveBurst {
  id: number;
  total: number;
  startedAt: number;
  updatedAt: number;
}

interface ActiveCombatBurst {
  id: number;
  outgoingDamage: number;
  incomingDamage: number;
  healingUsed: number;
  currency: number;
  detonations: number;
  startedAt: number;
  updatedAt: number;
}

function burstExpired(
  startedAt: number,
  updatedAt: number,
  simulationTime: number,
): boolean {
  return (
    simulationTime - updatedAt >= CASCADE_QUIET_SECONDS ||
    simulationTime - startedAt >= CASCADE_MAX_SECONDS
  );
}

export function createCollectionBurstTracker(): CollectionBurstTracker {
  let active: ActiveBurst | undefined;
  let nextBurstId = 1;

  const advance = (simulationTime: number): void => {
    if (
      active &&
      burstExpired(active.startedAt, active.updatedAt, simulationTime)
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

export function createCombatBurstTracker(): CombatBurstTracker {
  let active: ActiveCombatBurst | undefined;
  let nextBurstId = 1;

  const advance = (simulationTime: number): void => {
    if (
      active &&
      burstExpired(active.startedAt, active.updatedAt, simulationTime)
    ) {
      active = undefined;
    }
  };

  return {
    collect(batch, simulationTime) {
      advance(simulationTime);
      const outgoingDamage =
        batch.delta.swordDamage + batch.delta.bombDamageToEnemy;
      const incomingDamage =
        batch.delta.skullDamage + batch.delta.bombDamageToPlayer;
      const healingUsed = batch.delta.healingUsed;
      const currency = batch.delta.currencyGained;
      const detonations = batch.delta.detonations;
      if (
        outgoingDamage <= 0 &&
        incomingDamage <= 0 &&
        healingUsed <= 0 &&
        currency <= 0 &&
        detonations <= 0
      ) {
        return null;
      }

      if (!active) {
        active = {
          id: nextBurstId,
          outgoingDamage: 0,
          incomingDamage: 0,
          healingUsed: 0,
          currency: 0,
          detonations: 0,
          startedAt: simulationTime,
          updatedAt: simulationTime,
        };
        nextBurstId += 1;
      }
      active.outgoingDamage += outgoingDamage;
      active.incomingDamage += incomingDamage;
      active.healingUsed += healingUsed;
      active.currency += currency;
      active.detonations += detonations;
      active.updatedAt = simulationTime;
      return { burstId: active.id, outgoingDamage: active.outgoingDamage, incomingDamage: active.incomingDamage,
        healingUsed: active.healingUsed, currency: active.currency, detonations: active.detonations,
        startedAt: active.startedAt, updatedAt: active.updatedAt };
    },
    advance,
    reset() {
      active = undefined;
    },
  };
}
