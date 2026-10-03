import * as RAPIER from "@dimforge/rapier3d-compat";
import { COIN_TYPES } from "../contracts";
import { simulationConfig } from "../combat/config";
import { MACHINE_GEOMETRY } from "../machine-geometry";
import type { FeedLayout, FeedTray, SimulationConfig } from "../combat/types";
import type {
  CoinType,
  CoinEvent,
  CoinView,
  GizmoDefinition,
  GizmoEvent,
  GizmoView,
  NativeFeedAdmission,
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
import { GizmoLifecycle } from "./gizmo-lifecycle";
import { planRain, type RainDrop, type RainPose } from "./rain";
import { RapierWorld, type CoinImpact } from "./rapier-world";

export { DEFAULT_TUNING } from "./config";

const MAX_RAIN_SPAWNS_PER_STEP = 12;
const MAX_RAIN_SCANS_PER_STEP = 96;
const FIXED_HZ = Math.round(1 / FIXED_DT);
const INNER_SIDE_WALL_X = MACHINE_GEOMETRY.innerHalfWidth;
const INNER_REAR_WALL_Z = MACHINE_GEOMETRY.innerRearZ;
const UPPER_SHELF_Y = MACHINE_GEOMETRY.pusherTop;
const MACHINE_TOP_Y = MACHINE_GEOMETRY.shelfTop + MACHINE_GEOMETRY.wallHeight;
const SPAWN_GAP = 0.02;
const COLLECTION_Y = MACHINE_GEOMETRY.collectionY;
const LOST_X = MACHINE_GEOMETRY.lostHalfWidth;
const LOST_REAR_Z = MACHINE_GEOMETRY.lostRearZ;
const LOST_FRONT_Z = MACHINE_GEOMETRY.lostFrontZ;

let rapierInitialization: Promise<void> | undefined;

class PusherSimulation implements Simulation {
  readonly tuning: Tuning;
  readonly config: SimulationConfig;

  private world: RapierWorld;
  private coinBoundingRadius: number;
  private coinClearanceSquared: number;
  private readonly lifecycle = new CoinLifecycle();
  private readonly gizmoLifecycle = new GizmoLifecycle();
  private readonly feedAdmissions: NativeFeedAdmission[] = [];
  private rain: Array<RainDrop | undefined> = [];
  private rainCursor = 0;
  private pendingRain = 0;
  private elapsed = 0;
  private simulationTick = 0;
  private lastDropTick = Number.NEGATIVE_INFINITY;
  private lastPhysicsMs = 0;
  private sleeping = 0;
  private bombsActive = false;
  private disposed = false;

  constructor(tuning?: Partial<Tuning>, config?: Partial<SimulationConfig>) {
    this.tuning = sanitizeTuning(DEFAULT_TUNING, tuning);
    this.config = simulationConfig(undefined, config);
    this.coinBoundingRadius = Math.hypot(
      this.tuning.radius,
      this.tuning.thickness / 2,
    );
    const coinClearance = this.coinBoundingRadius * 2 + SPAWN_GAP;
    this.coinClearanceSquared = coinClearance * coinClearance;
    this.world = new RapierWorld(this.tuning);
    this.rain = planRain(this.tuning, this.config.openingMix);
    this.pendingRain = this.rain.length;
  }

  get coins(): ReadonlyMap<number, CoinView> {
    return this.lifecycle.coins;
  }

  get gizmos(): ReadonlyMap<number, GizmoView> {
    return this.gizmoLifecycle.gizmos;
  }

  configureGizmo(definition: GizmoDefinition | null): void {
    if (!this.disposed && this.simulationTick === 0) this.gizmoLifecycle.configure(definition, this.tuning.seed);
  }

  drainGizmoEvents(): GizmoEvent[] {
    return this.gizmoLifecycle.drainEvents();
  }

  setFeedLayout(layout: readonly FeedLayout[]): void {
    if (!this.disposed) this.world.feeder.setLayout(layout, this.tuning);
  }

  feedTrays(): readonly FeedTray[] {
    return this.world.feeder.feedTrays();
  }

  releaseFeed(): number[] | null {
    if (this.disposed || this.tuning.dropRate <= 0) return null;
    return this.world.releaseFeed(this.admitStock);
  }

  startFeedBurst(): boolean {
    return !this.disposed && this.tuning.dropRate > 0 && this.world.startFeedBurst();
  }

  cancelFeedBurst(): void {
    this.world.cancelFeedBurst();
  }

  drainFeedAdmissions(): NativeFeedAdmission[] {
    return this.feedAdmissions.splice(0);
  }

  private readonly admitStock = (stock: CoinView): number => this.lifecycle.spawn(
    stock.position, stock.rotation, stock.radius, stock.thickness, stock.type,
  ).id;

  step(): void {
    if (this.disposed) return;

    const startedAt = performance.now();
    this.spawnGizmo();
    this.spawnRainBatch();
    const nextTime = this.elapsed + FIXED_DT;
    this.world.setPusherTarget(nextTime, this.tuning);
    const impacts = this.world.step();
    this.feedAdmissions.push(...this.world.advanceFeedBurst(this.admitStock));
    this.elapsed = nextTime;
    this.simulationTick += 1;
    this.syncCoins();
    this.world.forEachGizmo(this.syncGizmo);
    if (this.bombsActive) this.resolveBombImpacts(impacts);
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
    chutes: readonly { x: number; count: number; type?: CoinType }[],
    minimumIntervalTicks = Math.ceil(FIXED_HZ / this.tuning.dropRate),
  ): number[] | null {
    if (
      this.disposed ||
      this.tuning.dropRate <= 0 ||
      !Number.isInteger(minimumIntervalTicks) ||
      minimumIntervalTicks < 0 ||
      chutes.length === 0 ||
      chutes.length > MACHINE_GEOMETRY.maxTrays
    )
      return null;

    if (this.simulationTick - this.lastDropTick < minimumIntervalTicks)
      return null;

    const poses: Array<RainPose & { type: CoinType }> = [];
    for (const chute of chutes) {
      if (
        !Number.isFinite(chute.x) ||
        !Number.isInteger(chute.count) ||
        chute.count < 1 ||
        chute.count > 3 ||
        (chute.type !== undefined && !COIN_TYPES.includes(chute.type))
      )
        return null;

      for (let level = 0; level < chute.count; level += 1) {
        const pose: RainPose & { type: CoinType } = {
          type: chute.type ?? "sword",
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
        pose.type,
      );
      if (!this.world.addCylinder(coin.id, coin, exitVelocityY)) {
        this.lifecycle.lose(coin.id, "spawn-failed");
        throw new Error("preflighted chute release could not be spawned");
      }
      ids.push(coin.id);
    }
    this.lastDropTick = this.simulationTick;
    return ids;
  }

  reset(patch?: Partial<Tuning>, config?: Partial<SimulationConfig>): void {
    if (this.disposed) return;

    const nextTuning = sanitizeTuning(this.tuning, patch);
    const nextConfig = simulationConfig(this.config, config);
    this.world.dispose();
    Object.assign(this.tuning, nextTuning);
    Object.assign(this.config, nextConfig);
    this.coinBoundingRadius = Math.hypot(
      this.tuning.radius,
      this.tuning.thickness / 2,
    );
    const coinClearance = this.coinBoundingRadius * 2 + SPAWN_GAP;
    this.coinClearanceSquared = coinClearance * coinClearance;
    this.world = new RapierWorld(this.tuning);
    this.lifecycle.reset();
    this.gizmoLifecycle.reset();
    this.feedAdmissions.length = 0;
    this.rain = planRain(this.tuning, this.config.openingMix);
    this.rainCursor = 0;
    this.pendingRain = this.rain.length;
    this.elapsed = 0;
    this.simulationTick = 0;
    this.lastDropTick = Number.NEGATIVE_INFINITY;
    this.lastPhysicsMs = 0;
    this.sleeping = 0;
    this.bombsActive = false;
  }

  setBombsActive(active: boolean): void {
    if (this.disposed) return;
    if (active && this.bombsActive) return;
    this.bombsActive = active;
    for (const coin of this.lifecycle.coins.values()) {
      coin.bombHits = 0;
    }
    if (!active) this.world.clearBlastAssociations();
  }

  cancelRain(): void {
    this.rain.length = 0;
    this.rainCursor = 0;
    this.pendingRain = 0;
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
    this.world.feeder.configure(this.tuning);
  }

  drainEvents(): CoinEvent[] {
    return this.lifecycle.drainEvents();
  }

  stats(): SimulationStats {
    return {
      time: this.elapsed,
      active: this.lifecycle.active,
      sleeping: this.sleeping,
      spawned: this.lifecycle.spawned,
      collected: this.lifecycle.collected,
      collectedByType: this.lifecycle.collectedByType,
      detonated: this.lifecycle.detonated,
      lost: this.lifecycle.lost,
      pendingRain: this.pendingRain,
      physicsMs: this.lastPhysicsMs,
      pusherZ: this.world.pusherZ,
      phase: (this.elapsed % this.tuning.period) / this.tuning.period,
      gizmos: this.gizmoLifecycle.stats(),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.world.dispose();
    this.lifecycle.reset();
    this.gizmoLifecycle.reset();
    this.feedAdmissions.length = 0;
    this.rain = [];
    this.rainCursor = 0;
    this.pendingRain = 0;
    this.sleeping = 0;
  }

  private spawnGizmo(): void {
    const pending = this.gizmoLifecycle.pendingSpawn;
    if (!pending || this.simulationTick >= 1440 ||
      !this.world.canAddSphere(pending.position, pending.definition.radius)) return;
    const gizmo = this.gizmoLifecycle.spawn(this.lifecycle.allocateId());
    if (!this.world.addSphere(gizmo)) {
      this.gizmoLifecycle.lose(gizmo.id, "spawn-failed");
      throw new Error("Preflighted gizmo could not be spawned");
    }
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
      if (!this.spawnCoin(drop.pose, drop.type)) continue;

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

  private spawnCoin(pose: RainPose, type: CoinType = "sword"): boolean {
    if (!this.world.canAddCylinders([pose], this.tuning.radius, this.tuning.thickness)) return false;
    const coin = this.lifecycle.spawn(
      pose,
      pose.rotation,
      this.tuning.radius,
      this.tuning.thickness,
      type,
    );
    const added = this.world.addCylinder(coin.id, coin);
    if (!added) this.lifecycle.lose(coin.id, "spawn-failed");
    return added;
  }

  private resolveBombImpacts(impacts: readonly CoinImpact[]): void {
    const thresholdCrossings: Array<{
      id: number;
      chainRootId: number;
      blastAssociated: boolean;
      position: Vec3;
    }> = [];
    const periodTicks = Math.ceil(this.tuning.period / FIXED_DT);
    const seenBombStrikers = new Set<string>();
    const qualifying: Array<{
      bombId: number;
      strikerId: number;
      strikerBlast: CoinImpact["aBlast"];
    }> = [];

    for (const impact of impacts) {
      if (impact.closingSpeed < this.config.bomb.minClosingSpeed) continue;
      qualifying.push({
        bombId: impact.aId,
        strikerId: impact.bId,
        strikerBlast: impact.bBlast,
      });
      qualifying.push({
        bombId: impact.bId,
        strikerId: impact.aId,
        strikerBlast: impact.aBlast,
      });
    }
    qualifying.sort(
      (left, right) =>
        left.bombId - right.bombId || left.strikerId - right.strikerId,
    );
    for (const impact of qualifying) {
      this.recordBombImpact(
        impact.bombId,
        impact.strikerId,
        impact.strikerBlast,
        periodTicks,
        seenBombStrikers,
        thresholdCrossings,
      );
    }

    thresholdCrossings.sort((left, right) => left.id - right.id);
    const detonations: typeof thresholdCrossings = [];
    for (const detonation of thresholdCrossings) {
      if (
        !this.lifecycle.detonate(
          detonation.id,
          detonation.chainRootId,
          detonation.blastAssociated,
          detonation.position,
        )
      )
        continue;
      this.world.removeCylinder(detonation.id);
      detonations.push(detonation);
    }
    for (const detonation of detonations) {
      this.world.applyRadialBlast(
        detonation.position,
        this.config.bomb.blastRadius,
        this.config.bomb.blastDeltaSpeed,
        detonation.chainRootId,
        this.simulationTick,
      );
    }
  }

  private recordBombImpact(
    bombId: number,
    strikerId: number,
    strikerBlast: CoinImpact["aBlast"],
    periodTicks: number,
    seenBombStrikers: Set<string>,
    thresholdCrossings: Array<{
      id: number;
      chainRootId: number;
      blastAssociated: boolean;
      position: Vec3;
    }>,
  ): void {
    const bomb = this.lifecycle.coins.get(bombId);
    if (!bomb || bomb.type !== "bomb") return;

    const pair = `${bombId}:${strikerId}`;
    if (seenBombStrikers.has(pair)) return;
    seenBombStrikers.add(pair);

    bomb.bombHits += 1;
    if (bomb.bombHits !== this.config.bomb.hitThreshold) return;

    const blastAssociated =
      strikerBlast !== null &&
      this.simulationTick - strikerBlast.tick >= 0 &&
      this.simulationTick - strikerBlast.tick <= periodTicks;
    const chainRootId =
      strikerBlast !== null && blastAssociated ? strikerBlast.rootId : bomb.id;
    thresholdCrossings.push({
      id: bomb.id,
      chainRootId,
      blastAssociated,
      position: { ...bomb.position },
    });
  }

  private readonly syncGizmo = (id: number, body: RAPIER.RigidBody): void => {
    const position = body.translation();
    const rotation = body.rotation();
    if (!isFinitePose(position, rotation)) {
      this.gizmoLifecycle.lose(id, "invalid-pose");
      this.world.removeSphere(id);
      return;
    }
    this.gizmoLifecycle.update(id, position, rotation);
    const resolution = classifyCoinPosition(position, this.tuning.shelfFront);
    if (resolution === "collected") this.gizmoLifecycle.collect(id);
    if (resolution === "lost") this.gizmoLifecycle.lose(id, "out-of-bounds");
    if (resolution) this.world.removeSphere(id);
  };

  private syncCoins(): void {
    this.sleeping = 0;
    this.world.forEachCoin(this.syncCoin);
  }

  private readonly syncCoin = (id: number, body: RAPIER.RigidBody): void => {
    const position = body.translation();
    const rotation = body.rotation();
    if (!isFinitePose(position, rotation)) {
      this.lifecycle.lose(id, "invalid-pose");
      this.world.removeCylinder(id);
      return;
    }

    this.lifecycle.update(id, position, rotation);
    const resolution = classifyCoinPosition(position, this.tuning.shelfFront);
    if (resolution === "collected") this.lifecycle.collect(id, position);
    if (resolution === "lost")
      this.lifecycle.lose(id, "out-of-bounds", position);
    if (resolution) this.world.removeCylinder(id);
    else if (body.isSleeping()) this.sleeping += 1;
  };
}

export function classifyCoinPosition(
  position: Vec3,
  shelfFront: number,
): "collected" | "lost" | undefined {
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
  config?: Partial<SimulationConfig>,
): Promise<Simulation> {
  rapierInitialization ??= RAPIER.init();
  await rapierInitialization;
  return new PusherSimulation(tuning, config);
}
