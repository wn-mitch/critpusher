/** One click schedules rounds; a busy mechanical feeder waits without consuming a round. */
export function createDropSequence() {
  let remaining = 0;
  let nextTick = 0;
  let intervalTicks = 1;

  function advance(tick: number, release: () => boolean | "waiting"): boolean {
    if (remaining === 0 || tick < nextTick) return false;
    const result = release();
    if (result === "waiting") return false;
    if (!result) {
      remaining = 0;
      return false;
    }
    remaining -= 1;
    nextTick = tick + intervalTicks;
    return true;
  }

  return {
    get remaining() {
      return remaining;
    },
    start(
      count: number,
      delayTicks: number,
      tick: number,
      release: () => boolean | "waiting",
    ): boolean {
      if (remaining !== 0) return false;
      remaining = count;
      intervalTicks = delayTicks;
      nextTick = tick;
      return advance(tick, release) || remaining > 0;
    },
    advance,
    cancel() {
      remaining = 0;
    },
  };
}
