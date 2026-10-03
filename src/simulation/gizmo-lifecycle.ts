import type { GizmoDefinition, GizmoEvent, GizmoStats, GizmoView, Quaternion, Vec3 } from "../contracts";
import { deriveSeed, randomFactory } from "../random";

type LossReason = Extract<GizmoEvent, { kind: "lost" }>["reason"];

/** One encounter's mascot ledger, independent of coin accounting and inventory. */
export class GizmoLifecycle {
  readonly gizmos = new Map<number, GizmoView>();
  private readonly events: GizmoEvent[] = [];
  private spawned = 0;
  private collected = 0;
  private lost = 0;
  private pending: { definition: GizmoDefinition; position: Vec3 } | null = null;

  get pendingSpawn(): { definition: GizmoDefinition; position: Vec3 } | null {
    return this.pending;
  }

  configure(definition: GizmoDefinition | null, encounterSeed: number): void {
    if (this.spawned > 0) return;
    if (definition === null) {
      this.pending = null;
      return;
    }
    if (definition.kind !== "bell" || !Number.isFinite(definition.radius) || definition.radius <= 0 ||
      !Number.isFinite(definition.density) || definition.density <= 0 ||
      !Number.isFinite(definition.payout) || definition.payout < 0) {
      throw new Error("Invalid gizmo definition");
    }
    const random = randomFactory(deriveSeed(encounterSeed, 0, 0x47495a4d));
    this.pending = {
      definition: { ...definition },
      position: { x: random() * 6 - 3, y: 2, z: random() * 2 + 0.5 },
    };
  }

  spawn(id: number): GizmoView {
    if (!this.pending) throw new Error("No pending gizmo spawn");
    const view: GizmoView = {
      ...this.pending.definition,
      id,
      position: { ...this.pending.position },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
    };
    this.pending = null;
    this.gizmos.set(id, view);
    this.spawned += 1;
    return view;
  }

  update(id: number, position: Vec3, rotation: Quaternion): void {
    const gizmo = this.gizmos.get(id);
    if (!gizmo) return;
    Object.assign(gizmo.position, position);
    Object.assign(gizmo.rotation, rotation);
  }

  collect(id: number): boolean {
    const gizmo = this.gizmos.get(id);
    if (!gizmo) return false;
    this.gizmos.delete(id);
    this.collected += 1;
    this.events.push({ id, type: gizmo.kind, kind: "collected", currency: gizmo.payout, position: { ...gizmo.position } });
    return true;
  }

  lose(id: number, reason: LossReason): boolean {
    const gizmo = this.gizmos.get(id);
    if (!gizmo) return false;
    this.gizmos.delete(id);
    this.lost += 1;
    this.events.push({ id, type: gizmo.kind, kind: "lost", reason, position: { ...gizmo.position } });
    return true;
  }

  drainEvents(): GizmoEvent[] {
    return this.events.splice(0);
  }

  stats(): GizmoStats {
    return { spawned: this.spawned, active: this.gizmos.size, collected: this.collected, lost: this.lost, pending: this.pending ? 1 : 0 };
  }

  reset(): void {
    this.gizmos.clear();
    this.events.length = 0;
    this.spawned = 0;
    this.collected = 0;
    this.lost = 0;
    this.pending = null;
  }
}
