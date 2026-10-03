import * as RAPIER from "@dimforge/rapier3d-compat";
import type { CoinView, GizmoView, NativeFeedAdmission, Quaternion, Tuning, Vec3 } from "../contracts";
import { MACHINE_GEOMETRY } from "../machine-geometry";
import { FIXED_DT } from "./config";
import { GravityFeed } from "./feeder";
import { BOARD_COIN_GROUPS, MACHINE_GROUPS } from "./collision-groups";
import { updateColliderFriction } from "./collider-material";

const {
  shelfHalfWidth: SHELF_HALF_WIDTH,
  shelfRearZ: SHELF_REAR_Z,
  wallHeight: WALL_HEIGHT,
  wallCenterY: WALL_CENTER_Y,
  sideWallX: SIDE_WALL_X,
  physicalRearWallZ: REAR_WALL_Z,
  pusherWidth: PUSHER_WIDTH,
  pusherDepth: PUSHER_DEPTH,
  pusherHeight: PUSHER_HEIGHT,
  pusherCenterY: PUSHER_Y,
  pusherRearZ: PUSHER_REAR_Z,
  pusherCenterZ: PUSHER_LOCAL_CENTER_Z,
} = MACHINE_GEOMETRY;
const SIDE_WALL_HALF_THICKNESS = MACHINE_GEOMETRY.sideWallThickness / 2;
const REAR_WALL_HALF_THICKNESS = MACHINE_GEOMETRY.rearWallThickness / 2;

/** Pose and dimensions used when adding one dynamic coin cylinder. */
export interface CoinPose {
  position: Vec3;
  rotation?: Quaternion;
  radius: number;
  thickness: number;
}

type BlastAssociation = { rootId: number; tick: number };

/** A newly started coin contact, sampled before collision response. */
export interface CoinImpact {
  aId: number;
  bId: number;
  closingSpeed: number;
  aBlast: BlastAssociation | null;
  bBlast: BlastAssociation | null;
}

type CoinRecord = {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly contacts: Set<number>;
  readonly startsThisStep: Set<number>;
  blast: BlastAssociation | null;
};

/**
 * Owns the Rapier world and the machine's physical geometry. The caller must
 * initialize the compat module before constructing this adapter.
 */
export class RapierWorld {
  private readonly world: RAPIER.World;
  readonly feeder: GravityFeed;
  private readonly events = new RAPIER.EventQueue(true);
  private readonly colliderCoinIds = new Map<number, number>();
  private readonly impacts: CoinImpact[] = [];
  private readonly blastPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly blastImpulse: Vec3 = { x: 0, y: 0, z: 0 };

  private readonly fixedColliders: RAPIER.Collider[] = [];
  private readonly coins = new Map<number, CoinRecord>();
  private readonly gizmos = new Map<number, { body: RAPIER.RigidBody; collider: RAPIER.Collider }>();
  // Rapier's broad phase includes new colliders only after the next step.
  private readonly unsteppedCoinIds: number[] = [];
  // Admitted occupants the broad phase cannot see yet (adopted/spawned this tick).
  private readonly unsteppedBlocked = (shape: RAPIER.Shape, position: Vec3, rotation: Quaternion): boolean => {
    for (const id of this.unsteppedCoinIds) {
      const coin = this.coins.get(id);
      if (coin && shape.intersectsShape(position, rotation,
        coin.collider.shape, coin.collider.translation(), coin.collider.rotation())) return true;
    }
    for (const gizmo of this.gizmos.values()) {
      if (shape.intersectsShape(position, rotation,
        gizmo.collider.shape, gizmo.collider.translation(), gizmo.collider.rotation())) return true;
    }
    return false;
  };
  private pusherBody: RAPIER.RigidBody | null;
  private pusherCollider: RAPIER.Collider | null;
  private pusherPositionZ: number = PUSHER_REAR_Z;
  private friction: number;
  private coinWeight: number;
  private disposed = false;

  constructor(tuning: Pick<Tuning, "friction" | "coinWeight" | "shelfFront">) {
    const gravity = new RAPIER.Vector3(0, -9.81, 0);
    this.world = new RAPIER.World(gravity);
    this.world.timestep = FIXED_DT;
    this.feeder = new GravityFeed(this.world, this.unsteppedBlocked);
    this.friction = tuning.friction;
    this.coinWeight = tuning.coinWeight;
    const shelfDepth = tuning.shelfFront - SHELF_REAR_Z;
    const shelfCenterZ = SHELF_REAR_Z + shelfDepth / 2;

    const fixedBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        SHELF_HALF_WIDTH,
        MACHINE_GEOMETRY.shelfThickness / 2,
        shelfDepth / 2,
      ).setTranslation(0, MACHINE_GEOMETRY.shelfCenterY, shelfCenterZ),
    );
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        SIDE_WALL_HALF_THICKNESS,
        WALL_HEIGHT / 2,
        shelfDepth / 2,
      ).setTranslation(-SIDE_WALL_X, WALL_CENTER_Y, shelfCenterZ),
    );
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        SIDE_WALL_HALF_THICKNESS,
        WALL_HEIGHT / 2,
        shelfDepth / 2,
      ).setTranslation(SIDE_WALL_X, WALL_CENTER_Y, shelfCenterZ),
    );
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        SHELF_HALF_WIDTH + SIDE_WALL_HALF_THICKNESS,
        WALL_HEIGHT / 2,
        REAR_WALL_HALF_THICKNESS,
      ).setTranslation(0, WALL_CENTER_Y, REAR_WALL_Z),
    );

    const pusherDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    pusherDesc.setTranslation(0, PUSHER_Y, PUSHER_REAR_Z);
    this.pusherBody = this.world.createRigidBody(pusherDesc);
    const pusherColliderDesc = RAPIER.ColliderDesc.cuboid(
      PUSHER_WIDTH / 2,
      PUSHER_HEIGHT / 2,
      PUSHER_DEPTH / 2,
    ).setTranslation(0, 0, PUSHER_LOCAL_CENTER_Z).setCollisionGroups(MACHINE_GROUPS);
    this.pusherCollider = this.world.createCollider(
      pusherColliderDesc,
      this.pusherBody,
    );
    this.pusherCollider.setFriction(this.friction);
  }

  private addFixedCollider(
    body: RAPIER.RigidBody,
    desc: RAPIER.ColliderDesc,
  ): void {
    const collider = this.world.createCollider(desc.setCollisionGroups(MACHINE_GROUPS), body);
    collider.setFriction(this.friction);
    this.fixedColliders.push(collider);
  }

  /** Add a dynamic, full-rotation cylinder. Duplicate ids are rejected. */
  addCylinder(id: number, pose: CoinPose, verticalVelocity = 0): boolean {
    if (this.disposed || this.coins.has(id) || this.gizmos.has(id)) return false;
    if (
      !isFiniteVec3(pose.position) ||
      !Number.isFinite(pose.radius) ||
      !Number.isFinite(pose.thickness) ||
      pose.radius <= 0 ||
      pose.thickness <= 0 ||
      !Number.isFinite(verticalVelocity)
    )
      return false;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.position.x, pose.position.y, pose.position.z)
      .setCcdEnabled(true)
      .setCanSleep(true);
    bodyDesc.setRotation(normalizeRotation(pose.rotation));
    if (verticalVelocity !== 0) bodyDesc.setLinvel(0, verticalVelocity, 0);
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.cylinder(
      pose.thickness / 2,
      pose.radius,
    )
      .setFriction(this.friction)
      .setDensity(this.coinWeight)
      .setCollisionGroups(BOARD_COIN_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(colliderDesc, body);
    this.registerCoin(id, body, collider);
    return true;
  }

  canAddSphere(position: Vec3, radius: number): boolean {
    if (this.disposed || !isFiniteVec3(position) || !Number.isFinite(radius) || radius <= 0) return false;
    this.world.propagateModifiedBodyPositionsToColliders();
    const shape = new RAPIER.Ball(radius);
    let clear = true;
    // Direct shape checks include newly created stock and fixed surfaces before broadphase.
    this.world.forEachCollider((collider) => {
      if (clear && shape.intersectsShape(position, IDENTITY_ROTATION, collider.shape,
        collider.translation(), collider.rotation())) clear = false;
    });
    return clear;
  }

  addSphere(gizmo: GizmoView): boolean {
    if (this.disposed || this.coins.has(gizmo.id) || this.gizmos.has(gizmo.id) ||
      !Number.isFinite(gizmo.density) || gizmo.density <= 0 ||
      !this.canAddSphere(gizmo.position, gizmo.radius)) return false;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(gizmo.position.x, gizmo.position.y, gizmo.position.z)
      .setCcdEnabled(true).setCanSleep(true));
    const collider = this.world.createCollider(RAPIER.ColliderDesc.ball(gizmo.radius)
      .setDensity(gizmo.density).setFriction(this.friction)
      .setCollisionGroups(BOARD_COIN_GROUPS), body);
    // Never register spheres in colliderCoinIds: mascot contacts cannot arm bombs.
    this.gizmos.set(gizmo.id, { body, collider });
    return true;
  }

  forEachGizmo(visitor: (id: number, body: RAPIER.RigidBody) => void): void {
    if (this.disposed) return;
    for (const [id, gizmo] of this.gizmos) visitor(id, gizmo.body);
  }

  removeSphere(id: number): boolean {
    const gizmo = this.gizmos.get(id);
    if (!gizmo) return false;
    this.gizmos.delete(id);
    if (!this.disposed) this.world.removeRigidBody(gizmo.body);
    return true;
  }

  /** Adopt the existing stock cylinders; no body or collider is replaced. */
  releaseFeed(admit: (view: CoinView) => number): number[] | null {
    if (this.disposed) return null;
    const ids = this.feeder.release(this.feedExitBlocked, (view, body, collider) => {
      const id = admit(view);
      this.registerCoin(id, body, collider);
      return id;
    });
    if (ids) for (const id of ids) this.seedAdmittedContacts(id);
    return ids;
  }

  startFeedBurst(): boolean {
    return !this.disposed && this.feeder.startBurst(this.feedExitBlocked);
  }

  advanceFeedBurst(admit: (view: CoinView) => number): NativeFeedAdmission[] {
    if (this.disposed) return [];
    const admissions = this.feeder.advanceBurst(this.feedExitBlocked, (view, body, collider) => {
      const id = admit(view);
      this.registerCoin(id, body, collider);
      return id;
    });
    for (const admission of admissions) this.seedAdmittedContacts(admission.id);
    return admissions;
  }

  cancelFeedBurst(): void {
    if (!this.disposed) this.feeder.cancelBurst();
  }

  private seedAdmittedContacts(id: number): void {
    const coin = this.coins.get(id)!;
    this.world.contactPairsWith(coin.collider, (other) => {
      const otherId = this.colliderCoinIds.get(other.handle);
      if (otherId === undefined || otherId === id) return;
      // Existing supply contacts are not new bomb strikes on admission.
      coin.contacts.add(otherId);
      this.coins.get(otherId)!.contacts.add(id);
    });
  }

  nativeBody(id: number): RAPIER.RigidBody | undefined {
    return this.coins.get(id)?.body ?? this.gizmos.get(id)?.body ?? this.feeder.nativeBody(id);
  }

  private registerCoin(id: number, body: RAPIER.RigidBody, collider: RAPIER.Collider): void {
    this.coins.set(id, {
      body, collider,
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      contacts: new Set(),
      startsThisStep: new Set(),
      blast: null,
    });
    this.colliderCoinIds.set(collider.handle, id);
    // Adopted bodies enter the broad phase only after the next step.
    this.unsteppedCoinIds.push(id);
  }

  private readonly exitPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly exitRotation: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
  private readonly otherPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly otherRotation: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
  private readonly exitSweep: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly stationary: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly feedExitBlocked = (body: RAPIER.RigidBody, collider: RAPIER.Collider): boolean => {
    body.translation(this.exitPosition);
    body.rotation(this.exitRotation);
    // Preflight a short free-fall corridor, including not-yet-stepped board bodies.
    this.exitSweep.y = -(collider.halfHeight() * 2 + 0.09);
    for (const coin of this.coins.values()) {
      coin.body.translation(this.otherPosition);
      coin.body.rotation(this.otherRotation);
      if (collider.shape.castShape(this.exitPosition, this.exitRotation, this.exitSweep,
        coin.collider.shape, this.otherPosition, this.otherRotation, this.stationary,
        0, 1, true)) return true;
    }
    for (const gizmo of this.gizmos.values()) {
      gizmo.body.translation(this.otherPosition);
      gizmo.body.rotation(this.otherRotation);
      if (collider.shape.castShape(this.exitPosition, this.exitRotation, this.exitSweep,
        gizmo.collider.shape, this.otherPosition, this.otherRotation, this.stationary,
        0, 1, true)) return true;
    }
    return false;
  };

  /**
   * Test a batch of cylinders against the current scene and one another without
   * mutating the world. This uses the real cylinder shapes, so nearby flat
   * coins are not treated as overlapping merely because their bounding
   * spheres overlap.
   */
  canAddCylinders(
    poses: readonly (Vec3 & { rotation?: Quaternion })[],
    radius: number,
    thickness: number,
  ): boolean {
    if (
      this.disposed ||
      poses.length === 0 ||
      !Number.isFinite(radius) ||
      !Number.isFinite(thickness) ||
      radius <= 0 ||
      thickness <= 0
    )
      return false;

    this.world.propagateModifiedBodyPositionsToColliders();
    const shape = new RAPIER.Cylinder(thickness / 2, radius);
    const checked: Array<{
      position: Vec3;
      rotation: Quaternion;
    }> = [];

    for (const pose of poses) {
      if (!isFiniteVec3(pose)) return false;

      const rotation = normalizeRotation(pose.rotation);
      if (this.world.intersectionWithShape(pose, rotation, shape)) return false;
      for (const id of this.unsteppedCoinIds) {
        const coin = this.coins.get(id);
        if (
          coin &&
          shape.intersectsShape(
            pose,
            rotation,
            coin.collider.shape,
            coin.collider.translation(),
            coin.collider.rotation(),
          )
        )
          return false;
      }
      for (const gizmo of this.gizmos.values()) {
        if (shape.intersectsShape(pose, rotation, gizmo.collider.shape,
          gizmo.collider.translation(), gizmo.collider.rotation())) return false;
      }

      for (const other of checked) {
        if (
          shape.intersectsShape(
            pose,
            rotation,
            shape,
            other.position,
            other.rotation,
          )
        )
          return false;
      }
      checked.push({ position: pose, rotation });
    }

    return true;
  }

  /** Advance one timestep. The returned array is reused by the next step. */
  step(): readonly CoinImpact[] {
    this.impacts.length = 0;
    if (this.disposed) return this.impacts;
    for (const coin of this.coins.values()) {
      coin.startsThisStep.clear();
      coin.body.translation(coin.position);
      coin.body.linvel(coin.velocity);
    }
    this.world.step(this.events);
    this.events.drainCollisionEvents(this.recordContact);
    this.impacts.sort((a, b) => a.aId - b.aId || a.bId - b.bId);
    this.unsteppedCoinIds.length = 0;
    this.feeder.afterStep();
    return this.impacts;
  }

  private readonly recordContact = (
    handle1: number,
    handle2: number,
    started: boolean,
  ): void => {
    const first = this.colliderCoinIds.get(handle1);
    const second = this.colliderCoinIds.get(handle2);
    if (first === undefined || second === undefined || first === second) return;
    const aId = Math.min(first, second);
    const bId = Math.max(first, second);
    const a = this.coins.get(aId)!;
    const b = this.coins.get(bId)!;
    if (!started) {
      a.contacts.delete(bId);
      b.contacts.delete(aId);
      return;
    }
    if (a.contacts.has(bId)) return;
    a.contacts.add(bId);
    b.contacts.add(aId);
    if (a.startsThisStep.has(bId)) return;
    a.startsThisStep.add(bId);
    if (
      !isFiniteVec3(a.position) ||
      !isFiniteVec3(b.position) ||
      !isFiniteVec3(a.velocity) ||
      !isFiniteVec3(b.velocity)
    )
      return;
    const dx = b.position.x - a.position.x;
    const dy = b.position.y - a.position.y;
    const dz = b.position.z - a.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance === 0 || !Number.isFinite(distance)) return;
    const closingSpeed = Math.max(
      0,
      ((a.velocity.x - b.velocity.x) * dx +
        (a.velocity.y - b.velocity.y) * dy +
        (a.velocity.z - b.velocity.z) * dz) /
        distance,
    );
    if (!Number.isFinite(closingSpeed)) return;
    this.impacts.push({
      aId,
      bId,
      closingSpeed,
      aBlast: a.blast ? { ...a.blast } : null,
      bBlast: b.blast ? { ...b.blast } : null,
    });
  };

  /** Apply real mass-scaled impulses; attribution is not exclusive causation. */
  applyRadialBlast(
    position: Vec3,
    radius: number,
    deltaSpeed: number,
    rootId: number,
    tick: number,
  ): void {
    if (this.disposed) return;
    const association = { rootId, tick };
    for (const coin of this.coins.values()) {
      if (this.applyBlastToBody(coin.body, position, radius, deltaSpeed)) coin.blast = association;
    }
    for (const gizmo of this.gizmos.values()) this.applyBlastToBody(gizmo.body, position, radius, deltaSpeed);
  }

  private applyBlastToBody(body: RAPIER.RigidBody, position: Vec3, radius: number, deltaSpeed: number): boolean {
    body.translation(this.blastPosition);
    const dx = this.blastPosition.x - position.x;
    const dy = this.blastPosition.y - position.y;
    const dz = this.blastPosition.z - position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (!(distance < radius)) return false;
    const up = Math.max(0, dy) + 0.35;
    const impulse = (body.mass() * deltaSpeed * (1 - distance / radius)) / Math.hypot(dx, up, dz);
    if (!(impulse > 0) || !Number.isFinite(impulse)) return false;
    this.blastImpulse.x = dx * impulse;
    this.blastImpulse.y = up * impulse;
    this.blastImpulse.z = dz * impulse;
    body.applyImpulse(this.blastImpulse, true);
    return true;
  }

  /** Clear attribution without synthesizing starts for existing contacts. */
  clearBlastAssociations(): void {
    for (const coin of this.coins.values()) coin.blast = null;
  }

  /** Apply the contract's cosine pusher motion before the next step. */
  setPusherTarget(
    time: number,
    tuning: Pick<Tuning, "stroke" | "period">,
  ): void {
    if (this.disposed || !this.pusherBody) return;
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(tuning.stroke) ||
      !Number.isFinite(tuning.period) ||
      tuning.period <= 0
    )
      return;
    const z =
      PUSHER_REAR_Z +
      (tuning.stroke * (1 - Math.cos((2 * Math.PI * time) / tuning.period))) /
        2;
    this.pusherBody.setNextKinematicTranslation({ x: 0, y: PUSHER_Y, z });
    this.pusherPositionZ = z;
  }

  /** Update friction on both existing coins and every machine surface. */
  updateFriction(friction: number): void {
    if (this.disposed || !Number.isFinite(friction)) return;
    if (Math.max(0, friction) === this.friction) return;
    this.friction = Math.max(0, friction);
    for (const collider of this.fixedColliders)
      updateColliderFriction(collider, this.friction);
    if (this.pusherCollider) updateColliderFriction(this.pusherCollider, this.friction);
    for (const coin of this.coins.values()) {
      updateColliderFriction(coin.collider, this.friction);
      coin.body.wakeUp();
    }
    for (const gizmo of this.gizmos.values()) {
      updateColliderFriction(gizmo.collider, this.friction);
      gizmo.body.wakeUp();
    }
    this.feeder.updateFriction(this.friction);
  }

  /** Scale mass and inertia without changing coin geometry or velocity. */
  updateCoinWeight(coinWeight: number): void {
    if (this.disposed || coinWeight === this.coinWeight) return;
    this.coinWeight = coinWeight;
    for (const { body, collider } of this.coins.values()) {
      collider.setDensity(coinWeight);
      body.recomputeMassPropertiesFromColliders();
      body.wakeUp();
    }
    this.feeder.updateCoinWeight(coinWeight);
  }

  /** Visit live coin bodies without allocating a state object per coin. */
  forEachCoin(visitor: (id: number, body: RAPIER.RigidBody) => void): void {
    if (this.disposed) return;
    for (const [id, coin] of this.coins) visitor(id, coin.body);
  }

  /** Remove one body and its attached collider; repeated removal is harmless. */
  removeCylinder(id: number): boolean {
    const coin = this.coins.get(id);
    if (!coin) return false;
    this.coins.delete(id);
    this.colliderCoinIds.delete(coin.collider.handle);
    for (const otherId of coin.contacts)
      this.coins.get(otherId)?.contacts.delete(id);
    if (!this.disposed) this.world.removeRigidBody(coin.body);
    return true;
  }

  get pusherZ(): number {
    return this.pusherPositionZ;
  }

  /** Release Rapier resources. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.feeder.clear();
    this.disposed = true;
    this.coins.clear();
    this.gizmos.clear();
    this.colliderCoinIds.clear();
    this.impacts.length = 0;
    this.unsteppedCoinIds.length = 0;
    this.fixedColliders.length = 0;
    this.pusherBody = null;
    this.pusherCollider = null;
    this.world.free();
    this.events.free();
  }
}

const IDENTITY_ROTATION: Quaternion = { x: 0, y: 0, z: 0, w: 1 };

function isFiniteVec3(value: Vec3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function normalizeRotation(rotation?: Quaternion): Quaternion {
  if (
    !rotation ||
    !Number.isFinite(rotation.x) ||
    !Number.isFinite(rotation.y) ||
    !Number.isFinite(rotation.z) ||
    !Number.isFinite(rotation.w)
  ) {
    return { x: 0, y: 0, z: 0, w: 1 };
  }
  const length = Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w);
  if (length <= 1e-8) return { x: 0, y: 0, z: 0, w: 1 };
  return {
    x: rotation.x / length,
    y: rotation.y / length,
    z: rotation.z / length,
    w: rotation.w / length,
  };
}
