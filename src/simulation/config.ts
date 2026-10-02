import type { Tuning } from "../contracts";

export const FIXED_DT = 1 / 60;
export const PLAYER_DROP_Z = -3.15;

export const DEFAULT_TUNING: Tuning = Object.freeze({
  seed: 1337,
  density: 300,
  openingEnemyPercent: 40,
  openingDudPercent: 20,
  radius: 0.32,
  thickness: 0.13,
  coinWeight: 1,
  friction: 0.58,
  stroke: 2,
  shelfFront: 4,
  period: 2.4,
  dropHeight: 3.5,
  dropRate: 6,
}) as Tuning;

type NumericKey = keyof Tuning;

const LIMITS: Record<NumericKey, readonly [number, number]> = {
  seed: [-2_147_483_648, 2_147_483_647],
  density: [0, 1000],
  openingEnemyPercent: [0, 100],
  openingDudPercent: [0, 100],
  radius: [0.05, 0.75],
  thickness: [0.02, 0.4],
  coinWeight: [0.1, 10],
  friction: [0, 2],
  shelfFront: [2.5, 4],
  stroke: [0, 4],
  period: [0.25, 10],
  dropHeight: [1.5, 8],
  dropRate: [0, 30],
};

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bounded(
  key: NumericKey,
  value: unknown,
  fallback: number,
  integer = false,
): number {
  const [minimum, maximum] = LIMITS[key];
  const safe = finiteOr(value, fallback);
  const integral = integer ? Math.trunc(safe) : safe;
  return Math.min(maximum, Math.max(minimum, integral));
}

export function sanitizeTuning(base: Tuning, patch?: Partial<Tuning>): Tuning {
  const source = base as Partial<Tuning>;
  const changes = patch ?? {};

  const seed = bounded("seed", source.seed, DEFAULT_TUNING.seed, true);
  const density = bounded(
    "density",
    source.density,
    DEFAULT_TUNING.density,
    true,
  );
  const openingEnemyPercent = bounded(
    "openingEnemyPercent",
    changes.openingEnemyPercent,
    bounded(
      "openingEnemyPercent",
      source.openingEnemyPercent,
      DEFAULT_TUNING.openingEnemyPercent,
    ),
  );
  const openingDudPercent = Math.min(
    100 - openingEnemyPercent,
    bounded(
      "openingDudPercent",
      changes.openingDudPercent,
      bounded(
        "openingDudPercent",
        source.openingDudPercent,
        DEFAULT_TUNING.openingDudPercent,
      ),
    ),
  );

  return {
    seed: bounded("seed", changes.seed, seed, true),
    density: bounded("density", changes.density, density, true),
    openingEnemyPercent,
    openingDudPercent,
    radius: bounded(
      "radius",
      changes.radius,
      bounded("radius", source.radius, DEFAULT_TUNING.radius),
    ),
    thickness: bounded(
      "thickness",
      changes.thickness,
      bounded("thickness", source.thickness, DEFAULT_TUNING.thickness),
    ),
    shelfFront: bounded(
      "shelfFront",
      changes.shelfFront,
      bounded("shelfFront", source.shelfFront, DEFAULT_TUNING.shelfFront),
    ),
    coinWeight: bounded(
      "coinWeight",
      changes.coinWeight,
      bounded("coinWeight", source.coinWeight, DEFAULT_TUNING.coinWeight),
    ),
    friction: bounded(
      "friction",
      changes.friction,
      bounded("friction", source.friction, DEFAULT_TUNING.friction),
    ),
    stroke: bounded(
      "stroke",
      changes.stroke,
      bounded("stroke", source.stroke, DEFAULT_TUNING.stroke),
    ),
    period: bounded(
      "period",
      changes.period,
      bounded("period", source.period, DEFAULT_TUNING.period),
    ),
    dropHeight: bounded(
      "dropHeight",
      changes.dropHeight,
      bounded("dropHeight", source.dropHeight, DEFAULT_TUNING.dropHeight),
    ),
    dropRate: bounded(
      "dropRate",
      changes.dropRate,
      bounded("dropRate", source.dropRate, DEFAULT_TUNING.dropRate),
    ),
  };
}

export function sanitizeDropX(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(4.4, Math.max(-4.4, x));
}
