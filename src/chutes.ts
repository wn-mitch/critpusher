import type { CoinFaction, Tuning } from "./contracts";
import { MIN_COIN_DELAY_SECONDS } from "./simulation/config";

export interface ChuteSettings {
  enemyChutes: number;
  chuteSpacing: number;
  dropDelay: number;
  dropsPerAction: number;
}

export interface ChuteDrop {
  x: number;
  faction: CoinFaction;
  count: number;
}

export const DEFAULT_CHUTES: Readonly<ChuteSettings> = Object.freeze({
  enemyChutes: 2,
  chuteSpacing: 0.66,
  dropDelay: 0.3,
  dropsPerAction: 1,
});

function bounded(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  return Math.min(
    max,
    Math.max(min, Number.isFinite(value) ? value : fallback),
  );
}

export function chuteSpacingLimits(enemyChutes: number, radius: number) {
  const extent = Math.min(4.4, 5 - radius - 0.02);
  const rings = Math.max(1, Math.ceil(enemyChutes / 2));
  return { min: 2 * radius + 0.02, max: Math.min(3, extent / rings) };
}

export function sanitizeChutes(
  settings: ChuteSettings,
  tuning: Pick<Tuning, "radius">,
): ChuteSettings {
  const enemyChutes = Math.round(
    bounded(settings.enemyChutes, 0, 4, DEFAULT_CHUTES.enemyChutes),
  );
  const limits = chuteSpacingLimits(enemyChutes, tuning.radius);
  return {
    enemyChutes,
    chuteSpacing: bounded(
      settings.chuteSpacing,
      limits.min,
      limits.max,
      DEFAULT_CHUTES.chuteSpacing,
    ),
    dropDelay: bounded(
      settings.dropDelay,
      MIN_COIN_DELAY_SECONDS,
      0.5,
      DEFAULT_CHUTES.dropDelay,
    ),
    dropsPerAction: Math.round(
      bounded(settings.dropsPerAction, 1, 30, DEFAULT_CHUTES.dropsPerAction),
    ),
  };
}

/** Odd enemy counts add the extra chute on the left; each pair adds one ring. */
export function createChuteLayout(
  settings: ChuteSettings,
  tuning: Pick<Tuning, "radius">,
  requestedX: number,
): ChuteDrop[] {
  const safe = sanitizeChutes(settings, tuning);
  const offsets: number[] = [];
  for (let index = 0; index < safe.enemyChutes; index++) {
    offsets.push(
      (index % 2 === 0 ? -1 : 1) *
        (Math.floor(index / 2) + 1) *
        safe.chuteSpacing,
    );
  }
  const extent = Math.min(4.4, 5 - tuning.radius - 0.02);
  const minimumOffset = Math.min(0, ...offsets);
  const maximumOffset = Math.max(0, ...offsets);
  const center = bounded(
    requestedX,
    -extent - minimumOffset,
    extent - maximumOffset,
    0,
  );
  return [
    { x: center, count: 1, faction: "ally" },
    ...offsets.map((offset): ChuteDrop => ({
      x: center + offset,
      count: 1,
      faction: "enemy",
    })),
  ];
}
