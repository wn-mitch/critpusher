import { MACHINE_GEOMETRY } from "./machine-geometry";

export const FEED_PREVIEW_SLOTS = MACHINE_GEOMETRY.previewSlots;
export const FEED_TRAY_INCLINE = (40 * Math.PI) / 180;
export const FEED_TRAY_SIN = Math.sin(FEED_TRAY_INCLINE);
export const FEED_TRAY_COS = Math.cos(FEED_TRAY_INCLINE);
export const FEED_TRAY_ROTATION = Object.freeze({
  x: Math.sin(FEED_TRAY_INCLINE / 2), y: 0, z: 0,
  w: Math.cos(FEED_TRAY_INCLINE / 2),
});

export interface FeedTrayGeometry {
  readonly previewRadius: number;
  readonly spacing: number;
  readonly width: number;
  readonly depth: number;
  readonly lipHeight: number;
  readonly wallThickness: number;
  readonly floorThickness: number;
  readonly coverThickness: number;
  readonly sideWallCenterX: number;
  readonly wallCenterY: number;
  readonly frontStopZ: number;
  readonly localCenterZ: number;
  readonly localRearZ: number;
  readonly localFrontZ: number;
  readonly localBaseY: number;
  readonly localArrowZ: number;
  readonly arrowScale: number;
  readonly outletCenterZ: number;
  readonly refillInsertionZ: number;
  readonly trapRearZ: number;
  readonly trapFrontZ: number;
  readonly coverFrontZ: number;
  readonly coverY: number;
  readonly rearZ: number;
  readonly topY: number;
}

/** The front coin rests over an escapement; replenishment enters behind the cover. */
export function getFeedTrayGeometry(radius: number, thickness: number, dropHeight: number): FeedTrayGeometry {
  const spacing = 2 * radius + 0.08;
  const arrowScale = radius / 0.3;
  const localRearZ = -FEED_PREVIEW_SLOTS * spacing - radius - 0.08;
  const localArrowZ = radius + 0.19 * arrowScale + 0.03;
  const localFrontZ = localArrowZ + 0.17 * arrowScale + 0.03;
  const floorThickness = 0.07;
  const coverThickness = 0.03;
  const width = 2 * radius + 0.01;
  const wallThickness = 0.01;
  const lipHeight = Math.min(0.13, thickness * 0.75);
  const localBaseY = -thickness * 0.5 - floorThickness / 2;
  const coverY = thickness * 0.5 + floorThickness / 2;
  return {
    previewRadius: radius,
    spacing,
    width,
    depth: localFrontZ - localRearZ,
    lipHeight,
    wallThickness,
    floorThickness,
    coverThickness,
    sideWallCenterX: (width + wallThickness) / 2,
    wallCenterY: localBaseY + floorThickness / 2 + lipHeight / 2,
    frontStopZ: radius + wallThickness / 2,
    localCenterZ: (localRearZ + localFrontZ) * 0.5,
    localRearZ,
    localFrontZ,
    localBaseY,
    localArrowZ,
    outletCenterZ: 0,
    refillInsertionZ: -FEED_PREVIEW_SLOTS * spacing,
    arrowScale,
    trapRearZ: -Math.hypot(radius, thickness / 2) - Math.max(0.08, radius * 0.1),
    trapFrontZ: radius + Math.max(0.08, radius * 0.5),
    coverFrontZ: -(FEED_PREVIEW_SLOTS - 1) * spacing - radius - 0.02,
    coverY,
    rearZ: MACHINE_GEOMETRY.playerDropZ + localRearZ * FEED_TRAY_COS + (localBaseY - floorThickness / 2) * FEED_TRAY_SIN,
    topY: dropHeight - localRearZ * FEED_TRAY_SIN + (coverY + coverThickness / 2) * FEED_TRAY_COS,
  };
}
