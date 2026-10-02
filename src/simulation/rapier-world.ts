import * as RAPIER from "@dimforge/rapier3d-compat";
import type { Quaternion, Tuning, Vec3 } from "../contracts";
import { FIXED_DT } from "./config";

const SHELF_HALF_WIDTH = 5;
const SHELF_REAR_Z = -4;
const WALL_THICKNESS = 0.2;
const WALL_HEIGHT = 4.5;
const WALL_CENTER_Y = WALL_HEIGHT / 2;
const SIDE_WALL_X = 5.2;
const REAR_WALL_Z = -4.25;
const PUSHER_WIDTH = 10.4;
const PUSHER_DEPTH = 6.4;
const PUSHER_HEIGHT = 0.6;
const PUSHER_Y = 0.3;
const PUSHER_REAR_Z = -3;
const PUSHER_LOCAL_CENTER_Z = -2.2;

/** Pose and dimensions used when adding one dynamic coin cylinder. */
export interface CoinPose {
  position: Vec3;
  rotation?: Quaternion;
  radius: number;
  thickness: number;
}

type CoinRecord = {
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
};

/**
 * Owns the Rapier world and the machine's physical geometry. The caller must
 * initialize the compat module before constructing this adapter.
 */
export class RapierWorld {
  private readonly world: RAPIER.World;

  private readonly fixedColliders: RAPIER.Collider[] = [];
  private readonly coins = new Map<number, CoinRecord>();
  // Rapier's broad phase includes new colliders only after the next step.
  private readonly unsteppedCoinIds: number[] = [];
  private pusherBody: RAPIER.RigidBody | null;
  private pusherCollider: RAPIER.Collider | null;
  private pusherPositionZ = PUSHER_REAR_Z;
  private friction: number;
  private coinWeight: number;
  private disposed = false;

  constructor(tuning: Pick<Tuning, "friction" | "coinWeight" | "shelfFront">) {
    const gravity = new RAPIER.Vector3(0, -9.81, 0);
    this.world = new RAPIER.World(gravity);
    this.world.timestep = FIXED_DT;
    this.friction = tuning.friction;
    this.coinWeight = tuning.coinWeight;
    const shelfDepth = tuning.shelfFront - SHELF_REAR_Z;
    const shelfCenterZ = SHELF_REAR_Z + shelfDepth / 2;

    const fixedBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        SHELF_HALF_WIDTH,
        0.1,
        shelfDepth / 2,
      ).setTranslation(0, -0.1, shelfCenterZ),
    );
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        WALL_THICKNESS,
        WALL_HEIGHT / 2,
        shelfDepth / 2,
      ).setTranslation(-SIDE_WALL_X, WALL_CENTER_Y, shelfCenterZ),
    );
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        WALL_THICKNESS,
        WALL_HEIGHT / 2,
        shelfDepth / 2,
      ).setTranslation(SIDE_WALL_X, WALL_CENTER_Y, shelfCenterZ),
    );
    this.addFixedCollider(
      fixedBody,
      RAPIER.ColliderDesc.cuboid(
        SHELF_HALF_WIDTH + WALL_THICKNESS,
        WALL_HEIGHT / 2,
        WALL_THICKNESS,
      ).setTranslation(0, WALL_CENTER_Y, REAR_WALL_Z),
    );

    const pusherDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
    pusherDesc.setTranslation(0, PUSHER_Y, PUSHER_REAR_Z);
    this.pusherBody = this.world.createRigidBody(pusherDesc);
    const pusherColliderDesc = RAPIER.ColliderDesc.cuboid(
      PUSHER_WIDTH / 2,
      PUSHER_HEIGHT / 2,
      PUSHER_DEPTH / 2,
    ).setTranslation(0, 0, PUSHER_LOCAL_CENTER_Z);
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
    const collider = this.world.createCollider(desc, body);
    collider.setFriction(this.friction);
    this.fixedColliders.push(collider);
  }

  /** Add a dynamic, full-rotation cylinder. Duplicate ids are rejected. */
  addCylinder(id: number, pose: CoinPose): boolean {
    if (this.disposed || this.coins.has(id)) return false;
    if (
      !isFiniteVec3(pose.position) ||
      !Number.isFinite(pose.radius) ||
      !Number.isFinite(pose.thickness) ||
      pose.radius <= 0 ||
      pose.thickness <= 0
    )
      return false;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.position.x, pose.position.y, pose.position.z)
      .setCcdEnabled(true)
      .setCanSleep(true);
    bodyDesc.setRotation(normalizeRotation(pose.rotation));
    const body = this.world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.cylinder(
      pose.thickness / 2,
      pose.radius,
    )
      .setFriction(this.friction)
      .setDensity(this.coinWeight);
    const collider = this.world.createCollider(colliderDesc, body);
    this.coins.set(id, { body, collider });
    this.unsteppedCoinIds.push(id);
    return true;
  }

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

  /** Advance exactly one configured Rapier timestep. */
  step(): void {
    if (this.disposed) return;
    this.world.step();
    this.unsteppedCoinIds.length = 0;
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
    this.friction = Math.max(0, friction);
    for (const collider of this.fixedColliders)
      collider.setFriction(this.friction);
    if (this.pusherCollider) this.pusherCollider.setFriction(this.friction);
    for (const coin of this.coins.values())
      coin.collider.setFriction(this.friction);
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
    if (!this.disposed) this.world.removeRigidBody(coin.body);
    return true;
  }

  get pusherZ(): number {
    return this.pusherPositionZ;
  }

  /** Release Rapier resources. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coins.clear();
    this.unsteppedCoinIds.length = 0;
    this.fixedColliders.length = 0;
    this.pusherBody = null;
    this.pusherCollider = null;
    this.world.free();
  }
}

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
