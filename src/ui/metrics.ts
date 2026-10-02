import type { SimulationStats } from "../contracts";
import type { MetricsSnapshot } from "./types";

function metricRow(label: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "metric-row";
  row.dataset.metric = label;
  const name = document.createElement("dt");
  name.textContent = label;
  const reading = document.createElement("dd");
  reading.textContent = value;
  row.append(name, reading);
  return row;
}

function reading(value: number | undefined, suffix = ""): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value < 10 ? value.toFixed(2) : value.toFixed(0)}${suffix}`;
}

export function renderMetrics(
  host: HTMLElement,
  stats: SimulationStats,
  snapshot: MetricsSnapshot = {},
): void {
  const rows: Array<[string, string]> = [
    ["Physics", reading(stats.physicsMs, " ms")],
    ["Frame", reading(snapshot.frameMs, " ms")],
    ["Render", reading(snapshot.renderMs, " ms")],
    ["Cascade", reading(snapshot.cascadeMs, " ms")],
    ["FPS", reading(snapshot.fps)],
    ["Pusher z", reading(stats.pusherZ)],
    ["Phase", reading(stats.phase)],
    ["Sleeping", String(stats.sleeping)],
    ["Spawned", String(stats.spawned)],
    ["Pending rain", String(stats.pendingRain)],
    ["Dropped steps", String(snapshot.droppedSteps ?? 0)],
  ];
  const list = document.createElement("dl");
  list.className = "metric-list";
  for (const [label, value] of rows) list.append(metricRow(label, value));
  host.replaceChildren(list);
}
