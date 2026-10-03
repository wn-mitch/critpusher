import * as THREE from "three";
import type { CoinEvent, GizmoView, Presentation, Simulation } from "../contracts";
import type { CombatStepResult, FeedTray } from "../combat/types";
import { DEFAULT_TUNING, PLAYER_DROP_Z } from "../simulation/config";
import { MACHINE_GEOMETRY } from "../machine-geometry";
import { fitMachineCamera } from "./camera";
import { loadCabinetAsset } from "./cabinet-asset";
import { createCoinRenderer } from "./coins";
import { createCoinSymbolResources } from "./coin-symbols";
import { createCollectionEffects } from "./effects";
import { createCabinet, updateFeedTrays } from "./scene";
import { createCaseStickers } from "./stickers";

const MIN_CHUTE_X = -MACHINE_GEOMETRY.aimHalfWidth;
const MAX_CHUTE_X = MACHINE_GEOMETRY.aimHalfWidth;

function clampChute(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_CHUTE_X, Math.max(MIN_CHUTE_X, value));
}

export async function createPresentation(host: HTMLElement): Promise<Presentation> {
  const cabinetAsset = await loadCabinetAsset();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x211713);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(
    Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
  );
  renderer.setClearColor(0x211713, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.domElement.setAttribute("aria-label", "Critpusher arcade machine");
  renderer.domElement.style.display = "block";
  host.appendChild(renderer.domElement);

  const ambient = new THREE.HemisphereLight(0xf9d8a0, 0x301c19, 1.5);
  scene.add(ambient);
  const keyLight = new THREE.DirectionalLight(0xffe2b6, 2.7);
  keyLight.position.set(-4, 9, 10);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0x8eb0ac, 0.8);
  fillLight.position.set(5, 4, -8);
  scene.add(fillLight);

  let shelfFront = DEFAULT_TUNING.shelfFront;
  let radius = DEFAULT_TUNING.radius;
  let dropHeight = DEFAULT_TUNING.dropHeight;
  let thickness = DEFAULT_TUNING.thickness;
  const symbolResources = createCoinSymbolResources();
  let cabinet = createCabinet(shelfFront, symbolResources, cabinetAsset);
  scene.add(cabinet.root);
  const coins = createCoinRenderer(scene, symbolResources);
  const effects = createCollectionEffects(scene);
  const stickers = createCaseStickers();
  stickers.bind(cabinet.root);
  const bell = cabinetAsset.instantiate("combo_bell");
  bell.name = "physical-combo-bell";
  bell.visible = false;
  const bellBounds = new THREE.Box3().setFromObject(bell);
  const bellRadius = Math.max(bellBounds.max.x - bellBounds.min.x, bellBounds.max.z - bellBounds.min.z) / 2;
  scene.add(bell);
  const updateBell = ({ position, rotation, radius }: GizmoView) => {
    bell.visible = true;
    bell.position.set(position.x, position.y, position.z);
    bell.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    bell.scale.setScalar(radius / bellRadius);
  };
  const raycaster = new THREE.Raycaster();
  const chutePlane = new THREE.Plane(
    new THREE.Vector3(0, 0, 1),
    -PLAYER_DROP_Z,
  );
  const hit = new THREE.Vector3();
  const pointerNdc = new THREE.Vector2();
  const resizeObserver =
    typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(() => resize())
      : null;
  let disposed = false;

  function disposeCabinet(): void {
    scene.remove(cabinet.root);
    cabinet.stockBodies.dispose();
    cabinet.stockRims.dispose();
    for (const symbol of Object.values(cabinet.stockSymbols)) {
      for (const mesh of symbol.meshes) mesh.dispose();
    }
    for (const geometry of cabinet.resources.geometries) geometry.dispose();
    for (const material of cabinet.resources.materials) material.dispose();
  }


  function resize(): void {
    if (disposed) return;
    const bounds = host.getBoundingClientRect();
    const width = Math.max(
      1,
      Math.floor(bounds.width || host.clientWidth || 1),
    );
    const height = Math.max(
      1,
      Math.floor(bounds.height || host.clientHeight || 1),
    );
    renderer.setSize(width, height, false);
    fitMachineCamera(camera, width, height, radius, dropHeight, shelfFront, thickness, cabinetAsset.bounds);
    // Resizing clears the drawing buffer even while the simulation is paused.
    renderer.render(scene, camera);
  }

  function pointerToChute(clientX: number, clientY: number): number {
    if (disposed) return 0;
    const bounds = renderer.domElement.getBoundingClientRect();
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    pointerNdc.set(
      ((clientX - bounds.left) / width) * 2 - 1,
      -((clientY - bounds.top) / height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    if (!raycaster.ray.intersectPlane(chutePlane, hit)) return 0;
    return clampChute(hit.x);
  }

  function render(
    simulation: Simulation,
    dt: number,
    reducedMotion: boolean,
    trays: readonly FeedTray[],
  ): void {
    if (disposed) return;
    let cameraChanged = false;
    if (simulation.tuning.shelfFront !== shelfFront) {
      disposeCabinet();
      shelfFront = simulation.tuning.shelfFront;
      cabinet = createCabinet(shelfFront, symbolResources, cabinetAsset);
      scene.add(cabinet.root);
      stickers.bind(cabinet.root);
      cameraChanged = true;
    }
    const nextRadius = Number.isFinite(simulation.tuning.radius)
      ? simulation.tuning.radius
      : DEFAULT_TUNING.radius;
    const nextDropHeight = Number.isFinite(simulation.tuning.dropHeight)
      ? simulation.tuning.dropHeight
      : DEFAULT_TUNING.dropHeight;
    const nextThickness = Number.isFinite(simulation.tuning.thickness)
      ? simulation.tuning.thickness
      : DEFAULT_TUNING.thickness;
    cameraChanged = cameraChanged || nextRadius !== radius || nextDropHeight !== dropHeight || nextThickness !== thickness;
    radius = nextRadius;
    dropHeight = nextDropHeight;
    thickness = nextThickness;
    if (cameraChanged) {
      const bounds = host.getBoundingClientRect();
      fitMachineCamera(
        camera,
        Math.max(1, Math.floor(bounds.width || host.clientWidth || 1)),
        Math.max(1, Math.floor(bounds.height || host.clientHeight || 1)),
        radius,
        dropHeight,
        shelfFront,
        thickness,
        cabinetAsset.bounds,
      );
    }
    updateFeedTrays(cabinet, trays, radius, thickness, dropHeight);
    cabinet.pusher.position.z = simulation.stats().pusherZ;
    coins.update(simulation);
    bell.visible = false;
    simulation.gizmos.forEach(updateBell);
    effects.update(dt, reducedMotion, shelfFront);
    renderer.render(scene, camera);
  }

  function collect(
    events: readonly CoinEvent[],
    reducedMotion: boolean,
    combat?: CombatStepResult,
  ): void {
    if (disposed) return;
    effects.collect(events, reducedMotion, combat);
  }

  resizeObserver?.observe(host);
  if (!resizeObserver) window.addEventListener("resize", resize);
  resize();

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    resizeObserver?.disconnect();
    if (!resizeObserver) window.removeEventListener("resize", resize);
    coins.dispose();
    effects.dispose();
    stickers.dispose();
    scene.remove(bell);
    disposeCabinet();
    symbolResources.dispose();
    cabinetAsset.dispose();
    renderer.dispose();
    if (renderer.domElement.parentElement === host)
      host.removeChild(renderer.domElement);
  }

  return {
    canvas: renderer.domElement,
    render,
    collect,
    clearEffects: effects.reset,
    setStickers: stickers.set,
    markTargets: coins.markTargets,
    pointerToChute,
    resize,
    dispose,
  };
}
