import * as RAPIER from "@dimforge/rapier3d-compat";
import { type CoinView, type NativeFeedAdmission, type Tuning, type Vec3 } from "../contracts";
import type { FeedLayout, FeedTray } from "../combat/types";
import {
  FEED_PREVIEW_SLOTS, FEED_TRAY_COS, FEED_TRAY_SIN,
  FEED_TRAY_ROTATION, getFeedTrayGeometry,
} from "../feed-geometry";
import { DEFAULT_TUNING, PLAYER_DROP_Z } from "./config";
import { BOARD_COIN_GROUPS, FEED_FLOOR_GROUPS, FEED_TRAY_GROUPS, STOCK_COIN_GROUPS } from "./collision-groups";
import { updateColliderFriction } from "./collider-material";
import { validateFeedLayout } from "../combat/feed";
import { createFeedClearanceShape, feedClearanceBlocked, feedColliderBlocked, type UnsteppedBlockedQuery } from "./feed-clearance";

// Clearance prevents the upper stack and front lip from friction-clamping the exit.
const HOLDBACK_GAP = 0.08;

type FeedTuning = Pick<Tuning, "radius" | "thickness" | "dropHeight" | "friction" | "coinWeight">;
type Stock = {
  view: CoinView;
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  guide: RAPIER.PrismaticImpulseJoint;
};
type BurstMember = {
  stock: Stock;
  row: number;
  admittedId: number | null;
  previousLocalZ: number;
};
type BurstLane = {
  tray: Tray;
  members: BurstMember[];
};
type BurstRun = {
  phase: "emitting" | "rearming";
  lanes: BurstLane[];
  closed: boolean;
};
type Tray = {
  view: FeedTray;
  body: RAPIER.RigidBody;
  floor: RAPIER.Collider;
  frontFloor: RAPIER.Collider;
  stop: RAPIER.Collider;
  colliders: RAPIER.Collider[];
  stock: Stock[];
  views: CoinView[];
  released: Stock | null;
  awaitingLayout: boolean;
};

/** Native supply lives outside the board ledger until its escapement opens. */
export class GravityFeed {
  private readonly trays: Tray[] = [];
  private readonly views: FeedTray[] = [];
  private readonly stock = new Map<number, Stock>();
  private nextStockId = -1;
  private tuning: FeedTuning = { ...DEFAULT_TUNING };
  private geometry = getFeedTrayGeometry(DEFAULT_TUNING.radius, DEFAULT_TUNING.thickness, DEFAULT_TUNING.dropHeight);
  private readonly position: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly velocity: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly angularVelocity: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly colliderRotation = { x: 0, y: 0, z: 0, w: 1 };
  private insertionShape = new RAPIER.Cylinder(DEFAULT_TUNING.thickness / 2, DEFAULT_TUNING.radius);
  private stockClearanceShape = createFeedClearanceShape(this.geometry, this.tuning.thickness);
  private burst: BurstRun | null = null;

  constructor(private readonly world: RAPIER.World, private readonly unsteppedBlocked: UnsteppedBlockedQuery) {}

  feedTrays(): readonly FeedTray[] {
    return this.views;
  }

  /** Exposes native identity for physical diagnostics, without manufacturing poses. */
  nativeBody(id: number): RAPIER.RigidBody | undefined {
    return this.stock.get(id)?.body;
  }

  setLayout(layout: readonly FeedLayout[], tuning: FeedTuning): void {
    validateFeedLayout(layout);
    this.configure(tuning);
    const remaining = [...this.trays];
    const ordered = [...layout].sort((a, b) => a.x - b.x);
    this.trays.length = 0;
    this.views.length = 0;
    for (const lane of ordered) {
      const index = remaining.findIndex((tray) => tray.view.id === lane.id);
      const tray = index < 0 ? this.createTray(lane) : remaining.splice(index, 1)[0]!;
      const burstLane = this.burst?.lanes.find((candidate) => candidate.tray === tray);
      if (!burstLane) this.moveTray(tray, lane.x, 0);
      tray.view.preview = [...lane.preview];
      if (!lane.enabled) {
        this.removeBurstLane(tray);
        this.disableTray(tray);
      } else if (!burstLane) {
        const replenishing = tray.awaitingLayout &&
          tray.stock.length === FEED_PREVIEW_SLOTS - 1 &&
          tray.stock.every((coin, slot) => coin.view.type === lane.preview[slot]);
        const matches = tray.stock.length === FEED_PREVIEW_SLOTS &&
          tray.stock.every((coin, slot) => coin.view.type === lane.preview[slot]);
        if (replenishing) {
          // The new supply enters above every surviving body, behind the cover.
          this.addStock(tray, lane.preview[FEED_PREVIEW_SLOTS - 1]!, this.geometry.refillInsertionZ, false);
        } else if (!matches) {
          this.clearStock(tray);
          this.initializeStock(tray);
        }
        if (tray.stock.length === FEED_PREVIEW_SLOTS) tray.awaitingLayout = false;
      }
      tray.view.id = lane.id;
      tray.view.ownerId = lane.ownerId;
      tray.view.enabled = lane.enabled;
      tray.view.slot = lane.slot;
      tray.view.source = lane.source;
      this.trays.push(tray);
      this.views.push(tray.view);
    }
    for (const tray of remaining) {
      this.removeBurstLane(tray);
      this.removeTray(tray);
    }
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  configure(tuning: FeedTuning): void {
    const dy = tuning.dropHeight - this.tuning.dropHeight;
    const resized = tuning.radius !== this.tuning.radius || tuning.thickness !== this.tuning.thickness;
    if (resized) this.insertionShape = new RAPIER.Cylinder(tuning.thickness / 2, tuning.radius);
    if (!resized && dy === 0 && tuning.friction === this.tuning.friction &&
      tuning.coinWeight === this.tuning.coinWeight) return;
    this.updateFriction(tuning.friction);
    this.updateCoinWeight(tuning.coinWeight);
    this.tuning = { ...tuning };
    this.geometry = getFeedTrayGeometry(tuning.radius, tuning.thickness, tuning.dropHeight);
    if (resized) this.stockClearanceShape = createFeedClearanceShape(this.geometry, tuning.thickness);
    if (resized) {
      const layout = this.views.map(({ id, ownerId, enabled, slot, x, source, preview }) =>
        ({ id, ownerId, enabled, slot, x, source, preview }));
      this.clear();
      for (const lane of layout) {
        const tray = this.createTray(lane);
        this.trays.push(tray);
        this.views.push(tray.view);
      }
    } else if (dy !== 0) {
      for (const tray of this.trays) this.moveTray(tray, tray.view.x, dy);
    }
  }

  updateFriction(friction: number): void {
    if (friction === this.tuning.friction) return;
    this.tuning.friction = friction;
    for (const tray of this.trays) {
      for (const collider of tray.colliders) updateColliderFriction(collider, friction);
      for (const coin of tray.stock) {
        updateColliderFriction(coin.collider, friction);
        coin.body.wakeUp();
      }
    }
  }

  updateCoinWeight(weight: number): void {
    this.tuning.coinWeight = weight;
    for (const coin of this.stock.values()) {
      if (coin.collider.density() === weight) continue;
      coin.collider.setDensity(weight);
      coin.body.recomputeMassPropertiesFromColliders();
      coin.body.wakeUp();
    }
  }

  /** All lanes pass before any gate, stock membership, or ledger state changes. */
  release(
    blocked: (body: RAPIER.RigidBody, collider: RAPIER.Collider) => boolean,
    admit: (view: CoinView, body: RAPIER.RigidBody, collider: RAPIER.Collider) => number,
  ): number[] | null {
    if (this.burst) return null;
    let hasEnabledLane = false;
    this.world.propagateModifiedBodyPositionsToColliders();
    for (const tray of this.trays) {
      if (!tray.view.enabled) continue;
      hasEnabledLane = true;
      const next = tray.stock[0];
      if (!next || tray.view.gateOpen || tray.awaitingLayout ||
        tray.stock.length !== FEED_PREVIEW_SLOTS || !this.isReady(tray, next) ||
        blocked(next.body, next.collider)) return null;
      this.sync(next);
    }
    if (!hasEnabledLane) return null;
    for (let index = 0; index < this.trays.length; index += 1) {
      const tray = this.trays[index]!;
      if (!tray.view.enabled) continue;
      const coin = tray.stock[0]!;
      for (let other = index + 1; other < this.trays.length; other += 1) {
        const candidateTray = this.trays[other]!;
        if (!candidateTray.view.enabled) continue;
        const candidate = candidateTray.stock[0]!;
        if (coin.collider.shape.intersectsShape(coin.view.position, coin.view.rotation,
          candidate.collider.shape, candidate.view.position, candidate.view.rotation)) return null;
      }
    }
    const ids: number[] = [];
    for (const tray of this.trays) {
      if (!tray.view.enabled) continue;
      const next = tray.stock.shift()!;
      tray.views.shift();
      this.stock.delete(next.view.id);
      tray.floor.setEnabled(false);
      tray.frontFloor.setEnabled(false);
      tray.stop.setEnabled(false);
      tray.view.gateOpen = true;
      tray.released = next;
      tray.awaitingLayout = true;
      this.world.removeImpulseJoint(next.guide, true);
      next.body.setSoftCcdPrediction(0);
      next.collider.setCollisionGroups(BOARD_COIN_GROUPS);
      // Higher coins remain behind the passive holdback until the door closes.
      next.body.wakeUp();
      ids.push(admit(next.view, next.body, next.collider));
    }
    return ids;
  }

  /** Opens one captured five-row cohort without adopting any body early. */
  startBurst(
    blocked: (body: RAPIER.RigidBody, collider: RAPIER.Collider) => boolean,
  ): boolean {
    if (this.burst) return false;
    const trays = this.trays.filter((tray) => tray.view.enabled);
    if (trays.length === 0) return false;
    this.world.propagateModifiedBodyPositionsToColliders();
    for (const tray of trays) {
      if (tray.view.gateOpen || tray.released || tray.awaitingLayout ||
        tray.stock.length !== FEED_PREVIEW_SLOTS || !this.isBurstReady(tray) ||
        blocked(tray.stock[0]!.body, tray.stock[0]!.collider)) return false;
    }
    for (let index = 0; index < trays.length; index += 1) {
      const coin = trays[index]!.stock[0]!;
      for (let other = index + 1; other < trays.length; other += 1) {
        const candidate = trays[other]!.stock[0]!;
        if (coin.collider.shape.intersectsShape(coin.view.position, coin.view.rotation,
          candidate.collider.shape, candidate.view.position, candidate.view.rotation)) return false;
      }
    }
    const lanes = trays.map((tray): BurstLane => ({
      tray,
      members: tray.stock.map((stock, index) => ({
        stock,
        row: index + 1,
        admittedId: null,
        previousLocalZ: this.stockLocalZ(stock),
      })),
    }));
    this.burst = { phase: "emitting", lanes, closed: false };
    for (const lane of lanes) {
      lane.tray.floor.setEnabled(false);
      lane.tray.frontFloor.setEnabled(false);
      lane.tray.stop.setEnabled(false);
      lane.tray.view.gateOpen = true;
      this.updateBurstView(lane);
      for (const member of lane.members) {
        member.stock.guide.setLimits(-this.geometry.depth, this.geometry.outletCenterZ);
        member.stock.body.wakeUp();
      }
    }
    return true;
  }

  /** Adopts only bodies that physically reached a clear transformed outlet. */
  advanceBurst(
    blocked: (body: RAPIER.RigidBody, collider: RAPIER.Collider) => boolean,
    admit: (view: CoinView, body: RAPIER.RigidBody, collider: RAPIER.Collider) => number,
  ): NativeFeedAdmission[] {
    const run = this.burst;
    if (!run) return [];
    const admissions: NativeFeedAdmission[] = [];
    this.world.propagateModifiedBodyPositionsToColliders();
    if (run.phase === "emitting") {
      for (let row = 1; row <= FEED_PREVIEW_SLOTS; row += 1) {
        for (const lane of run.lanes) {
          const member = lane.members[row - 1]!;
          if (member.admittedId !== null) continue;
          const { stock } = member;
          if (!stock.body.isValid() || !this.reachedOutlet(member) ||
            blocked(stock.body, stock.collider)) continue;
          const admittedId = admit(stock.view, stock.body, stock.collider);
          member.admittedId = admittedId;
          this.stock.delete(stock.view.id);
          const index = lane.tray.stock.indexOf(stock);
          if (index >= 0) {
            lane.tray.stock.splice(index, 1);
            lane.tray.views.splice(index, 1);
          }
          this.world.removeImpulseJoint(stock.guide, true);
          stock.body.setSoftCcdPrediction(0);
          stock.collider.setCollisionGroups(BOARD_COIN_GROUPS);
          stock.body.wakeUp();
          this.updateBurstView(lane);
          admissions.push({
            chuteId: lane.tray.view.id,
            id: admittedId,
            type: stock.view.type,
            row: member.row,
          });
        }
      }
      if (run.lanes.every((lane) => lane.members.every((member) => member.admittedId !== null))) {
        run.phase = "rearming";
        for (const lane of run.lanes) this.updateBurstView(lane);
      }
    }
    this.advanceBurstRearm();
    return admissions;
  }

  /** Stops further adoption; still-native stock remains guided and unconsumed. */
  cancelBurst(): void {
    const run = this.burst;
    if (!run) return;
    run.phase = "rearming";
    for (const lane of run.lanes) this.updateBurstView(lane);
    this.advanceBurstRearm();
  }

  /** Sync reusable views and close only after the admitted cylinder clears the floor. */
  afterStep(): void {
    for (const tray of this.trays) {
      for (const coin of tray.stock) this.sync(coin);
      if (tray.view.enabled && tray.awaitingLayout && tray.stock.length === 0) this.initializeStock(tray);
      else if (!tray.view.enabled && tray.view.gateOpen && !this.gateBlocked(tray))
        this.setGateClosed(tray, true);
      const released = tray.released;
      if (!released) continue;
      if (!this.gateBlocked(tray)) {
        tray.floor.setEnabled(true);
        tray.frontFloor.setEnabled(true);
        tray.stop.setEnabled(true);
        tray.view.gateOpen = false;
        tray.released = null;
        const next = tray.stock[0];
        if (next) {
          next.guide.setLimits(-this.geometry.depth, 0);
          next.body.wakeUp();
        }
      }
    }
  }

  clear(): void {
    this.burst = null;
    for (const tray of this.trays) this.removeTray(tray);
    this.trays.length = 0;
    this.views.length = 0;
  }

  private isReady(tray: Tray, coin: Stock): boolean {
    const last = tray.stock[tray.stock.length - 1]!;
    last.body.translation(this.position);
    const lastZ = -(this.position.y - this.tuning.dropHeight) * FEED_TRAY_SIN +
      (this.position.z - PLAYER_DROP_Z) * FEED_TRAY_COS;
    if (lastZ < -FEED_PREVIEW_SLOTS * this.geometry.spacing + 2 * this.tuning.radius + 0.02)
      return false;
    coin.body.translation(this.position);
    coin.body.linvel(this.velocity);
    const dy = this.position.y - this.tuning.dropHeight;
    const dz = this.position.z - PLAYER_DROP_Z;
    const localY = FEED_TRAY_COS * dy + FEED_TRAY_SIN * dz;
    const localZ = -FEED_TRAY_SIN * dy + FEED_TRAY_COS * dz;
    const tolerance = Math.min(0.025, this.tuning.radius * 0.2);
    return Math.abs(this.position.x - tray.view.x) < 0.015 &&
      Math.abs(localY) < tolerance && Math.abs(localZ) < tolerance &&
      this.velocity.x ** 2 + this.velocity.y ** 2 + this.velocity.z ** 2 < 0.04;
  }


  private isBurstReady(tray: Tray): boolean {
    let previousZ = Number.POSITIVE_INFINITY;
    const tolerance = Math.min(0.025, this.tuning.radius * 0.2);
    for (let index = 0; index < tray.stock.length; index += 1) {
      const coin = tray.stock[index]!;
      if (!coin.body.isValid()) return false;
      coin.body.translation(coin.view.position);
      coin.body.linvel(this.velocity);
      coin.body.angvel(this.angularVelocity);
      const dy = coin.view.position.y - this.tuning.dropHeight;
      const dz = coin.view.position.z - PLAYER_DROP_Z;
      const localY = FEED_TRAY_COS * dy + FEED_TRAY_SIN * dz;
      const localZ = -FEED_TRAY_SIN * dy + FEED_TRAY_COS * dz;
      if (Math.abs(coin.view.position.x - tray.view.x) >= 0.015 ||
        Math.abs(localY) >= tolerance ||
        this.velocity.x ** 2 + this.velocity.y ** 2 + this.velocity.z ** 2 >= 0.04 ||
        this.angularVelocity.x ** 2 + this.angularVelocity.y ** 2 + this.angularVelocity.z ** 2 >= 0.04 ||
        index === 0 && Math.abs(localZ - this.geometry.outletCenterZ) >= tolerance ||
        index > 0 && localZ > previousZ - 2 * this.tuning.radius + tolerance ||
        localZ < this.geometry.refillInsertionZ - tolerance) return false;
      previousZ = localZ;
      coin.body.rotation(coin.view.rotation);
    }
    return true;
  }

  private stockLocalZ(coin: Stock): number {
    coin.body.translation(this.position);
    const dy = this.position.y - this.tuning.dropHeight;
    const dz = this.position.z - PLAYER_DROP_Z;
    return -FEED_TRAY_SIN * dy + FEED_TRAY_COS * dz;
  }

  private reachedOutlet(member: BurstMember): boolean {
    const currentLocalZ = this.stockLocalZ(member.stock);
    const outlet = this.geometry.outletCenterZ;
    const crossedOutlet = member.previousLocalZ < outlet && currentLocalZ >= outlet;
    const reached = crossedOutlet ||
      currentLocalZ >= outlet - Math.min(0.02, this.tuning.radius * 0.1);
    member.previousLocalZ = currentLocalZ;
    return reached;
  }

  private advanceBurstRearm(): void {
    const run = this.burst;
    if (!run || run.phase !== "rearming") return;
    if (!run.closed) {
      const admittedBodyBlocksClosure = run.lanes.some(({ tray }) => this.gateBlocked(tray));
      if (admittedBodyBlocksClosure) return;
      run.closed = true;
      for (const lane of run.lanes) {
        lane.tray.floor.setEnabled(true);
        lane.tray.frontFloor.setEnabled(true);
        lane.tray.stop.setEnabled(true);
        lane.tray.view.gateOpen = false;
        for (let index = 0; index < lane.tray.stock.length; index += 1) {
          const stock = lane.tray.stock[index]!;
          stock.guide.setLimits(-this.geometry.depth,
            index === 0 ? this.geometry.outletCenterZ : -2 * this.tuning.radius - HOLDBACK_GAP);
          stock.body.wakeUp();
        }
        this.updateBurstView(lane);
      }
    }
    for (const lane of run.lanes) {
      const { tray } = lane;
      if (!tray.view.enabled || tray.stock.length >= FEED_PREVIEW_SLOTS ||
        !this.canInsertStock(tray)) continue;
      const type = tray.view.preview[tray.stock.length];
      if (type) this.addStock(tray, type, this.geometry.refillInsertionZ, tray.stock.length === 0);
    }
    if (run.lanes.every(({ tray }) =>
      !tray.view.enabled ||
      tray.stock.length === FEED_PREVIEW_SLOTS && this.isBurstReady(tray))) {
      for (const lane of run.lanes) this.setIdleBurstView(lane.tray);
      this.burst = null;
    }
  }

  private canInsertStock(tray: Tray): boolean {
    const localZ = this.geometry.refillInsertionZ;
    this.position.x = tray.view.x;
    this.position.y = this.tuning.dropHeight - localZ * FEED_TRAY_SIN;
    this.position.z = PLAYER_DROP_Z + localZ * FEED_TRAY_COS;
    this.world.propagateModifiedBodyPositionsToColliders();
    if (this.world.intersectionWithShape(
      this.position,
      FEED_TRAY_ROTATION,
      this.insertionShape,
      undefined,
      STOCK_COIN_GROUPS,
      undefined,
      tray.body,
    ) !== null) return false;
    // The broad phase cannot see stock added this tick; test surviving stock directly.
    for (const coin of tray.stock) {
      if (this.insertionShape.intersectsShape(this.position, FEED_TRAY_ROTATION,
        coin.collider.shape, coin.collider.translation(), coin.collider.rotation())) return false;
    }
    return true;
  }

  private updateBurstView(lane: BurstLane): void {
    const run = this.burst;
    if (!run) return;
    lane.tray.view.burst = {
      phase: run.phase,
      cohort: lane.members.map(({ stock, row, admittedId }) => ({
        stockId: stock.view.id,
        type: stock.view.type,
        row,
        admittedId,
      })),
      trapRetracted: !run.closed,
    };
  }

  private setIdleBurstView(tray: Tray): void {
    tray.view.burst = { phase: "idle", cohort: [], trapRetracted: false };
  }

  private removeBurstLane(tray: Tray): void {
    const run = this.burst;
    if (!run) return;
    const index = run.lanes.findIndex((lane) => lane.tray === tray);
    if (index < 0) return;
    run.lanes.splice(index, 1);
    this.setIdleBurstView(tray);
    if (run.lanes.length === 0) {
      this.burst = null;
      return;
    }
    if (run.phase === "emitting" &&
      run.lanes.every((lane) => lane.members.every((member) => member.admittedId !== null))) {
      run.phase = "rearming";
      for (const lane of run.lanes) this.updateBurstView(lane);
    }
  }

  private createTray(lane: FeedLayout): Tray {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(lane.x, this.tuning.dropHeight, PLAYER_DROP_Z)
      .setRotation(FEED_TRAY_ROTATION));
    const views: CoinView[] = [];
    const tray: Tray = {
      body, colliders: [], stock: [], views, released: null, awaitingLayout: false,
      view: {
        id: lane.id,
        ownerId: lane.ownerId,
        enabled: lane.enabled,
        slot: lane.slot,
        x: lane.x,
        source: lane.source,
        preview: [...lane.preview],
        coins: views,
        gateOpen: false,
        burst: { phase: "idle", cohort: [], trapRetracted: false },
      },
      floor: null!,
      frontFloor: null!,
      stop: null!,
    };
    const g = this.geometry;
    const floor = (rear: number, front: number) => this.addBox(tray,
      g.width / 2, g.floorThickness / 2, (front - rear) / 2,
      0, g.localBaseY, (front + rear) / 2, FEED_FLOOR_GROUPS);
    floor(g.localRearZ, g.trapRearZ);
    tray.floor = floor(g.trapRearZ, g.trapFrontZ);
    tray.frontFloor = floor(g.trapFrontZ, g.localFrontZ);
    for (const side of [-1, 1]) this.addBox(tray, g.wallThickness / 2, g.lipHeight / 2,
      g.depth / 2, side * g.sideWallCenterX, g.wallCenterY, g.localCenterZ);
    tray.stop = this.addBox(tray, g.width / 2, g.lipHeight / 2, g.wallThickness / 2,
      0, g.wallCenterY, g.frontStopZ);
    if (lane.enabled) this.initializeStock(tray);
    return tray;
  }

  private addBox(tray: Tray, hx: number, hy: number, hz: number, x: number, y: number, z: number,
    groups = FEED_TRAY_GROUPS): RAPIER.Collider {
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z).setFriction(this.tuning.friction)
      .setCollisionGroups(groups), tray.body);
    tray.colliders.push(collider);
    return collider;
  }

  private addStock(tray: Tray, type: CoinView["type"], localZ: number, canTravelFront: boolean): void {
    const position = { x: tray.view.x, y: this.tuning.dropHeight - localZ * FEED_TRAY_SIN,
      z: PLAYER_DROP_Z + localZ * FEED_TRAY_COS };
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position.x, position.y, position.z).setRotation(FEED_TRAY_ROTATION)
      // Predict thin-disc rim impacts before overlap selects an unusable cap normal.
      .setCcdEnabled(true).setSoftCcdPrediction(0.2).setAdditionalSolverIterations(4));
    const collider = this.world.createCollider(RAPIER.ColliderDesc.cylinder(
      this.tuning.thickness / 2, this.tuning.radius).setFriction(this.tuning.friction)
      .setDensity(this.tuning.coinWeight).setCollisionGroups(STOCK_COIN_GROUPS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body);
    // The rail supplies lateral/normal guidance only. Downhill travel has no motor.
    const guide = this.world.createImpulseJoint(RAPIER.JointData.prismatic(
      { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }),
      tray.body, body, true) as RAPIER.PrismaticImpulseJoint;
    guide.setContactsEnabled(true);
    // The rail end stop backs the low lip even for thin, fast-moving stock.
    guide.setLimits(-this.geometry.depth,
      canTravelFront ? this.geometry.outletCenterZ : -2 * this.tuning.radius - HOLDBACK_GAP);
    const view: CoinView = { id: this.nextStockId--, type, bombHits: 0, position,
      rotation: { ...FEED_TRAY_ROTATION }, radius: this.tuning.radius, thickness: this.tuning.thickness };
    const coin = { body, collider, guide, view };
    this.sync(coin);
    tray.stock.push(coin);
    tray.views.push(view);
    this.stock.set(view.id, coin);
  }

  private sync(coin: Stock): void {
    coin.body.translation(coin.view.position);
    coin.body.rotation(coin.view.rotation);
  }

  private moveTray(tray: Tray, x: number, dy: number): void {
    const dx = x - tray.view.x;
    if (dx === 0 && dy === 0) return;
    tray.body.translation(this.position);
    this.position.x += dx;
    this.position.y += dy;
    tray.body.setTranslation(this.position, true);
    for (const coin of tray.stock) {
      coin.body.translation(this.position);
      this.position.x += dx;
      this.position.y += dy;
      coin.body.setTranslation(this.position, true);
      this.sync(coin);
    }
    tray.view.x = x;
  }


  private gateBlocked(tray: Tray): boolean {
    return feedColliderBlocked(this.world, tray.floor, this.position, this.colliderRotation, this.unsteppedBlocked) ||
      feedColliderBlocked(this.world, tray.frontFloor, this.position, this.colliderRotation, this.unsteppedBlocked) ||
      feedColliderBlocked(this.world, tray.stop, this.position, this.colliderRotation, this.unsteppedBlocked);
  }

  private disableTray(tray: Tray): void {
    this.clearStock(tray);
    // Dead supply is removed immediately; admitted bodies must drain before shuttering.
    this.setGateClosed(tray, !this.gateBlocked(tray));
    this.setIdleBurstView(tray);
    tray.released = null;
    tray.awaitingLayout = false;
  }

  private setGateClosed(tray: Tray, closed: boolean): void {
    tray.floor.setEnabled(closed);
    tray.frontFloor.setEnabled(closed);
    tray.stop.setEnabled(closed);
    tray.view.gateOpen = !closed;
  }

  private initializeStock(tray: Tray): void {
    const blocked = feedClearanceBlocked(this.world, this.stockClearanceShape, this.geometry, this.tuning.dropHeight, tray.view.x, this.position, this.unsteppedBlocked);
    this.setGateClosed(tray, !blocked);
    tray.awaitingLayout = blocked;
    if (blocked) return;
    for (let slot = 0; slot < FEED_PREVIEW_SLOTS; slot++)
      this.addStock(tray, tray.view.preview[slot]!, -slot * this.geometry.spacing, slot === 0);
  }

  private clearStock(tray: Tray): void {
    for (const coin of tray.stock) {
      this.stock.delete(coin.view.id);
      this.world.removeRigidBody(coin.body);
    }
    tray.stock.length = 0;
    tray.views.length = 0;
  }

  private removeTray(tray: Tray): void {
    this.clearStock(tray);
    this.world.removeRigidBody(tray.body);
  }
}
