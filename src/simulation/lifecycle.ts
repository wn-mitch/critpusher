import type {
  CoinFaction,
  CollectionEvent,
  CoinView,
  Quaternion,
  Vec3,
} from "../contracts";

export interface LifecycleStats {
  active: number;
  spawned: number;
  collected: number;
  allyCollected: number;
  enemyCollected: number;
  lost: number;
}

export class CoinLifecycle {
  private readonly activeCoins = new Map<number, CoinView>();
  private readonly events: CollectionEvent[] = [];
  private nextId = 1;
  private spawnedCount = 0;
  private collectedCount = 0;
  private allyCollectedCount = 0;
  private enemyCollectedCount = 0;
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

  get allyCollected(): number {
    return this.allyCollectedCount;
  }

  get enemyCollected(): number {
    return this.enemyCollectedCount;
  }

  get lost(): number {
    return this.lostCount;
  }

  reset(): void {
    this.activeCoins.clear();
    this.events.length = 0;
    this.spawnedCount = 0;
    this.collectedCount = 0;
    this.allyCollectedCount = 0;
    this.enemyCollectedCount = 0;
    this.lostCount = 0;
  }

  spawn(
    position: Vec3,
    rotation: Quaternion,
    radius: number,
    thickness: number,
    faction: CoinFaction = "ally",
  ): CoinView {
    const id = this.nextId;
    this.nextId += 1;
    const coin: CoinView = {
      id,
      faction,
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
    return this.resolve(id, "collected", position);
  }

  lose(id: number, position?: Vec3): boolean {
    return this.resolve(id, "lost", position);
  }

  drainEvents(): CollectionEvent[] {
    if (this.events.length === 0) return [];
    const drained = this.events.splice(0, this.events.length);
    return drained;
  }

  stats(): LifecycleStats {
    return {
      active: this.activeCoins.size,
      spawned: this.spawnedCount,
      collected: this.collectedCount,
      allyCollected: this.allyCollectedCount,
      enemyCollected: this.enemyCollectedCount,
      lost: this.lostCount,
    };
  }

  private resolve(
    id: number,
    kind: CollectionEvent["kind"],
    position?: Vec3,
  ): boolean {
    const coin = this.activeCoins.get(id);
    if (!coin) return false;
    const eventPosition = position ?? coin.position;
    this.activeCoins.delete(id);
    if (kind === "collected") {
      this.collectedCount += 1;
      if (coin.faction === "enemy") this.enemyCollectedCount += 1;
      else this.allyCollectedCount += 1;
    } else this.lostCount += 1;
    this.events.push({
      id,
      kind,
      faction: coin.faction,
      position: {
        x: eventPosition.x,
        y: eventPosition.y,
        z: eventPosition.z,
      },
    });
    return true;
  }
}
