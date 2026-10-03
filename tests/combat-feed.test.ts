import { describe, expect, it } from "vitest";
import { createChuteFeed } from "../src/combat/feed";
import type { CoinType } from "../src/contracts";

const bags: readonly CoinType[][] = [
  ["sword", "sword", "sword", "potion", "gold"],
  ["sword", "sword", "sword", "sword", "bomb"],
  ["skull", "skull", "skull", "gold", "gold"],
];

describe("seeded replenishing chute bags", () => {
  it.each(bags.map((bag) => ({ bag })))("preserves $bag multiplicities across shuffled replenishment", ({ bag }) => {
    const feed = createChuteFeed(42, bag);
    const sequence = Array.from({ length: 100 }, () => feed.consume());
    for (let offset = 0; offset < sequence.length; offset += 5) {
      expect(sequence.slice(offset, offset + 5).sort()).toEqual([...bag].sort());
    }
  });
  it("does not consume random state or tokens through repeated isolated previews", () => {
    const feed = createChuteFeed(7, bags[0]!);
    const control = createChuteFeed(7, bags[0]!);
    const before = feed.snapshot();
    for (let attempt = 0; attempt < 30; attempt++) {
      const preview = feed.preview() as CoinType[];
      preview[0] = "bomb";
    }
    expect(feed.snapshot()).toEqual(before);
    expect(Array.from({ length: 30 }, () => feed.consume())).toEqual(Array.from({ length: 30 }, () => control.consume()));
  });
  it("peeks across bag boundaries without changing the consumed stream and resets exactly", () => {
    const feed = createChuteFeed(1337, bags[1]!);
    const first = Array.from({ length: 3 }, () => feed.consume());
    const boundary = feed.preview();
    expect(Array.from({ length: 5 }, () => feed.consume())).toEqual(boundary);
    feed.reset(1337);
    expect(Array.from({ length: 3 }, () => feed.consume())).toEqual(first);
    expect(feed.preview()).toEqual(boundary);
  });
  it("escalates only beyond five committed tokens and discards the old generated tail", () => {
    const feed = createChuteFeed(113, bags[2]!);
    feed.consume();
    const committed = feed.preview();
    expect(feed.snapshot().queue.length).toBeGreaterThan(5);
    feed.updateBag(["skull", "skull", "skull", "skull", "skull"]);
    expect(feed.snapshot().queue).toEqual(committed);
    expect(Array.from({ length: 5 }, () => feed.consume())).toEqual(committed);
    expect(Array.from({ length: 20 }, () => feed.consume())).toEqual(Array(20).fill("skull"));
  });
  it("rejects invalid bag edits without changing the committed stream", () => {
    const feed = createChuteFeed(19, bags[0]!);
    const before = feed.snapshot();
    expect(() => feed.updateBag([])).toThrow("five valid");
    expect(feed.snapshot()).toEqual(before);
    expect(() => createChuteFeed(19, ["sword"])).toThrow("five valid");
    expect(() => createChuteFeed(19, ["sword", "sword", "sword", "sword", "invalid" as CoinType])).toThrow("five valid");
  });
});
