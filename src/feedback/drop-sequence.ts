/** One click schedules single-coin rounds; its delay never gates the next set. */
export function createDropSequence() {
  let remaining = 0;
  let nextTick = 0;
  let intervalTicks = 1;

  function advance(tick: number, release: () => boolean): boolean {
    if (remaining === 0 || tick < nextTick) return false;
    if (!release()) {
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
      release: () => boolean,
    ): boolean {
      if (remaining !== 0) return false;
      remaining = count;
      intervalTicks = delayTicks;
      nextTick = tick;
      return advance(tick, release);
    },
    advance,
    cancel() {
      remaining = 0;
    },
  };
}
