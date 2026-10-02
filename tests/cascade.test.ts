import { describe, expect, it } from "vitest";
import type { CollectionEvent } from "../src/contracts";
import {
  CASCADE_MAX_SECONDS,
  CASCADE_QUIET_SECONDS,
  createCollectionBurstTracker,
} from "../src/feedback/cascade";

function events(
  firstId: number,
  count: number,
  kind: CollectionEvent["kind"] = "collected",
): CollectionEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: firstId + index,
    kind,
    faction: "ally" as const,
    position: { x: 0, y: 0, z: 0 },
  }));
}

describe("collection cascade tracking", () => {
  it("reports all seven coins cumulatively across simulation frames", () => {
    const tracker = createCollectionBurstTracker();

    const first = tracker.collect(events(1, 2), 1);
    const second = tracker.collect(events(3, 1), 1.2);
    const third = tracker.collect(events(4, 4), 1.5);

    expect([first?.total, second?.total, third?.total]).toEqual([2, 3, 7]);
    expect([first?.added, second?.added, third?.added]).toEqual([2, 1, 4]);
    expect(second?.burstId).toBe(first?.burstId);
    expect(third?.burstId).toBe(first?.burstId);
  });

  it("starts a new burst after the quiet interval", () => {
    const tracker = createCollectionBurstTracker();
    const first = tracker.collect(events(1, 2), 4);

    tracker.advance(4 + CASCADE_QUIET_SECONDS);
    const second = tracker.collect(events(3, 1), 4.8);

    expect(second).toMatchObject({ total: 1, added: 1 });
    expect(second?.burstId).not.toBe(first?.burstId);
  });

  it("caps a sustained stream at the maximum burst duration", () => {
    const tracker = createCollectionBurstTracker();
    const first = tracker.collect(events(1, 1), 10);
    let latest = first;

    for (let offset = 0.5; offset < CASCADE_MAX_SECONDS; offset += 0.5) {
      latest = tracker.collect(events(1 + offset * 2, 1), 10 + offset);
    }
    expect(latest?.burstId).toBe(first?.burstId);
    expect(latest?.total).toBe(6);

    const capped = tracker.collect(events(7, 1), 10 + CASCADE_MAX_SECONDS);
    expect(capped).toMatchObject({ total: 1, added: 1 });
    expect(capped?.burstId).not.toBe(first?.burstId);
  });

  it("excludes losses from totals and from extending a burst", () => {
    const tracker = createCollectionBurstTracker();
    const first = tracker.collect(
      [...events(1, 1), ...events(2, 2, "lost")],
      20,
    );

    expect(first).toMatchObject({ total: 1, added: 1 });
    expect(tracker.collect(events(4, 2, "lost"), 20.5)).toBeNull();

    const afterLosses = tracker.collect(
      events(6, 1),
      20 + CASCADE_QUIET_SECONDS + 0.01,
    );
    expect(afterLosses).toMatchObject({ total: 1, added: 1 });
    expect(afterLosses?.burstId).not.toBe(first?.burstId);
  });

  it("uses only simulation time, so a paused clock keeps the burst open", () => {
    const tracker = createCollectionBurstTracker();
    const beforePause = tracker.collect(events(1, 2), 25);

    const afterPause = tracker.collect(events(3, 1), 25);

    expect(afterPause).toMatchObject({ total: 3, added: 1 });
    expect(afterPause?.burstId).toBe(beforePause?.burstId);
  });

  it("clears the active burst on reset", () => {
    const tracker = createCollectionBurstTracker();
    const beforeReset = tracker.collect(events(1, 3), 30);

    tracker.reset();
    tracker.advance(30.1);
    const afterReset = tracker.collect(events(4, 1), 30.1);

    expect(afterReset).toMatchObject({ total: 1, added: 1 });
    expect(afterReset?.burstId).not.toBe(beforeReset?.burstId);
  });
});
