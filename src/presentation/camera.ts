import * as THREE from "three";
import { DEFAULT_TUNING } from "../simulation/config";
import { getFeedTrayGeometry } from "../feed-geometry";
import { MACHINE_GEOMETRY } from "../machine-geometry";

export const MACHINE_CAMERA_TARGET = Object.freeze({ x: 0, y: 0.45, z: 0.25 });
export const MACHINE_CAMERA_DESKTOP = Object.freeze({ width: 1280, height: 800 });

/**
 * Fits the fixed machine camera to the physical cabinet and complete feed.
 * CPU observers use this same profile, dimensions, target, elevation, and FOV.
 */
export function fitMachineCamera(
  camera: THREE.PerspectiveCamera,
  width: number,
  height: number,
  radius = DEFAULT_TUNING.radius,
  dropHeight = DEFAULT_TUNING.dropHeight,
  shelfFront = DEFAULT_TUNING.shelfFront,
  thickness = DEFAULT_TUNING.thickness,
  assetBounds?: THREE.Box3,
): void {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const portrait = aspect < 1;
  camera.aspect = aspect;
  camera.fov = portrait ? 50 : 42;

  const target = MACHINE_CAMERA_TARGET;
  const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
  const elevation = THREE.MathUtils.degToRad(portrait ? 31 : 29);
  const elevationSin = Math.sin(elevation);
  const elevationCos = Math.cos(elevation);
  const profileHalfWidth = portrait
    ? MACHINE_GEOMETRY.cameraPortraitHalfWidth
    : MACHINE_GEOMETRY.cameraLandscapeHalfWidth;
  const assetHalfWidth = assetBounds
    ? Math.max(Math.abs(assetBounds.min.x), Math.abs(assetBounds.max.x))
    : 0;
  const halfWidth = Math.max(profileHalfWidth, assetHalfWidth);
  const padding = 1.04;
  const tray = getFeedTrayGeometry(radius, thickness, dropHeight);
  // Include authored decoration plus the shared physical and lifted-feed envelopes.
  const minimumZ = Math.min(
    MACHINE_GEOMETRY.physicalRearWallZ,
    tray.rearZ - MACHINE_GEOMETRY.backdropTrayInset,
    assetBounds?.min.z ?? Number.POSITIVE_INFINITY,
  ) - MACHINE_GEOMETRY.cameraRearOverhang;
  const maximumZ = Math.max(
    MACHINE_GEOMETRY.cameraFrontZ,
    shelfFront + MACHINE_GEOMETRY.cameraFrontOverhang,
    assetBounds?.max.z ?? Number.NEGATIVE_INFINITY,
  );
  const minimumY = Math.min(
    MACHINE_GEOMETRY.cameraMinimumY,
    assetBounds?.min.y ?? Number.POSITIVE_INFINITY,
  );
  const maximumY = Math.max(
    MACHINE_GEOMETRY.cameraTopY,
    tray.topY,
    assetBounds?.max.y ?? Number.NEGATIVE_INFINITY,
  );
  let distance = 0;

  for (let corner = 0; corner < 4; corner += 1) {
    const y = (corner & 1) === 0 ? minimumY : maximumY;
    const z = (corner & 2) === 0 ? minimumZ : maximumZ;
    const relativeY = y - target.y;
    const relativeZ = z - target.z;
    const depthOffset = relativeY * elevationSin + relativeZ * elevationCos;
    const projectedY = Math.abs(relativeY * elevationCos - relativeZ * elevationSin);
    const widthDistance = depthOffset + (halfWidth * padding) / (tangent * aspect);
    const heightDistance = depthOffset + (projectedY * padding) / tangent;
    distance = Math.max(distance, widthDistance, heightDistance);
  }

  camera.position.set(0, target.y + distance * elevationSin, target.z + distance * elevationCos);
  camera.lookAt(target.x, target.y, target.z);
  camera.updateProjectionMatrix();
}
