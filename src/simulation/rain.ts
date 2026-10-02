import type { CoinFaction, Tuning } from "../contracts";
import { DEFAULT_TUNING } from "./config";

export interface RainPose {
  x: number;
  y: number;
  z: number;
  rotation: { x: number; y: number; z: number; w: number };
}

export interface RainDrop {
  faction: CoinFaction;
  pose: RainPose;
  releaseTick: number;
}

const SIDE_INSET = 4.55;
const REAR_CLEARANCE = -1.55;
const GAP = 0.06;
const UPPER_SHARE = 0.3;
const UPPER_SOURCE_REAR = -3.55;
const REAR_WALL_INTERIOR = -4.05;
const UPPER_SOURCE_FRONT = -2.3;
const CLEARANCE_MARGIN = 0.04;
const MAX_TILT = 0.16;
const MAX_BATCH_SIZE = 12;
const RAIN_WINDOW_TICKS = 150;
const MAX_POSITION_ATTEMPTS = 96;

function randomFactory(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeRotation(
  x: number,
  y: number,
  z: number,
  w: number,
): RainPose["rotation"] {
  const length = Math.hypot(x, y, z, w);
  if (!Number.isFinite(length) || length <= 0) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  return { x: x / length, y: y / length, z: z / length, w: w / length };
}

function randomRotation(random: () => number): RainPose["rotation"] {
  const yaw = random() * Math.PI * 2;
  const tiltX = (random() * 2 - 1) * MAX_TILT;
  const tiltZ = (random() * 2 - 1) * MAX_TILT;
  const halfX = tiltX * 0.5;
  const halfY = yaw * 0.5;
  const halfZ = tiltZ * 0.5;
  const sinX = Math.sin(halfX);
  const cosX = Math.cos(halfX);
  const sinY = Math.sin(halfY);
  const cosY = Math.cos(halfY);
  const sinZ = Math.sin(halfZ);
  const cosZ = Math.cos(halfZ);

  return normalizeRotation(
    sinX * cosY * cosZ - cosX * sinY * sinZ,
    cosX * sinY * cosZ + sinX * cosY * sinZ,
    cosX * cosY * sinZ - sinX * sinY * cosZ,
    cosX * cosY * cosZ + sinX * sinY * sinZ,
  );
}

function separated(
  x: number,
  z: number,
  positions: readonly { x: number; z: number }[],
  minimumDistanceSquared: number,
): boolean {
  for (const position of positions) {
    const dx = x - position.x;
    const dz = z - position.z;
    if (dx * dx + dz * dz < minimumDistanceSquared) return false;
  }
  return true;
}

function fallbackPositions(
  count: number,
  columns: number,
  rows: number,
  minX: number,
  minZ: number,
  spacing: number,
  xSlack: number,
  zSlack: number,
  random: () => number,
): { x: number; z: number }[] {
  const positions: { x: number; z: number }[] = [];
  const microX = Math.min(0.002, xSlack / Math.max(1, rows + 1));
  const microZ = Math.min(0.002, zSlack / Math.max(1, columns + 1));
  const usableXSlack = Math.max(0, xSlack - (rows - 1) * microX);
  const usableZSlack = Math.max(0, zSlack - (columns - 1) * microZ);
  const offsetX = random() * usableXSlack;
  const offsetZ = random() * usableZSlack;
  const slots = Array.from({ length: columns * rows }, (_, index) => index);

  for (let index = slots.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const slot = slots[index]!;
    slots[index] = slots[swapIndex]!;
    slots[swapIndex] = slot;
  }

  for (const slot of slots) {
    if (positions.length >= count) break;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    positions.push({
      x: minX + offsetX + column * spacing + row * microX,
      z: minZ + offsetZ + row * spacing + column * microZ,
    });
  }
  return positions;
}

function planBatch(
  count: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  spacing: number,
  columns: number,
  rows: number,
  random: () => number,
): { x: number; z: number }[] {
  const minimumDistanceSquared = spacing * spacing;
  const positions: { x: number; z: number }[] = [];
  const attempts = Math.max(1, count * MAX_POSITION_ATTEMPTS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const x = minX + random() * (maxX - minX);
    const z = minZ + random() * (maxZ - minZ);
    if (!separated(x, z, positions, minimumDistanceSquared)) continue;
    positions.push({ x, z });
    if (positions.length === count) return positions;
  }

  // A bounded rejection phase can fail in a crowded batch. The grid fallback
  // has the same conservative spacing and always contains enough slots.
  return fallbackPositions(
    count,
    columns,
    rows,
    minX,
    minZ,
    spacing,
    maxX - minX - (columns - 1) * spacing,
    maxZ - minZ - (rows - 1) * spacing,
    random,
  );
}

function gridDimensions(
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  spacing: number,
): { columns: number; rows: number } {
  return {
    columns: Math.max(1, Math.floor((maxX - minX) / spacing) + 1),
    rows: Math.max(1, Math.floor((maxZ - minZ) / spacing) + 1),
  };
}

export function planRain(tuning: Tuning): RainDrop[] {
  const density = Math.trunc(bounded(tuning.density, 0, 1000, 0));
  if (density === 0) return [];

  const radius = bounded(tuning.radius, 0.05, 0.75, 0.32);
  const thickness = bounded(tuning.thickness, 0.02, 0.4, 0.13);
  const shelfFront = bounded(tuning.shelfFront, 2.5, 4, 4);
  const dropHeight = bounded(tuning.dropHeight, 1.5, 8, 3.5);
  const random = randomFactory(
    Number.isFinite(tuning.seed) ? Math.trunc(tuning.seed) : 0,
  );
  // The small horizontal reach allowance covers the tilted cylinder's rim and
  // leaves a little room from the cabinet walls.
  const horizontalReach =
    radius + thickness * Math.sin(Math.SQRT2 * MAX_TILT) + CLEARANCE_MARGIN;
  const minX = -SIDE_INSET + horizontalReach;
  const maxX = SIDE_INSET - horizontalReach;
  const lowerRawMinZ = REAR_CLEARANCE + horizontalReach;
  const lowerMaxZ = shelfFront - 0.3 - horizontalReach;
  // Keep the upper source near the pusher while preserving a full-cylinder
  // gap from the lower zone. The source rear edge is wall-clearance adjusted.
  const upperMinZ = Math.max(
    UPPER_SOURCE_REAR,
    REAR_WALL_INTERIOR + horizontalReach,
  );
  const spacing = radius * 2 + thickness + GAP;
  const upperMaxZ = Math.min(UPPER_SOURCE_FRONT, lowerRawMinZ - spacing);
  const lowerMinZ = Math.max(lowerRawMinZ, upperMaxZ + spacing);
  const lowerGrid = gridDimensions(minX, maxX, lowerMinZ, lowerMaxZ, spacing);
  const upperGrid = gridDimensions(minX, maxX, upperMinZ, upperMaxZ, spacing);
  const lowerCapacity = lowerGrid.columns * lowerGrid.rows;
  const upperCapacity = upperGrid.columns * upperGrid.rows;
  const batchSize = Math.max(
    1,
    Math.min(
      MAX_BATCH_SIZE,
      lowerCapacity,
      Math.floor(upperCapacity / UPPER_SHARE),
    ),
  );
  const batches = Math.ceil(density / batchSize);
  const upperCount = Math.round(density * UPPER_SHARE);
  const drops: RainDrop[] = [];

  for (let batch = 0; batch < batches; batch += 1) {
    const emittedBefore = drops.length;
    const count = Math.min(batchSize, density - emittedBefore);
    const emittedAfter = emittedBefore + count;
    const upperBefore = Math.floor((emittedBefore * upperCount) / density);
    const upperAfter = Math.floor((emittedAfter * upperCount) / density);
    const upperInBatch = upperAfter - upperBefore;
    const lowerInBatch = count - upperInBatch;
    const upperPositions =
      upperInBatch > 0
        ? planBatch(
            upperInBatch,
            minX,
            maxX,
            upperMinZ,
            upperMaxZ,
            spacing,
            upperGrid.columns,
            upperGrid.rows,
            random,
          )
        : [];
    const lowerPositions =
      lowerInBatch > 0
        ? planBatch(
            lowerInBatch,
            minX,
            maxX,
            lowerMinZ,
            lowerMaxZ,
            spacing,
            lowerGrid.columns,
            lowerGrid.rows,
            random,
          )
        : [];
    const releaseTick = Math.floor((batch * RAIN_WINDOW_TICKS) / batches);

    for (const position of upperPositions) {
      drops.push({
        faction: "ally",
        pose: {
          x: position.x,
          y: dropHeight + 0.04 + random() * 0.28,
          z: position.z,
          rotation: randomRotation(random),
        },
        releaseTick,
      });
    }
    for (const position of lowerPositions) {
      drops.push({
        faction: "ally",
        pose: {
          x: position.x,
          y: dropHeight + 0.04 + random() * 0.28,
          z: position.z,
          rotation: randomRotation(random),
        },
        releaseTick,
      });
    }
  }

  const enemyPercent = bounded(
    tuning.openingEnemyPercent,
    0,
    100,
    DEFAULT_TUNING.openingEnemyPercent,
  );
  const dudPercent = Math.min(
    100 - enemyPercent,
    bounded(tuning.openingDudPercent, 0, 100, DEFAULT_TUNING.openingDudPercent),
  );
  const enemyCount = Math.round((drops.length * enemyPercent) / 100);
  const dudCount = Math.min(
    drops.length - enemyCount,
    Math.round((drops.length * dudPercent) / 100),
  );
  for (let index = 0; index < enemyCount + dudCount; index += 1) {
    drops[index]!.faction = index < enemyCount ? "enemy" : "dud";
  }

  // A separate stream shuffles factions without changing seeded rain geometry.
  const factionRandom = randomFactory(tuning.seed ^ 0x4f1bbcdc);
  for (let index = drops.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(factionRandom() * (index + 1));
    const faction = drops[index]!.faction;
    drops[index]!.faction = drops[swapIndex]!.faction;
    drops[swapIndex]!.faction = faction;
  }

  return drops;
}
