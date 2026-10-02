import * as THREE from "three";
import type { CoinFaction, CoinView, Simulation } from "../contracts";

export interface CoinRenderer {
  update(simulation: Simulation): void;
  markTargets(targets: ReadonlyMap<number, number>): void;
  dispose(): void;
}

interface MeshSet {
  body: THREE.InstancedMesh;
  rim: THREE.InstancedMesh;
  hub: THREE.InstancedMesh;
  stamp: THREE.InstancedMesh;
  targetRim: THREE.InstancedMesh;
  targetHub: THREE.InstancedMesh;
  targetBar: THREE.InstancedMesh;
}

const DETAIL_THICKNESS = 0.004;
const DETAIL_CENTER_OFFSET = DETAIL_THICKNESS * 0.5;
const RIM_DETAIL_SCALE = DETAIL_THICKNESS / 0.15;
const HUB_DETAIL_SCALE = DETAIL_THICKNESS / 0.075;
const STAMP_DETAIL_SCALE = DETAIL_THICKNESS / 0.06;
const TARGET_FACE_OFFSET = DETAIL_THICKNESS * 1.5;
const TARGET_BAR_OFFSET = TARGET_FACE_OFFSET + DETAIL_THICKNESS;
const TARGET_BAR_SPACING = 0.16;
const TARGET_COLORS = [
  new THREE.Color(0x2eeeff),
  new THREE.Color(0xfff4d6),
  new THREE.Color(0xff49c8),
] as const;

const FACTION_COLORS: Record<
  CoinFaction,
  { body: THREE.Color; face: THREE.Color; stamp: THREE.Color }
> = {
  ally: {
    body: new THREE.Color(0xb67b32),
    face: new THREE.Color(0xe1b763),
    stamp: new THREE.Color(0xf0d487),
  },
  enemy: {
    body: new THREE.Color(0xb94a3b),
    face: new THREE.Color(0xe06a45),
    stamp: new THREE.Color(0xf08a5b),
  },
  dud: {
    body: new THREE.Color(0x62676b),
    face: new THREE.Color(0x92999e),
    stamp: new THREE.Color(0xbfc5c9),
  },
};

export function createCoinRenderer(root: THREE.Object3D): CoinRenderer {
  const bodyGeometry = new THREE.CylinderGeometry(1, 1, 1, 32);
  const rimGeometry = new THREE.TorusGeometry(0.79, 0.075, 7, 28);
  rimGeometry.rotateX(Math.PI / 2);
  const hubGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.075, 16);
  const stampGeometry = new THREE.BoxGeometry(0.44, 0.06, 0.075);
  const targetBarGeometry = new THREE.BoxGeometry(0.5, 0.06, 0.075);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.34,
    metalness: 0.78,
  });
  const faceMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.27,
    metalness: 0.84,
  });
  const stampMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.24,
    metalness: 0.86,
  });
  const targetMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });
  let active: MeshSet | null = null;
  let capacity = 0;
  let disposed = false;
  let targetLanes = new Map<number, number>();

  const createMesh = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    size: number,
  ) => {
    const mesh = new THREE.InstancedMesh(geometry, material, size);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  };

  function grow(requiredCoins: number): void {
    if (requiredCoins <= capacity) return;
    let next = Math.max(64, capacity || 1);
    while (next < requiredCoins) next *= 2;
    const previous = active;
    active = {
      body: createMesh(bodyGeometry, bodyMaterial, next),
      rim: createMesh(rimGeometry, faceMaterial, next * 2),
      hub: createMesh(hubGeometry, faceMaterial, next * 2),
      stamp: createMesh(stampGeometry, stampMaterial, next * 4),
      targetRim: createMesh(rimGeometry, targetMaterial, next * 2),
      targetHub: createMesh(hubGeometry, targetMaterial, next * 2),
      targetBar: createMesh(targetBarGeometry, targetMaterial, next * 6),
    };
    capacity = next;
    if (previous) {
      root.remove(
        previous.body,
        previous.rim,
        previous.hub,
        previous.stamp,
        previous.targetRim,
        previous.targetHub,
        previous.targetBar,
      );
      previous.body.dispose();
      previous.rim.dispose();
      previous.hub.dispose();
      previous.stamp.dispose();
      previous.targetRim.dispose();
      previous.targetHub.dispose();
      previous.targetBar.dispose();
    }
  }

  const position = new THREE.Vector3();
  const facePosition = new THREE.Vector3();
  const normal = new THREE.Vector3(0, 1, 0);
  const scale = new THREE.Vector3();
  const faceScale = new THREE.Vector3();
  const barOffset = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const verticalQuaternion = new THREE.Quaternion();
  const yHalfTurn = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI / 2,
  );
  const bodyMatrix = new THREE.Matrix4();
  const faceMatrix = new THREE.Matrix4();
  const stampMatrix = new THREE.Matrix4();

  function setFaceMatrix(
    matrix: THREE.Matrix4,
    coin: CoinView,
    offset: number,
    yScale: number,
    rotation = quaternion,
  ): void {
    facePosition.copy(position).addScaledVector(normal, offset);
    faceScale.set(coin.radius, yScale, coin.radius);
    matrix.compose(facePosition, rotation, faceScale);
  }

  function setTargetBarMatrix(
    coin: CoinView,
    offset: number,
    barIndex: number,
    barCount: number,
  ): void {
    facePosition.copy(position).addScaledVector(normal, offset);
    barOffset
      .set(
        0,
        0,
        (barIndex - (barCount - 1) * 0.5) * TARGET_BAR_SPACING * coin.radius,
      )
      .applyQuaternion(quaternion);
    facePosition.add(barOffset);
    faceScale.set(coin.radius, STAMP_DETAIL_SCALE, coin.radius);
    stampMatrix.compose(facePosition, quaternion, faceScale);
  }

  function markTargets(targets: ReadonlyMap<number, number>): void {
    if (disposed) return;
    const nextTargets = new Map<number, number>();
    for (const [id, lane] of targets) {
      if (Number.isInteger(lane) && lane >= 0 && lane < TARGET_COLORS.length) {
        nextTargets.set(id, lane);
      }
    }
    targetLanes = nextTargets;
  }

  function update(simulation: Simulation): void {
    if (disposed) return;
    for (const id of targetLanes.keys()) {
      if (!simulation.coins.has(id)) targetLanes.delete(id);
    }
    grow(simulation.coins.size);
    if (!active) return;
    const { body, rim, hub, stamp, targetRim, targetHub, targetBar } = active;
    let index = 0;
    let targetIndex = 0;
    let targetBarIndex = 0;
    for (const coin of simulation.coins.values()) {
      position.set(coin.position.x, coin.position.y, coin.position.z);
      quaternion.set(
        coin.rotation.x,
        coin.rotation.y,
        coin.rotation.z,
        coin.rotation.w,
      );
      scale.set(coin.radius, coin.thickness, coin.radius);
      bodyMatrix.compose(position, quaternion, scale);
      body.setMatrixAt(index, bodyMatrix);
      const colors = FACTION_COLORS[coin.faction];
      body.setColorAt(index, colors.body);
      rim.setColorAt(index * 2, colors.face);
      rim.setColorAt(index * 2 + 1, colors.face);
      hub.setColorAt(index * 2, colors.face);
      hub.setColorAt(index * 2 + 1, colors.face);
      for (let detail = 0; detail < 4; detail += 1) {
        stamp.setColorAt(index * 4 + detail, colors.stamp);
      }

      normal.set(0, 1, 0).applyQuaternion(quaternion);
      const faceOffset = coin.thickness * 0.5 + DETAIL_CENTER_OFFSET;
      setFaceMatrix(faceMatrix, coin, faceOffset, RIM_DETAIL_SCALE);
      rim.setMatrixAt(index * 2, faceMatrix);
      setFaceMatrix(faceMatrix, coin, -faceOffset, RIM_DETAIL_SCALE);
      rim.setMatrixAt(index * 2 + 1, faceMatrix);

      setFaceMatrix(faceMatrix, coin, faceOffset, HUB_DETAIL_SCALE);
      hub.setMatrixAt(index * 2, faceMatrix);
      setFaceMatrix(faceMatrix, coin, -faceOffset, HUB_DETAIL_SCALE);
      hub.setMatrixAt(index * 2 + 1, faceMatrix);

      verticalQuaternion.copy(quaternion).multiply(yHalfTurn);
      setFaceMatrix(stampMatrix, coin, faceOffset, STAMP_DETAIL_SCALE);
      stamp.setMatrixAt(index * 4, stampMatrix);
      setFaceMatrix(stampMatrix, coin, -faceOffset, STAMP_DETAIL_SCALE);
      stamp.setMatrixAt(index * 4 + 1, stampMatrix);
      setFaceMatrix(
        stampMatrix,
        coin,
        faceOffset,
        STAMP_DETAIL_SCALE,
        verticalQuaternion,
      );
      stamp.setMatrixAt(index * 4 + 2, stampMatrix);
      setFaceMatrix(
        stampMatrix,
        coin,
        -faceOffset,
        STAMP_DETAIL_SCALE,
        verticalQuaternion,
      );
      stamp.setMatrixAt(index * 4 + 3, stampMatrix);

      const lane = targetLanes.get(coin.id);
      if (lane !== undefined) {
        const color = TARGET_COLORS[lane]!;
        const targetFaceOffset = faceOffset + TARGET_FACE_OFFSET;
        setFaceMatrix(faceMatrix, coin, targetFaceOffset, RIM_DETAIL_SCALE);
        targetRim.setMatrixAt(targetIndex * 2, faceMatrix);
        targetRim.setColorAt(targetIndex * 2, color);
        setFaceMatrix(faceMatrix, coin, -targetFaceOffset, RIM_DETAIL_SCALE);
        targetRim.setMatrixAt(targetIndex * 2 + 1, faceMatrix);
        targetRim.setColorAt(targetIndex * 2 + 1, color);

        setFaceMatrix(faceMatrix, coin, targetFaceOffset, HUB_DETAIL_SCALE);
        targetHub.setMatrixAt(targetIndex * 2, faceMatrix);
        targetHub.setColorAt(targetIndex * 2, color);
        setFaceMatrix(faceMatrix, coin, -targetFaceOffset, HUB_DETAIL_SCALE);
        targetHub.setMatrixAt(targetIndex * 2 + 1, faceMatrix);
        targetHub.setColorAt(targetIndex * 2 + 1, color);

        const barCount = lane + 1;
        const targetBarFaceOffset = faceOffset + TARGET_BAR_OFFSET;
        for (let bar = 0; bar < barCount; bar += 1) {
          setTargetBarMatrix(coin, targetBarFaceOffset, bar, barCount);
          targetBar.setMatrixAt(targetBarIndex, stampMatrix);
          targetBar.setColorAt(targetBarIndex, color);
          targetBarIndex += 1;
          setTargetBarMatrix(coin, -targetBarFaceOffset, bar, barCount);
          targetBar.setMatrixAt(targetBarIndex, stampMatrix);
          targetBar.setColorAt(targetBarIndex, color);
          targetBarIndex += 1;
        }
        targetIndex += 1;
      }
      index += 1;
    }
    body.count = index;
    rim.count = index * 2;
    hub.count = index * 2;
    stamp.count = index * 4;
    targetRim.count = targetIndex * 2;
    targetHub.count = targetIndex * 2;
    targetBar.count = targetBarIndex;
    body.instanceMatrix.needsUpdate = true;
    rim.instanceMatrix.needsUpdate = true;
    hub.instanceMatrix.needsUpdate = true;
    stamp.instanceMatrix.needsUpdate = true;
    targetRim.instanceMatrix.needsUpdate = true;
    targetHub.instanceMatrix.needsUpdate = true;
    targetBar.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (rim.instanceColor) rim.instanceColor.needsUpdate = true;
    if (hub.instanceColor) hub.instanceColor.needsUpdate = true;
    if (stamp.instanceColor) stamp.instanceColor.needsUpdate = true;
    if (targetRim.instanceColor) targetRim.instanceColor.needsUpdate = true;
    if (targetHub.instanceColor) targetHub.instanceColor.needsUpdate = true;
    if (targetBar.instanceColor) targetBar.instanceColor.needsUpdate = true;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    targetLanes.clear();
    if (active) {
      root.remove(
        active.body,
        active.rim,
        active.hub,
        active.stamp,
        active.targetRim,
        active.targetHub,
        active.targetBar,
      );
      active.body.dispose();
      active.rim.dispose();
      active.hub.dispose();
      active.stamp.dispose();
      active.targetRim.dispose();
      active.targetHub.dispose();
      active.targetBar.dispose();
    }
    bodyGeometry.dispose();
    rimGeometry.dispose();
    hubGeometry.dispose();
    stampGeometry.dispose();
    targetBarGeometry.dispose();
    bodyMaterial.dispose();
    faceMaterial.dispose();
    stampMaterial.dispose();
    targetMaterial.dispose();
  }

  return { update, markTargets, dispose };
}
