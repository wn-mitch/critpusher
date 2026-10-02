import * as THREE from "three";
import type { CollectionEvent, Presentation, Simulation } from "../contracts";
import { DEFAULT_TUNING, PLAYER_DROP_Z } from "../simulation/config";
import type { ChuteDrop } from "../chutes";
import { createCoinRenderer } from "./coins";
import { createCollectionEffects } from "./effects";
import { createCabinet, updateChuteGuides } from "./scene";

const MIN_CHUTE_X = -4.4;
const MAX_CHUTE_X = 4.4;
const DEFAULT_DROP_HEIGHT = 3.5;

function clampChute(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_CHUTE_X, Math.max(MIN_CHUTE_X, value));
}

export function createPresentation(host: HTMLElement): Presentation {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x211713);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  const target = new THREE.Vector3(0, 0.45, 0.25);
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
  let cabinet = createCabinet(shelfFront);
  scene.add(cabinet.root);
  const coins = createCoinRenderer(scene);
  const effects = createCollectionEffects(scene);
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
  let dropHeight = DEFAULT_DROP_HEIGHT;
  let disposed = false;

  function disposeCabinet(): void {
    scene.remove(cabinet.root);
    for (const geometry of cabinet.resources.geometries) geometry.dispose();
    for (const material of cabinet.resources.materials) material.dispose();
  }

  function fitCamera(width: number, height: number): void {
    const aspect = width / Math.max(1, height);
    const portrait = aspect < 1;
    camera.aspect = aspect;
    camera.fov = portrait ? 50 : 42;

    const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
    const elevation = THREE.MathUtils.degToRad(portrait ? 31 : 29);
    const elevationSin = Math.sin(elevation);
    const elevationCos = Math.cos(elevation);
    const halfWidth = portrait ? 5.35 : 6.15;
    const padding = 1.04;
    let distance = 0;

    for (let corner = 0; corner < 4; corner += 1) {
      const y = (corner & 1) === 0 ? -1.6 : 4.5;
      const z = (corner & 2) === 0 ? -4.2 : 5.6;
      const relativeY = y - target.y;
      const relativeZ = z - target.z;
      const depthOffset = relativeY * elevationSin + relativeZ * elevationCos;
      const projectedY = Math.abs(
        relativeY * elevationCos - relativeZ * elevationSin,
      );
      const widthDistance =
        depthOffset + (halfWidth * padding) / (tangent * aspect);
      const heightDistance = depthOffset + (projectedY * padding) / tangent;
      distance = Math.max(distance, widthDistance, heightDistance);
    }

    camera.position.set(
      0,
      target.y + distance * elevationSin,
      target.z + distance * elevationCos,
    );
    camera.lookAt(target);
    camera.updateProjectionMatrix();
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
    fitCamera(width, height);
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
    chutes: readonly ChuteDrop[],
  ): void {
    if (disposed) return;
    if (simulation.tuning.shelfFront !== shelfFront) {
      disposeCabinet();
      shelfFront = simulation.tuning.shelfFront;
      cabinet = createCabinet(shelfFront);
      scene.add(cabinet.root);
    }
    dropHeight = Number.isFinite(simulation.tuning.dropHeight)
      ? simulation.tuning.dropHeight
      : DEFAULT_DROP_HEIGHT;
    updateChuteGuides(
      cabinet,
      chutes,
      simulation.tuning.radius,
      simulation.tuning.thickness,
      dropHeight,
    );
    cabinet.pusher.position.z = simulation.stats().pusherZ;
    coins.update(simulation);
    effects.update(dt, reducedMotion);
    renderer.render(scene, camera);
  }

  function collect(events: CollectionEvent[], reducedMotion: boolean): void {
    if (disposed) return;
    effects.collect(events, reducedMotion);
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
    disposeCabinet();
    renderer.dispose();
    if (renderer.domElement.parentElement === host)
      host.removeChild(renderer.domElement);
  }

  return {
    canvas: renderer.domElement,
    render,
    collect,
    markTargets: coins.markTargets,
    pointerToChute,
    resize,
    dispose,
  };
}
