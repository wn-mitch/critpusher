import type * as RAPIER from "@dimforge/rapier3d-compat";

/** Rapier retains manifold materials until their geometry cache is refreshed. */
export function updateColliderFriction(collider: RAPIER.Collider, friction: number): void {
  collider.setFriction(friction);
  // Reapply identical geometry: body/collider identity and physical pose stay intact.
  collider.setShape(collider.shape);
}
