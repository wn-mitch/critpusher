export function randomFactory(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Isolated deterministic streams, within the simulation's signed 32-bit seed range. */
export function deriveSeed(rootSeed: number, index: number, tag: number): number {
  return (Math.imul(rootSeed ^ tag, 0x45d9f3b) ^ Math.imul(index + 1, 0x9e3779b9)) | 0;
}
