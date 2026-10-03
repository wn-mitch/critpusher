import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { FeedTray } from "../src/combat/types";
import { COIN_TYPES, type CoinType, type CoinView } from "../src/contracts";
import {
  FEED_TRAY_ROTATION,
  getFeedTrayGeometry,
} from "../src/feed-geometry";
import { fitMachineCamera } from "../src/presentation/camera";
import { createCoinSymbolResources } from "../src/presentation/coin-symbols";
import { createObservationCabinet, updateFeedTrays } from "../src/presentation/scene";
import { DEFAULT_TUNING, PLAYER_DROP_Z } from "../src/simulation/config";
import { MACHINE_GEOMETRY } from "../src/machine-geometry";
import { createSimulation, classifyCoinPosition } from "../src/simulation";
import type { RapierWorld } from "../src/simulation/rapier-world";

const viewports = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
];
const tunings = [
  DEFAULT_TUNING,
  ...[0.05, 0.75].flatMap((radius) =>
    [0.02, 0.4].flatMap((thickness) =>
      [1.5, 8].map((dropHeight) => ({ radius, thickness, dropHeight })),
    ),
  ),
];
const capSamples = [[0, 0], [-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]] as const;
const trayRotation = new THREE.Quaternion(
  FEED_TRAY_ROTATION.x,
  FEED_TRAY_ROTATION.y,
  FEED_TRAY_ROTATION.z,
  FEED_TRAY_ROTATION.w,
);

function makeFeedTray(
  x: number,
  trayIndex: number,
  radius: number,
  thickness: number,
  dropHeight: number,
): FeedTray {
  const geometry = getFeedTrayGeometry(radius, thickness, dropHeight);
  const types = Array.from({ length: 5 }, (_, slot) => COIN_TYPES[(slot + trayIndex) % COIN_TYPES.length]!);
  const anchor = new THREE.Vector3(x, dropHeight, PLAYER_DROP_Z);
  const coins: CoinView[] = types.map((type, slot) => {
    const position = anchor.clone().add(new THREE.Vector3(0, 0, -slot * geometry.spacing).applyQuaternion(trayRotation));
    return {
      id: -(trayIndex * 10 + slot + 1),
      type,
      bombHits: 0,
      position,
      rotation: {
        x: trayRotation.x,
        y: trayRotation.y,
        z: trayRotation.z,
        w: trayRotation.w,
      },
      radius,
      thickness,
    };
  });
  return {
    x,
    id: `chute-${trayIndex}`,
    ownerId: `owner-${trayIndex}`,
    enabled: true,
    slot: [0, 1, -1, -2, 2, -3][trayIndex]!,
    source: trayIndex < 3 ? "player" : "enemy",
    preview: types,
    coins,
    gateOpen: false,
    burst: { phase: "idle", cohort: [], trapRetracted: false },
  };
}

function expectInFrame(point: THREE.Vector3, camera: THREE.PerspectiveCamera): void {
  const projected = point.clone().project(camera);
  expect(Math.abs(projected.x)).toBeLessThan(1);
  expect(Math.abs(projected.y)).toBeLessThan(1);
  expect(Math.abs(projected.z)).toBeLessThan(1);
}

describe("camera-facing feed trays", () => {
  it.each(viewports)("keeps every cap and next marker readable at $width × $height", ({ width, height }) => {
    const symbols = createCoinSymbolResources();
    const cabinet = createObservationCabinet(DEFAULT_TUNING.shelfFront, symbols);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    const raycaster = new THREE.Raycaster();
    const matrix = new THREE.Matrix4();
    const point = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const normal = new THREE.Vector3();
    try {
      for (const { radius, thickness, dropHeight } of tunings) {
        const trayEdge = Math.min(MACHINE_GEOMETRY.aimHalfWidth, MACHINE_GEOMETRY.innerHalfWidth - radius - 0.02);
        const trayXs = Array.from({ length: 6 }, (_, index) => -trayEdge + index * 2 * trayEdge / 5);
        const tunedTrays = trayXs.map((x, trayIndex) =>
          makeFeedTray(x, trayIndex, radius, thickness, dropHeight),
        );
        updateFeedTrays(cabinet, tunedTrays, radius, thickness, dropHeight);
        fitMachineCamera(camera, width, height, radius, dropHeight, DEFAULT_TUNING.shelfFront, thickness);
        camera.updateMatrixWorld(true);
        cabinet.root.updateMatrixWorld(true);
        const overlays = new Set<THREE.Object3D>([
          cabinet.stockRims,
          ...COIN_TYPES.flatMap((type) => cabinet.stockSymbols[type].meshes),
        ]);
        const capOccluders: THREE.Object3D[] = [];
        const allOccluders: THREE.Object3D[] = [];
        cabinet.root.traverseVisible((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          if (materials.every((material) => material.transparent && material.opacity < 0.5)) return;
          allOccluders.push(object);
          if (!overlays.has(object)) capOccluders.push(object);
          if (object instanceof THREE.InstancedMesh) object.computeBoundingSphere();
        });

        const typeCounts = Object.fromEntries(COIN_TYPES.map((type) => [type, 0])) as Record<CoinType, number>;
        let instance = 0;
        const capInset = Math.max(0, 1 - 0.003 / radius);
        for (let trayIndex = 0; trayIndex < tunedTrays.length; trayIndex += 1) {
          const tray = tunedTrays[trayIndex]!;
          for (let slot = 0; slot < tray.coins.length; slot += 1) {
            const coin = tray.coins[slot]!;
            cabinet.stockBodies.getMatrixAt(instance, matrix);
            const center = new THREE.Vector3().setFromMatrixPosition(matrix);
            const scale = new THREE.Vector3().setFromMatrixScale(matrix);
            const cap = new THREE.Vector3(0, 0.5, 0).applyMatrix4(matrix);
            normal.set(0, 1, 0).transformDirection(matrix);
            direction.copy(camera.position).sub(cap).normalize();
            expect(normal.dot(direction)).toBeGreaterThan(0);
            expect(center.x).toBeCloseTo(coin.position.x);
            expect(center.y).toBeCloseTo(coin.position.y);
            expect(center.z).toBeCloseTo(coin.position.z);
            expect(scale.x).toBeCloseTo(radius);
            expect(scale.y).toBeCloseTo(thickness);
            expect(scale.z).toBeCloseTo(radius);
            for (const [x, z] of [[-0.5, 0], [0.5, 0], [0, -0.5], [0, 0.5]]) {
              expectInFrame(point.set(x, 0.5, z).applyMatrix4(matrix), camera);
            }
            let clearCapRays = 0;
            for (const [x, z] of capSamples) {
              point.set(x * capInset, 0.5, z * capInset).applyMatrix4(matrix);
              direction.copy(point).sub(camera.position).normalize();
              raycaster.set(camera.position, direction);
              const first = raycaster.intersectObjects(capOccluders, false)[0];
              if (
                first?.object === cabinet.stockBodies &&
                first.instanceId === instance &&
                (first.face?.normal.y ?? 0) > 0.99
              ) clearCapRays += 1;
            }
            expect(clearCapRays).toBeGreaterThanOrEqual(3);

            const inverseBody = matrix.clone().invert();
            const symbolIndex = typeCounts[coin.type]++;
            for (const mesh of cabinet.stockSymbols[coin.type].meshes) {
              mesh.getMatrixAt(symbolIndex, matrix);
              const localSymbol = new THREE.Vector3().setFromMatrixPosition(matrix).applyMatrix4(inverseBody);
              expect(localSymbol.x).toBeCloseTo(0);
              expect(localSymbol.z).toBeCloseTo(0);
              expect(localSymbol.y).toBeGreaterThan(0.5);
              expect(localSymbol.y).toBeLessThan(0.5 + 0.01 / thickness);
              expect(new THREE.Vector3(0, 1, 0).transformDirection(matrix).dot(normal)).toBeCloseTo(1);
            }
            cabinet.stockRims.getMatrixAt(instance, matrix);
            const localRim = new THREE.Vector3().setFromMatrixPosition(matrix).applyMatrix4(inverseBody);
            expect(localRim.x).toBeCloseTo(0);
            expect(localRim.z).toBeCloseTo(0);
            expect(localRim.y).toBeCloseTo(0.5 + 0.003 / thickness);
            instance += 1;
          }
          const visual = cabinet.trays[trayIndex]!;
          visual.arrow.getWorldPosition(point);
          expectInFrame(point, camera);
          direction.copy(point).sub(camera.position).normalize();
          raycaster.set(camera.position, direction);
          expect(raycaster.intersectObjects(allOccluders, false)[0]?.object).toBe(visual.arrow);
          const vertices = visual.arrow.geometry.getAttribute("position");
          for (let vertex = 0; vertex < vertices.count; vertex += 1) {
            expectInFrame(point.fromBufferAttribute(vertices, vertex).applyMatrix4(visual.arrow.matrixWorld), camera);
          }
        }
        expect(cabinet.stockOrder).toEqual(tunedTrays.flatMap((tray) => tray.coins));
      }
    } finally {
      for (const geometry of cabinet.resources.geometries) geometry.dispose();
      for (const material of cabinet.resources.materials) material.dispose();
      cabinet.root.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
      });
      symbols.dispose();
    }
  });
  it("shutters a disabled lane without hiding it or dropping surviving stock", () => {
    const symbols = createCoinSymbolResources();
    const cabinet = createObservationCabinet(DEFAULT_TUNING.shelfFront, symbols);
    const { radius, thickness, dropHeight } = DEFAULT_TUNING;
    const trays = Array.from({ length: 6 }, (_, index) =>
      makeFeedTray((index - 2.5) * 0.8, index, radius, thickness, dropHeight),
    );
    try {
      updateFeedTrays(cabinet, trays, radius, thickness, dropHeight);
      const disabled = trays.map((tray, index) => index === 4
        ? { ...tray, enabled: false, preview: [], coins: [], gateOpen: false }
        : { ...tray, gateOpen: true });
      updateFeedTrays(cabinet, disabled, radius, thickness, dropHeight);
      const shuttered = cabinet.trays[4]!;
      expect(shuttered.root.visible).toBe(true);
      expect(shuttered.root.position.x).toBe(trays[4]!.x);
      expect(shuttered.frontStop.visible).toBe(true);
      expect(shuttered.trapdoor.visible).toBe(true);
      expect(shuttered.arrow.visible).toBe(false);
      const open = cabinet.trays[5]!;
      expect(open.frontStop.visible).toBe(true);
      expect(open.trapdoor.visible).toBe(true);
      expect(open.frontStop.position.y).toBeLessThan(shuttered.frontStop.position.y);
      expect(open.trapdoor.position.y).toBeLessThan(shuttered.trapdoor.position.y);
      const survivingStock = disabled.flatMap((tray) => tray.coins);
      expect(cabinet.stockOrder).toEqual(survivingStock);
      expect(cabinet.stockBodies.count).toBe(survivingStock.length);
      expect(cabinet.stockRims.count).toBe(survivingStock.length);
      expect(() => updateFeedTrays(cabinet, [...trays, trays[0]!], radius, thickness, dropHeight)).toThrow(RangeError);
      expect(cabinet.stockOrder).toEqual(survivingStock);
      const oversizedStock = [{ ...trays[0]!, coins: [...trays.flatMap((tray) => tray.coins), trays[0]!.coins[0]!] }];
      expect(() => updateFeedTrays(cabinet, oversizedStock, radius, thickness, dropHeight)).toThrow(RangeError);
      expect(cabinet.stockOrder).toEqual(survivingStock);
    } finally {
      for (const geometry of cabinet.resources.geometries) geometry.dispose();
      for (const material of cabinet.resources.materials) material.dispose();
      cabinet.root.traverse((object) => {
        if (object instanceof THREE.InstancedMesh) object.dispose();
      });
      symbols.dispose();
    }
  });
});

describe("shared physical cabinet boundaries", () => {
  it.each([
    { radius: 0.32, thickness: 0.13 },
    { radius: 0.24, thickness: 0.0975 },
  ])("keeps $radius-radius coins clear of the shelf, pusher and walls", async ({ radius, thickness }) => {
    const simulation = await createSimulation({ density: 0, radius, thickness });
    const { world } = simulation as unknown as { world: RapierWorld };
    try {
      simulation.step();
      const gap = 0.01;
      const canFit = (x: number, y: number, z: number) =>
        world.canAddCylinders([{ x, y, z }], radius, thickness);
      const shelfContactY = MACHINE_GEOMETRY.shelfTop + thickness / 2;
      expect(canFit(0, shelfContactY + gap, 2)).toBe(true);
      expect(canFit(0, shelfContactY - gap, 2)).toBe(false);
      const pusherContactY = MACHINE_GEOMETRY.pusherTop + thickness / 2;
      expect(canFit(0, pusherContactY + gap, MACHINE_GEOMETRY.pusherRearZ)).toBe(true);
      expect(canFit(0, pusherContactY - gap, MACHINE_GEOMETRY.pusherRearZ)).toBe(false);
      for (const side of [-1, 1]) {
        expect(canFit(side * (MACHINE_GEOMETRY.innerHalfWidth - radius - gap), 2, 0)).toBe(true);
        expect(canFit(side * (MACHINE_GEOMETRY.innerHalfWidth - radius + gap), 2, 0)).toBe(false);
      }
      expect(canFit(0, 2, MACHINE_GEOMETRY.innerRearZ + radius + gap)).toBe(true);
      expect(canFit(0, 2, MACHINE_GEOMETRY.innerRearZ + radius - gap)).toBe(false);
      const front = simulation.tuning.shelfFront;
      expect(classifyCoinPosition({ x: 0, y: MACHINE_GEOMETRY.collectionY + gap, z: front + gap }, front)).toBeUndefined();
      expect(classifyCoinPosition({ x: 0, y: MACHINE_GEOMETRY.collectionY - gap, z: front + gap }, front)).toBe("collected");
      expect(classifyCoinPosition({ x: 0, y: MACHINE_GEOMETRY.collectionY - gap, z: front - gap }, front)).toBe("lost");
    } finally {
      simulation.dispose();
    }
  });
});
