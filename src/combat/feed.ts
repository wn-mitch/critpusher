import { COIN_TYPES, type CoinType } from "../contracts";
import { randomFactory } from "../random";
import { MACHINE_GEOMETRY } from "../machine-geometry";
import { FEED_PREVIEW_SLOTS } from "../feed-geometry";
import type { FeedLayout } from "./types";

export interface ChuteFeedSnapshot {
  seed: number;
  bag: readonly CoinType[];
  queue: readonly CoinType[];
  consumed: number;
  shuffles: number;
}
export interface ChuteStreamSnapshot extends ChuteFeedSnapshot { chuteId: string }
export interface ChuteFeed {
  preview(): readonly CoinType[];
  consume(): CoinType;
  reset(seed: number): void;
  /** Preserve five committed bodies/types; discard only a generated, uncommitted tail. */
  updateBag(bag: readonly CoinType[]): void;
  snapshot(): ChuteFeedSnapshot;
}

export function validateBag(bag: readonly CoinType[]): CoinType[] {
  if (!Array.isArray(bag) || bag.length !== 5 || Array.from(bag).some((type) => !COIN_TYPES.includes(type))) {
    throw new Error("Chute bag requires exactly five valid coin types");
  }
  return [...bag];
}

export function validateFeedLayout(layout: readonly FeedLayout[]): void {
  if (layout.length > MACHINE_GEOMETRY.maxTrays)
    throw new Error(`feed layout supports at most ${MACHINE_GEOMETRY.maxTrays} lanes`);
  const ids = new Set<string>();
  let players = 0;
  let enemies = 0;
  for (const lane of layout) {
    if (typeof lane.id !== "string" || lane.id.trim().length === 0 || ids.has(lane.id))
      throw new Error("feed layout lane IDs must be nonempty and unique");
    ids.add(lane.id);
    if (typeof lane.ownerId !== "string" || lane.ownerId.trim().length === 0)
      throw new Error("feed layout owner IDs must be nonempty");
    if (lane.source === "player") players += 1;
    else if (lane.source === "enemy") enemies += 1;
    else throw new Error("feed layout lane source must be player or enemy");
    if (players > MACHINE_GEOMETRY.maxTrays / 2 || enemies > MACHINE_GEOMETRY.maxTrays / 2)
      throw new Error("feed layout supports at most three player and three enemy lanes");
    if (!Number.isInteger(lane.slot) || !Number.isFinite(lane.x) ||
      typeof lane.enabled !== "boolean" || !Array.isArray(lane.preview) ||
      lane.preview.length !== (lane.enabled ? FEED_PREVIEW_SLOTS : 0) ||
      lane.preview.some(type => !COIN_TYPES.includes(type)))
      throw new Error("feed lanes require a finite slot and position; enabled lanes require five valid coin types; disabled lanes require none");
  }
}

export function createChuteFeed(initialSeed: number, initialBag: readonly CoinType[]): ChuteFeed {
  let seed = initialSeed;
  let bag = validateBag(initialBag);
  let random = randomFactory(seed ^ 0x6d2b79f1);
  const queue: CoinType[] = [];
  let consumed = 0;
  let shuffles = 0;
  function fill(): void {
    while (queue.length < 5) {
      const next = [...bag];
      for (let index = next.length - 1; index > 0; index--) {
        const other = Math.floor(random() * (index + 1));
        [next[index], next[other]] = [next[other]!, next[index]!];
      }
      shuffles++;
      queue.push(...next);
    }
  }
  fill();
  return {
    preview: () => queue.slice(0, 5),
    consume() {
      const next = queue.shift()!;
      consumed++;
      fill();
      return next;
    },
    reset(nextSeed) {
      seed = nextSeed;
      random = randomFactory(seed ^ 0x6d2b79f1);
      consumed = 0;
      shuffles = 0;
      queue.length = 0;
      fill();
    },
    updateBag(nextBag) {
      bag = validateBag(nextBag);
      queue.splice(5);
    },
    snapshot: () => ({ seed, bag: [...bag], queue: [...queue], consumed, shuffles }),
  };
}
