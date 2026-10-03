import { createChuteLayout, ENEMY_CHUTE_SLOTS, PLAYER_CHUTE_SLOTS, type ChuteSettings, type ChuteSlot } from "../chutes";
import type { CoinType, Tuning } from "../contracts";
import { deriveSeed } from "../random";
import { createChuteFeed, type ChuteFeed } from "./feed";
import type { EnemyState, FeedLayout, PlayerChuteDefinition, WaveDefinition } from "./types";

/** Player streams survive wave changes; each enemy lifetime receives its own stream. */
export class EncounterFeeds {
  private readonly streams = new Map<string, ChuteFeed>();
  private wave: WaveDefinition;
  private readonly pressureLevel = new Map<string, number>();
  constructor(private readonly seed: number, readonly players: readonly PlayerChuteDefinition[], wave: WaveDefinition) {
    this.wave = wave;
    players.forEach((player, ordinal) => this.streams.set(player.id,
      createChuteFeed(deriveSeed(seed, ordinal, 0x504c4159), player.bag)));
    this.enterWave(wave, 0);
  }
  enterWave(wave: WaveDefinition, waveIndex: number): void {
    for (const enemy of this.wave.enemies) this.streams.delete(enemy.chuteId);
    this.wave = wave;
    this.pressureLevel.clear();
    wave.enemies.forEach((enemy, index) => this.streams.set(enemy.chuteId,
      createChuteFeed(deriveSeed(this.seed, waveIndex * 3 + index, 0x454e454d), enemy.bag)));
  }
  slots(enemies: readonly EnemyState[]): ChuteSlot[] {
    return [
      ...this.players.map((player, index): ChuteSlot => ({ id: player.id, ownerId: "player",
        source: "player", slot: PLAYER_CHUTE_SLOTS[index]!, enabled: true })),
      ...this.wave.enemies.map((enemy, index): ChuteSlot => ({ id: enemy.chuteId, ownerId: enemy.id,
        source: "enemy", slot: ENEMY_CHUTE_SLOTS[index]!, enabled: enemies.some((state) => state.id === enemy.id && state.hp > 0) })),
    ];
  }
  layout(enemies: readonly EnemyState[], tuning: Pick<Tuning, "radius">, aimX: number, settings: ChuteSettings): FeedLayout[] {
    return createChuteLayout(this.slots(enemies), tuning, aimX, settings.chuteSpacing)
      .map((lane) => ({ ...lane, preview: lane.enabled ? this.streams.get(lane.id)!.preview() : [] }));
  }
  consume(chuteId: string, expectedType: CoinType): void {
    const stream = this.streams.get(chuteId);
    if (!stream || stream.preview()[0] !== expectedType) throw new Error(`Chute token mismatch: ${chuteId}`);
    stream.consume();
  }
  /** Apply pressure only after committed native-body consumption for the admitted row. */
  escalate(enemies: readonly EnemyState[]): void {
    for (const enemy of enemies) {
      if (enemy.hp === 0 || enemy.kind !== "escalator") continue;
      const level = Math.min(2, Math.floor(enemy.admittedRounds / 5));
      if (level === (this.pressureLevel.get(enemy.id) ?? 0)) continue;
      const definition = this.wave.enemies.find(({ id }) => id === enemy.id)!;
      const bag = [...definition.bag];
      for (let count = 0; count < level; count++) {
        const gold = bag.indexOf("gold");
        if (gold >= 0) bag[gold] = "skull";
      }
      this.streams.get(enemy.chuteId)!.updateBag(bag);
      this.pressureLevel.set(enemy.id, level);
    }
  }
  snapshot() {
    return [...this.streams].map(([chuteId, stream]) => ({ chuteId, ...stream.snapshot() }));
  }
}
