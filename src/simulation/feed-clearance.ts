import * as RAPIER from "@dimforge/rapier3d-compat";
import type { Quaternion, Vec3 } from "../contracts";
import { FEED_TRAY_COS, FEED_TRAY_ROTATION, FEED_TRAY_SIN, type FeedTrayGeometry } from "../feed-geometry";
import { PLAYER_DROP_Z } from "./config";
import { BOARD_COIN_GROUPS, STOCK_COIN_GROUPS } from "./collision-groups";

// Query only admitted coins and gizmos, never the unadmitted supply or its hardware.
const ADMITTED_QUERY_GROUPS = (STOCK_COIN_GROUPS & 0xffff0000) | (BOARD_COIN_GROUPS >>> 16);

/** Reports whether a shape at a pose intersects an admitted occupant the broad phase
 * cannot see yet: bodies adopted or spawned since the last physics step. */
export type UnsteppedBlockedQuery = (
  shape: RAPIER.Shape, position: Vec3, rotation: Quaternion,
) => boolean;

export function createFeedClearanceShape(geometry: FeedTrayGeometry, thickness: number): RAPIER.Cuboid {
  return new RAPIER.Cuboid(
    geometry.width / 2 + 0.01,
    thickness / 2 + geometry.floorThickness / 2 + 0.02,
    geometry.depth / 2 + 0.01,
  );
}

/** Query the finite tray envelope before installing replacement supply. */
export function feedClearanceBlocked(
  world: RAPIER.World, shape: RAPIER.Cuboid, geometry: FeedTrayGeometry,
  dropHeight: number, x: number, position: Vec3, unsteppedBlocked: UnsteppedBlockedQuery,
): boolean {
  const localY = -geometry.floorThickness / 2;
  position.x = x;
  position.y = dropHeight + localY * FEED_TRAY_COS - geometry.localCenterZ * FEED_TRAY_SIN;
  position.z = PLAYER_DROP_Z + localY * FEED_TRAY_SIN + geometry.localCenterZ * FEED_TRAY_COS;
  return world.intersectionWithShape(position, FEED_TRAY_ROTATION, shape, undefined, ADMITTED_QUERY_GROUPS) !== null ||
    unsteppedBlocked(shape, position, FEED_TRAY_ROTATION);
}

/** Test hardware being re-enabled, not an infinite plane or an already enabled
 * support surface on which a body may legitimately rest. */
export function feedColliderBlocked(
  world: RAPIER.World, collider: RAPIER.Collider, position: Vec3, rotation: Quaternion,
  unsteppedBlocked: UnsteppedBlockedQuery,
): boolean {
  if (collider.isEnabled()) return false;
  collider.translation(position);
  collider.rotation(rotation);
  return world.intersectionWithShape(position, rotation, collider.shape, undefined, ADMITTED_QUERY_GROUPS) !== null ||
    unsteppedBlocked(collider.shape, position, rotation);
}
