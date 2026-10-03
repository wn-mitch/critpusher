import { COIN_TYPES } from "../contracts";
import type {
  CoinType,
  CoinEvent,
  CoinView,
  Quaternion,
  Vec3,
} from "../contracts";

export interface LifecycleStats {
  active: number;
  spawned: number;
  collected: number;
  collectedByType: Record<CoinType, number>;
  detonated: number;
  lost: number;
}

type LossReason = Extract<CoinEvent, { kind: "lost" }>["reason"];
type Resolution =
  | { kind: "collected" }
  | { kind: "lost"; reason: LossReason }
  | { kind: "detonated"; chainRootId: number | null; blastAssociated: boolean };

export class CoinLifecycle {
  private readonly activeCoins = new Map<number, CoinView>();
  private readonly events: CoinEvent[] = [];
  private nextId = 1;
  private spawnedCount = 0;
  private collectedCount = 0;
  private readonly collectedCounts: Record<CoinType, number> = {
    gold: 0, diamond: 0, sword: 0, skull: 0, potion: 0, bomb: 0,
  };
  private detonatedCount = 0;
  private lostCount = 0;

  get coins(): ReadonlyMap<number, CoinView> {
    return this.activeCoins;
  }

  get active(): number {
    return this.activeCoins.size;
  }

  get spawned(): number {
    return this.spawnedCount;
  }

  get collected(): number {
    return this.collectedCount;
  }

  get collectedByType(): Record<CoinType, number> {
    return { ...this.collectedCounts };
  }

  get detonated(): number {
    return this.detonatedCount;
  }

  get lost(): number {
    return this.lostCount;
  }

  reset(): void {
    this.activeCoins.clear();
    this.events.length = 0;
    this.spawnedCount = 0;
    this.collectedCount = 0;
    for (const type of COIN_TYPES) this.collectedCounts[type] = 0;
    this.detonatedCount = 0;
    this.lostCount = 0;
  }

  /** Shared physical identity sequence; resetting an encounter never reuses IDs. */
  allocateId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  spawn(
    position: Vec3,
    rotation: Quaternion,
    radius: number,
    thickness: number,
    type: CoinType = "sword",
  ): CoinView {
    const id = this.allocateId();
    const coin: CoinView = {
      id,
      type,
      bombHits: 0,
      position: { x: position.x, y: position.y, z: position.z },
      rotation: {
        x: rotation.x,
        y: rotation.y,
        z: rotation.z,
        w: rotation.w,
      },
      radius,
      thickness,
    };
    this.activeCoins.set(id, coin);
    this.spawnedCount += 1;
    return coin;
  }

  update(id: number, position: Vec3, rotation: Quaternion): boolean {
    const coin = this.activeCoins.get(id);
    if (!coin) return false;
    coin.position.x = position.x;
    coin.position.y = position.y;
    coin.position.z = position.z;
    coin.rotation.x = rotation.x;
    coin.rotation.y = rotation.y;
    coin.rotation.z = rotation.z;
    coin.rotation.w = rotation.w;
    return true;
  }

  collect(id: number, position?: Vec3): boolean {
    return this.resolve(id, { kind: "collected" }, position);
  }

  lose(id: number, reason: LossReason, position?: Vec3): boolean {
    return this.resolve(id, { kind: "lost", reason }, position);
  }

  detonate(
    id: number,
    chainRootId: number | null,
    blastAssociated: boolean,
    position?: Vec3,
  ): boolean {
    if (this.activeCoins.get(id)?.type !== "bomb") return false;
    return this.resolve(
      id,
      { kind: "detonated", chainRootId, blastAssociated },
      position,
    );
  }

  drainEvents(): CoinEvent[] {
    if (this.events.length === 0) return [];
    const drained = this.events.splice(0, this.events.length);
    return drained;
  }

  stats(): LifecycleStats {
    return {
      active: this.activeCoins.size,
      spawned: this.spawnedCount,
      collected: this.collectedCount,
      collectedByType: this.collectedByType,
      detonated: this.detonatedCount,
      lost: this.lostCount,
    };
  }

  private resolve(
    id: number,
    resolution: Resolution,
    position?: Vec3,
  ): boolean {
    const coin = this.activeCoins.get(id);
    if (!coin) return false;
    const eventPosition = position ?? coin.position;
    this.activeCoins.delete(id);
    if (resolution.kind === "collected") {
      this.collectedCount += 1;
      this.collectedCounts[coin.type] += 1;
    } else if (resolution.kind === "detonated") {
      this.detonatedCount += 1;
    } else this.lostCount += 1;
    this.events.push({
      id,
      ...resolution,
      type: coin.type,
      position: {
        x: eventPosition.x,
        y: eventPosition.y,
        z: eventPosition.z,
      },
    });
    return true;
  }
}
