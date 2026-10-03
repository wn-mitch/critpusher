const shelfHalfWidth = 5;
const shelfTop = 0;
const shelfThickness = 0.2;
const sideWallThickness = 0.4;
const rearWallThickness = 0.4;
const sideWallX = 5.2;
const physicalRearWallZ = -4.25;
const wallHeight = 4.5;
const pusherHeight = 0.6;
const pusherDepth = 6.4;
const pusherCenterZ = -2.2;

/** World coordinates: +Y is up; +Z points toward collection. Thicknesses are full extents. */
export const MACHINE_GEOMETRY = Object.freeze({
  shelfHalfWidth,
  shelfRearZ: -4,
  shelfTop,
  shelfThickness,
  shelfCenterY: shelfTop - shelfThickness / 2,
  sideWallX,
  sideWallThickness,
  rearWallThickness,
  wallHeight,
  wallCenterY: shelfTop + wallHeight / 2,
  physicalRearWallZ,
  innerHalfWidth: sideWallX - sideWallThickness / 2,
  innerRearZ: physicalRearWallZ + rearWallThickness / 2,
  pusherWidth: 10.4,
  pusherHeight,
  pusherDepth,
  pusherCenterY: shelfTop + pusherHeight / 2,
  pusherCenterZ,
  pusherRearZ: -3,
  pusherFrontOffset: pusherCenterZ + pusherDepth / 2,
  pusherTop: shelfTop + pusherHeight,
  playerDropZ: -3.15,
  previewSlots: 5,
  maxTrays: 6,
  aimHalfWidth: 4.4,
  rainHalfWidth: 4.55,
  rainLowerRearZ: -1.55,
  rainUpperRearZ: -3.55,
  rainUpperFrontZ: -2.3,
  rainFrontInset: 0.3,
  collectionY: -0.45,
  lostHalfWidth: 9,
  lostRearZ: -8,
  lostFrontZ: 12,
  backdropTrayInset: 0.18,
  cameraPortraitHalfWidth: 5.35,
  cameraLandscapeHalfWidth: 6.15,
  cameraRearOverhang: 0.9,
  cameraFrontZ: 5.6,
  cameraFrontOverhang: 1.6,
  cameraMinimumY: -1.65,
  cameraTopY: 4.65,
});
