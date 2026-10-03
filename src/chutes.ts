import type { Tuning } from "./contracts";
import { MACHINE_GEOMETRY } from "./machine-geometry";
import { MIN_COIN_DELAY_SECONDS } from "./simulation/config";

export interface ChuteSettings {
  chuteSpacing: number;
  dropDelay: number;
  dropsPerAction: number;
}

export interface ChuteSlot {
  id: string;
  ownerId: string;
  source: "player" | "enemy";
  slot: number;
  enabled: boolean;
}

export interface ChuteDrop extends ChuteSlot {
  x: number;
  count: number;
}

export const DEFAULT_CHUTES: Readonly<ChuteSettings> = Object.freeze({
  chuteSpacing: 0.66,
  dropDelay: 0.3,
  dropsPerAction: 1,
});

/** Reserved positions stay occupied when an enemy's shutter closes. */
export const PLAYER_CHUTE_SLOTS = Object.freeze([0, 1, -1]);
export const ENEMY_CHUTE_SLOTS = Object.freeze([-2, 2, -3]);

function bounded(value: number, min: number, max: number, fallback: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
}

export function chuteSpacingLimits(slots: readonly ChuteSlot[], radius: number) {
  const minimum = Math.min(0, ...slots.map(({ slot }) => slot));
  const maximum = Math.max(0, ...slots.map(({ slot }) => slot));
  const extent = Math.min(MACHINE_GEOMETRY.aimHalfWidth, MACHINE_GEOMETRY.innerHalfWidth - radius - 0.02);
  return {
    min: 2 * radius + 0.02,
    max: Math.min(3, (2 * extent) / Math.max(1, maximum - minimum)),
  };
}

export function sanitizeChutes(settings: ChuteSettings, tuning: Pick<Tuning, "radius">): ChuteSettings {
  return {
    chuteSpacing: bounded(settings.chuteSpacing, 2 * tuning.radius + 0.02, 3, DEFAULT_CHUTES.chuteSpacing),
    dropDelay: bounded(settings.dropDelay, MIN_COIN_DELAY_SECONDS, 0.5, DEFAULT_CHUTES.dropDelay),
    dropsPerAction: Math.round(bounded(settings.dropsPerAction, 1, 30, DEFAULT_CHUTES.dropsPerAction)),
  };
}

/** One aimed assembly: offsets are reserved roster slots, never array indices. */
export function createChuteLayout(
  slots: readonly ChuteSlot[],
  tuning: Pick<Tuning, "radius">,
  requestedX: number,
  requestedSpacing: number,
): ChuteDrop[] {
  if (!Number.isFinite(tuning.radius) || tuning.radius <= 0 || slots.length > MACHINE_GEOMETRY.maxTrays ||
    new Set(slots.map(({ id }) => id)).size !== slots.length ||
    new Set(slots.map(({ slot }) => slot)).size !== slots.length ||
    slots.some(({ id, ownerId, source, slot, enabled }) => !id || !ownerId ||
      (source !== "player" && source !== "enemy") || !Number.isInteger(slot) || typeof enabled !== "boolean")) {
    throw new Error("Invalid chute slots");
  }
  const limits = chuteSpacingLimits(slots, tuning.radius);
  if (limits.max < limits.min) throw new Error("Chute slots do not fit the cabinet");
  const spacing = bounded(requestedSpacing, limits.min, limits.max, DEFAULT_CHUTES.chuteSpacing);
  const minimum = Math.min(0, ...slots.map(({ slot }) => slot * spacing));
  const maximum = Math.max(0, ...slots.map(({ slot }) => slot * spacing));
  const extent = Math.min(MACHINE_GEOMETRY.aimHalfWidth, MACHINE_GEOMETRY.innerHalfWidth - tuning.radius - 0.02);
  const center = bounded(requestedX, -extent - minimum, extent - maximum, 0);
  return slots.map((chute) => ({ ...chute, x: center + chute.slot * spacing, count: 1 }));
}
