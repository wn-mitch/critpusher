import * as THREE from "three";
import type { StickerId } from "../run/types";

const LABELS: readonly { id: StickerId; text: string }[] = [
  { id: "collected-only", text: "COLLECT ONLY" }, { id: "miniature", text: "MINIATURE" },
  { id: "magazine-dump", text: "MAGAZINE DUMP" }, { id: "combo-bell", text: "COMBO BELL" },
];

/** Owned labels attach to the authored case mounts, not to physical mascot presence. */
export function createCaseStickers() {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Cabinet sticker labels require a 2D canvas context");
  context.font = "700 25px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let index = 0; index < LABELS.length; index++) {
    const x = index % 2 * 256;
    const y = Math.floor(index / 2) * 64;
    context.fillStyle = "#ddd6b9";
    context.fillRect(x, y, 256, 64);
    context.strokeStyle = "#a17b42";
    context.lineWidth = 5;
    context.strokeRect(x + 3, y + 3, 250, 58);
    context.fillStyle = "#292924";
    context.fillText(LABELS[index]!.text, x + 128, y + 32, 232);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture });
  const meshes = LABELS.map(({ id }, index) => {
    const geometry = new THREE.PlaneGeometry(2.35, 0.36);
    const uv = geometry.getAttribute("uv");
    const left = index % 2 * 0.5;
    const bottom = 0.5 - Math.floor(index / 2) * 0.5;
    for (let vertex = 0; vertex < uv.count; vertex++)
      uv.setXY(vertex, left + uv.getX(vertex) * 0.5, bottom + uv.getY(vertex) * 0.5);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `owned-sticker-${id}`;
    return mesh;
  });
  let mounts: THREE.Object3D[] = [];
  let owned: readonly StickerId[] = [];

  function place(): void {
    for (const mesh of meshes) mesh.removeFromParent();
    for (let index = 0; index < owned.length; index++) {
      const label = LABELS.findIndex(({ id }) => id === owned[index]);
      mounts[index]!.add(meshes[label]!);
    }
  }
  return {
    bind(root: THREE.Object3D): void {
      mounts = [1, 2, 3].map((index) => {
        const mount = root.getObjectByName(`sticker_mount_${index}`);
        if (!mount) throw new Error(`Authored cabinet is missing sticker_mount_${index}; run just cabinet-assets`);
        return mount;
      });
      place();
    },
    set(ids: readonly StickerId[]): void {
      let changed = ids.length !== owned.length;
      for (let index = 0; !changed && index < ids.length; index++) changed = ids[index] !== owned[index];
      if (!changed) return;
      owned = [...ids];
      place();
    },
    dispose(): void {
      for (const mesh of meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); }
      material.dispose();
      texture.dispose();
    },
  };
}
