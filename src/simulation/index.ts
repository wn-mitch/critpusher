import * as RAPIER from "@dimforge/rapier3d-compat";
import type {
  CoinFaction,
  CollectionEvent,
  CoinView,
  Quaternion,
  Simulation,
  SimulationStats,
  Tuning,
  Vec3,
} from "../contracts";
import {
  DEFAULT_TUNING,
  FIXED_DT,
  MIN_COIN_DELAY_SECONDS,
  PLAYER_DROP_Z,
  sanitizeDropX,
  sanitizeTuning,
} from "./config";
import { CoinLifecycle } from "./lifecycle";
import { planRain, type RainDrop, type RainPose } from "./rain";
import { RapierWorld } from "./rapier-world";

export { DEFAULT_TUNING } from "./config";

const MAX_RAIN_SPAWNS_PER_STEP = 12;
const MAX_RAIN_SCANS_PER_STEP = 96;
const FIXED_HZ = Math.round(1 / FIXED_DT);
const INNER_SIDE_WALL_X = 5;
const INNER_REAR_WALL_Z = -4.05;
const UPPER_SHELF_Y = 0.6;
const MACHINE_TOP_Y = 4.5;
const SPAWN_GAP = 0.02;
const COLLECTION_Y = -0.45;
const LOST_X = 9;
const LOST_REAR_Z = -8;
const LOST_FRONT_Z = 12;

let rapierInitialization: Promise<void> | undefined;

class PusherSimulation implements Simulation {
  readonly tuning: Tuning;

  private world: RapierWorld;
  private coinBoundingRadius: number;
  private coinClearanceSquared: number;
  private readonly lifecycle = new CoinLifecycle();
  private rain: Array<RainDrop | undefined> = [];
  private rainCursor = 0;
  private pendingRain = 0;
  private elapsed = 0;
  private simulationTick = 0;
  private lastDropTick = Number.NEGATIVE_INFINITY;
  private lastPhysicsMs = 0;
  private sleeping = 0;
  private disposed = false;

  constructor(tuning?: Partial<Tuning>) {
    this.tuning = sanitizeTuning(DEFAULT_TUNING, tuning);
    this.coinBoundingRadius = Math.hypot(
      this.tuning.radius,
      this.tuning.thickness / 2,
    );
    const coinClearance = this.coinBoundingRadius * 2 + SPAWN_GAP;
    this.coinClearanceSquared = coinClearance * coinClearance;
    this.world = new RapierWorld(this.tuning);
    this.rain = planRain(this.tuning);
    this.pendingRain = this.rain.length;
  }

  get coins(): ReadonlyMap<number, CoinView> {
    return this.lifecycle.coins;
  }

  step(): void {
    if (this.disposed) return;

    const startedAt = performance.now();
    this.spawnRainBatch();
    const nextTime = this.elapsed + FIXED_DT;
    this.world.setPusherTarget(nextTime, this.tuning);
    this.world.step();
    this.elapsed = nextTime;
    this.simulationTick += 1;
    this.syncCoins();
    this.lastPhysicsMs = performance.now() - startedAt;
  }

  drop(x: number, mode: "chute" | "back-row" = "chute"): boolean {
    if (this.disposed || this.tuning.dropRate <= 0) return false;

    const intervalTicks = Math.ceil(FIXED_HZ / this.tuning.dropRate);
    if (this.simulationTick - this.lastDropTick < intervalTicks) return false;

    const sanitizedX = sanitizeDropX(x);
    const pose =
      mode === "back-row"
        ? this.backRowPose(sanitizedX)
        : {
            x: sanitizedX,
            y: this.tuning.dropHeight,
            z: PLAYER_DROP_Z,
            rotation: { x: 0, y: 0, z: 0, w: 1 },
          };
    if (!pose || !this.spawnCoin(pose)) return false;
    this.lastDropTick = this.simulationTick;
    return true;
  }

  releaseChutes(
    chutes: readonly { x: number; count: number; faction?: CoinFaction }[],
    minimumIntervalTicks = Math.ceil(FIXED_HZ / this.tuning.dropRate),
  ): number[] | null {
    if (
      this.disposed ||
      this.tuning.dropRate <= 0 ||
      !Number.isInteger(minimumIntervalTicks) ||
      minimumIntervalTicks < 0 ||
      chutes.length === 0 ||
      chutes.length > 5
    )
      return null;

    if (this.simulationTick - this.lastDropTick < minimumIntervalTicks)
      return null;

    const poses: Array<RainPose & { faction: CoinFaction }> = [];
    for (const chute of chutes) {
      if (
        !Number.isFinite(chute.x) ||
        !Number.isInteger(chute.count) ||
        chute.count < 1 ||
        chute.count > 3 ||
        (chute.faction !== undefined &&
          chute.faction !== "ally" &&
          chute.faction !== "enemy" &&
          chute.faction !== "dud")
      )
        return null;

      for (let level = 0; level < chute.count; level += 1) {
        const pose: RainPose & { faction: CoinFaction } = {
          faction: chute.faction ?? "ally",
          x: chute.x,
          y:
            this.tuning.dropHeight +
            level * (this.tuning.thickness + SPAWN_GAP),
          z: PLAYER_DROP_Z,
          rotation: { x: 0, y: 0, z: 0, w: 1 },
        };
        if (!this.isChutePoseWithinCabinet(pose)) return null;
        poses.push(pose);
      }
    }

    if (
      !this.world.canAddCylinders(
        poses,
        this.tuning.radius,
        this.tuning.thickness,
      )
    )
      return null;

    // Chute feed clears a thickness plus gap within the shortest selectable delay.
    const exitVelocityY =
      -(this.tuning.thickness + SPAWN_GAP) / MIN_COIN_DELAY_SECONDS;
    const ids: number[] = [];
    for (const pose of poses) {
      const coin = this.lifecycle.spawn(
        pose,
        pose.rotation,
        this.tuning.radius,
        this.tuning.thickness,
        pose.faction,
      );
      if (!this.world.addCylinder(coin.id, coin, exitVelocityY))
        throw new Error("preflighted chute release could not be spawned");
      ids.push(coin.id);
    }
    this.lastDropTick = this.simulationTick;
    return ids;
  }

  reset(patch?: Partial<Tuning>): void {
    if (this.disposed) return;

    const nextTuning = sanitizeTuning(this.tuning, patch);
    this.world.dispose();
    Object.assign(this.tuning, nextTuning);
    this.coinBoundingRadius = Math.hypot(
      this.tuning.radius,
      this.tuning.thickness / 2,
    );
    const coinClearance = this.coinBoundingRadius * 2 + SPAWN_GAP;
    this.coinClearanceSquared = coinClearance * coinClearance;
    this.world = new RapierWorld(this.tuning);
    this.lifecycle.reset();
    this.rain = planRain(this.tuning);
    this.rainCursor = 0;
    this.pendingRain = this.rain.length;
    this.elapsed = 0;
    this.simulationTick = 0;
    this.lastDropTick = Number.NEGATIVE_INFINITY;
    this.lastPhysicsMs = 0;
    this.sleeping = 0;
  }
  configure(patch: Partial<Tuning>): void {
    if (this.disposed) return;

    const sanitized = sanitizeTuning(this.tuning, patch);
    this.tuning.coinWeight = sanitized.coinWeight;
    this.world.updateCoinWeight(this.tuning.coinWeight);
    this.tuning.friction = sanitized.friction;
    this.tuning.stroke = sanitized.stroke;
    this.tuning.period = sanitized.period;
    this.tuning.dropHeight = sanitized.dropHeight;
    this.tuning.dropRate = sanitized.dropRate;
    this.world.updateFriction(this.tuning.friction);
  }

  drainEvents(): CollectionEvent[] {
    return this.lifecycle.drainEvents();
  }

  stats(): SimulationStats {
    return {
      time: this.elapsed,
      active: this.lifecycle.active,
      sleeping: this.sleeping,
      spawned: this.lifecycle.spawned,
      collected: this.lifecycle.collected,
      allyCollected: this.lifecycle.allyCollected,
      enemyCollected: this.lifecycle.enemyCollected,
      dudCollected: this.lifecycle.dudCollected,
      lost: this.lifecycle.lost,
      pendingRain: this.pendingRain,
      physicsMs: this.lastPhysicsMs,
      pusherZ: this.world.pusherZ,
      phase: (this.elapsed % this.tuning.period) / this.tuning.period,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.dispose();
    this.lifecycle.reset();
    this.rain = [];
    this.rainCursor = 0;
    this.pendingRain = 0;
    this.sleeping = 0;
  }

  private spawnRainBatch(): void {
    if (this.pendingRain === 0 || this.rain.length === 0) return;

    const scanLimit = Math.min(this.rain.length, MAX_RAIN_SCANS_PER_STEP);
    let scanned = 0;
    let spawned = 0;
    while (scanned < scanLimit && spawned < MAX_RAIN_SPAWNS_PER_STEP) {
      const index = this.rainCursor;
      this.rainCursor = (this.rainCursor + 1) % this.rain.length;
      scanned += 1;

      const drop = this.rain[index];
      if (
        !drop ||
        drop.releaseTick > this.simulationTick ||
        !this.isSpawnClear(drop.pose)
      )
        continue;
      if (!this.spawnCoin(drop.pose, drop.faction)) continue;

      this.rain[index] = undefined;
      this.pendingRain -= 1;
      spawned += 1;
    }
  }

  private isChutePoseWithinCabinet(pose: RainPose): boolean {
    const radius = this.tuning.radius;
    const halfThickness = this.tuning.thickness / 2;
    return (
      pose.x - radius >= -INNER_SIDE_WALL_X &&
      pose.x + radius <= INNER_SIDE_WALL_X &&
      pose.y - halfThickness >= UPPER_SHELF_Y &&
      pose.y + halfThickness <= MACHINE_TOP_Y &&
      pose.z - radius >= INNER_REAR_WALL_Z &&
      pose.z + radius <= this.tuning.shelfFront
    );
  }

  private isSpawnClear(pose: RainPose): boolean {
    const radius = this.coinBoundingRadius;
    if (
      pose.x - radius < -INNER_SIDE_WALL_X ||
      pose.x + radius > INNER_SIDE_WALL_X ||
      pose.y - radius < UPPER_SHELF_Y ||
      pose.z - radius < INNER_REAR_WALL_Z ||
      pose.z + radius > this.tuning.shelfFront
    )
      return false;

    for (const coin of this.lifecycle.coins.values()) {
      const dx = pose.x - coin.position.x;
      const dy = pose.y - coin.position.y;
      const dz = pose.z - coin.position.z;
      if (dx * dx + dy * dy + dz * dz < this.coinClearanceSquared) return false;
    }
    return true;
  }

  private backRowPose(x: number): RainPose | null {
    const safeX = Math.min(
      INNER_SIDE_WALL_X - this.tuning.radius - SPAWN_GAP,
      Math.max(-INNER_SIDE_WALL_X + this.tuning.radius + SPAWN_GAP, x),
    );
    const clearance = this.coinBoundingRadius * 2 + SPAWN_GAP;
    const clearanceSquared = clearance * clearance;
    let y = UPPER_SHELF_Y + this.tuning.thickness / 2 + SPAWN_GAP;

    for (const coin of this.lifecycle.coins.values()) {
      if (coin.position.y + this.coinBoundingRadius <= UPPER_SHELF_Y) continue;
      const dx = safeX - coin.position.x;
      const dz = PLAYER_DROP_Z - coin.position.z;
      const horizontalDistanceSquared = dx * dx + dz * dz;
      if (horizontalDistanceSquared >= clearanceSquared) continue;
      y = Math.max(
        y,
        coin.position.y +
          Math.sqrt(clearanceSquared - horizontalDistanceSquared),
      );
    }

    if (y + this.coinBoundingRadius + SPAWN_GAP > MACHINE_TOP_Y) return null;
    return {
      x: safeX,
      y,
      z: PLAYER_DROP_Z,
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
  }

  private spawnCoin(pose: RainPose, faction: CoinFaction = "ally"): boolean {
    const coin = this.lifecycle.spawn(
      pose,
      pose.rotation,
      this.tuning.radius,
      this.tuning.thickness,
      faction,
    );
    const added = this.world.addCylinder(coin.id, coin);
    if (!added) this.lifecycle.lose(coin.id);
    return added;
  }

  private syncCoins(): void {
    this.sleeping = 0;
    this.world.forEachCoin(this.syncCoin);
  }

  private readonly syncCoin = (id: number, body: RAPIER.RigidBody): void => {
    const position = body.translation();
    const rotation = body.rotation();
    if (!isFinitePose(position, rotation)) {
      this.lifecycle.lose(id);
      this.world.removeCylinder(id);
      return;
    }

    this.lifecycle.update(id, position, rotation);
    const resolution = classifyCoinPosition(position, this.tuning.shelfFront);
    if (resolution === "collected") this.lifecycle.collect(id, position);
    if (resolution === "lost") this.lifecycle.lose(id, position);
    if (resolution) this.world.removeCylinder(id);
    else if (body.isSleeping()) this.sleeping += 1;
  };
}

export function classifyCoinPosition(
  position: Vec3,
  shelfFront: number,
): CollectionEvent["kind"] | undefined {
  if (
    Math.abs(position.x) > LOST_X ||
    position.z < LOST_REAR_Z ||
    position.z > LOST_FRONT_Z
  ) {
    return "lost";
  }
  if (position.y < COLLECTION_Y) {
    return position.z > shelfFront ? "collected" : "lost";
  }
  return undefined;
}

function isFinitePose(position: Vec3, rotation: Quaternion): boolean {
  return (
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(position.z) &&
    Number.isFinite(rotation.x) &&
    Number.isFinite(rotation.y) &&
    Number.isFinite(rotation.z) &&
    Number.isFinite(rotation.w)
  );
}

export async function createSimulation(
  tuning?: Partial<Tuning>,
): Promise<Simulation> {
  rapierInitialization ??= RAPIER.init();
  await rapierInitialization;
  return new PusherSimulation(tuning);
}
