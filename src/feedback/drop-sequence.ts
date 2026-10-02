/** Fixed simulation ticks prevent wall-clock catch-up drops after pauses or stalls. */
export function createDropSequence() {
  let remaining = 0;
  let nextTick = 0;
  let intervalTicks = 1;

  function canStart(tick: number): boolean {
    return remaining === 0 && tick >= nextTick;
  }

  function advance(tick: number, release: () => boolean): boolean {
    if (remaining === 0 || tick < nextTick) return false;
    if (!release()) {
      remaining = 0;
      nextTick = tick + intervalTicks;
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
    canStart,
    start(
      count: number,
      delayTicks: number,
      tick: number,
      release: () => boolean,
    ): boolean {
      if (!canStart(tick)) return false;
      remaining = count;
      intervalTicks = delayTicks;
      nextTick = tick;
      return advance(tick, release);
    },
    advance,
    cancel() {
      remaining = 0;
      nextTick = 0;
    },
  };
}
