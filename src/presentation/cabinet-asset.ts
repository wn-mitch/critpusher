import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const CABINET_MODULES = [
  "cabinet_shell",
  "playfield",
  "pusher",
  "collection_tray",
  "feed_rail",
  "feed_gate",
  "feed_cover",
  "combo_bell",
] as const;

export type CabinetModuleName = (typeof CABINET_MODULES)[number];

export interface CabinetAsset {
  readonly bounds: THREE.Box3;
  instantiate(name: CabinetModuleName): THREE.Object3D;
  dispose(): void;
}

function disposeMaterialTextures(material: THREE.Material, disposed: Set<THREE.Texture>): void {
  const values = Object.values(material as unknown as Record<string, unknown>);
  for (const value of values) {
    if (value instanceof THREE.Texture && !disposed.has(value)) {
      value.dispose();
      disposed.add(value);
    }
  }
}

function disposeSceneResources(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    const meshMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of meshMaterials) materials.add(material);
  });
  for (const material of materials) {
    disposeMaterialTextures(material, textures);
    material.dispose();
  }
  for (const geometry of geometries) geometry.dispose();
}

/** Load and validate the authored machine. Failure is fatal; there is no procedural cabinet fallback. */
export async function loadCabinetAsset(): Promise<CabinetAsset> {
  const assetUrl = new URL("../assets/cabinet.glb", import.meta.url).href;
  let assetScene: THREE.Group;
  try {
    const gltf = await new GLTFLoader().loadAsync(assetUrl);
    assetScene = gltf.scene;
  } catch (cause) {
    throw new Error(
      `Unable to load the authored cabinet (${assetUrl}). Run "just cabinet-assets" and reload.`,
      { cause },
    );
  }

  const modules = {} as Record<CabinetModuleName, THREE.Object3D>;
  for (const name of CABINET_MODULES) {
    const module = assetScene.getObjectByName(name);
    if (!module) {
      disposeSceneResources(assetScene);
      throw new Error(
        `Authored cabinet is missing required module "${name}". Run "just cabinet-assets" to regenerate it.`,
      );
    }
    modules[name] = module;
  }

  assetScene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().makeEmpty();
  for (const name of ["cabinet_shell", "playfield", "pusher", "collection_tray"] as const) {
    bounds.union(new THREE.Box3().setFromObject(modules[name]));
  }

  let disposed = false;
  return {
    bounds,
    instantiate(name) {
      if (disposed) throw new Error("Cannot instantiate a disposed cabinet asset");
      return modules[name].clone(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      assetScene.removeFromParent();
      disposeSceneResources(assetScene);
    },
  };
}
