import type { CollectionEvent, Presentation, Simulation } from "../contracts";
import { selectTargets } from "./targets";

export interface PlacementProbeOptions {
  host: HTMLElement;
  simulation: Simulation;
  presentation: Presentation;
  onChange: () => void;
}

export interface PlacementProbe {
  collect(events: readonly CollectionEvent[]): void;
  reset(): void;
  dispose(): void;
}

const LANE_LABELS = ["Left", "Center", "Right"] as const;

function button(id: string, label: string): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.id = id;
  node.textContent = label;
  return node;
}

/**
 * Small production-facing probe for validating physical placement. It owns no
 * physics and only observes the simulation's current views and event stream.
 */
export function createPlacementProbe({
  host,
  simulation,
  presentation,
  onChange,
}: PlacementProbeOptions): PlacementProbe {
  const panel = document.createElement("section");
  panel.className = "placement-probe";
  panel.setAttribute("aria-label", "Placement probe");

  const heading = document.createElement("h2");
  heading.textContent = "Placement probe";
  const group = document.createElement("fieldset");
  group.className = "tuning-group";
  const legend = document.createElement("legend");
  legend.textContent = "Target lanes";
  const explanation = document.createElement("p");
  explanation.textContent =
    "Up to 3 eligible lower-shelf coins per lane get cyan, ivory, or magenta rims with 1, 2, or 3 face bars.";
  group.append(legend, explanation);

  const mark = button("placement-mark", "Mark edge targets");
  const clear = button("placement-clear", "Clear markers");
  group.append(mark, clear);

  const readout = document.createElement("div");
  readout.className = "placement-readout";
  readout.setAttribute("aria-live", "polite");
  group.append(readout);
  panel.append(heading, group);
  host.append(panel);

  const marked = new Map<number, number>();
  const resolved = new Set<number>();
  const markedCount: [number, number, number] = [0, 0, 0];
  const collected: [number, number, number] = [0, 0, 0];
  const lost: [number, number, number] = [0, 0, 0];
  let disposed = false;

  function updateReadout(): void {
    const remainingByLane: [number, number, number] = [0, 0, 0];
    for (const lane of marked.values()) remainingByLane[lane]! += 1;
    const probeLaneCount = markedCount.filter((count) => count > 0).length;
    const summary = document.createElement("p");
    summary.textContent =
      `Remaining marked coins: ${marked.size}. ` +
      `Probe lanes: ${probeLaneCount} of 3.`;
    readout.replaceChildren(
      summary,
      ...LANE_LABELS.map((label, lane) => {
        const line = document.createElement("div");
        line.textContent =
          `${label}: marked ${markedCount[lane]} · ` +
          `remaining ${remainingByLane[lane]} · ` +
          `collected ${collected[lane]} · lost ${lost[lane]}`;
        return line;
      }),
    );
  }

  function resetState(): void {
    marked.clear();
    resolved.clear();
    markedCount.fill(0);
    collected.fill(0);
    lost.fill(0);
    presentation.markTargets(new Map());
    updateReadout();
  }

  function markCurrent(): void {
    if (disposed) return;
    resetState();
    for (const [id, lane] of selectTargets(
      simulation.coins,
      simulation.tuning.shelfFront,
    )) {
      marked.set(id, lane);
      markedCount[lane]! += 1;
    }
    presentation.markTargets(marked);
    updateReadout();
  }

  function onMark(): void {
    markCurrent();
    onChange();
  }
  function onClear(): void {
    if (disposed) return;
    resetState();
    onChange();
  }
  mark.addEventListener("click", onMark);
  clear.addEventListener("click", onClear);
  updateReadout();

  return {
    collect(events: readonly CollectionEvent[]): void {
      if (disposed) return;
      let changed = false;
      for (const event of events) {
        const lane = marked.get(event.id);
        if (lane === undefined || resolved.has(event.id)) continue;
        resolved.add(event.id);
        marked.delete(event.id);
        if (event.kind === "collected") collected[lane]! += 1;
        else lost[lane]! += 1;
        changed = true;
      }
      if (changed) {
        presentation.markTargets(marked);
        updateReadout();
      }
    },
    reset(): void {
      if (!disposed) resetState();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      mark.removeEventListener("click", onMark);
      clear.removeEventListener("click", onClear);
      marked.clear();
      resolved.clear();
      presentation.markTargets(new Map());
      if (panel.parentElement === host) host.removeChild(panel);
    },
  };
}
