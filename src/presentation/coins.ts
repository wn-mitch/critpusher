import * as THREE from "three";
import { COIN_TYPES, type CoinType, type CoinView, type Simulation } from "../contracts";
import { COIN_SYMBOL_PALETTE, type CoinSymbolResources } from "./coin-symbols";

export interface CoinRenderer {
  update(simulation: Simulation): void;
  markTargets(targets: ReadonlyMap<number, number>): void;
  dispose(): void;
}

interface SymbolMeshSet {
  readonly meshes: readonly THREE.InstancedMesh[];
  count: number;
}

interface MeshSet {
  body: THREE.InstancedMesh;
  rim: THREE.InstancedMesh;
  symbols: Record<CoinType, SymbolMeshSet>;
  filledPips: THREE.InstancedMesh;
  emptyPips: THREE.InstancedMesh;
  armedRing: THREE.InstancedMesh;
  targetRim: THREE.InstancedMesh;
  targetHub: THREE.InstancedMesh;
  targetBar: THREE.InstancedMesh;
}

const DETAIL_THICKNESS = 0.004;
const DETAIL_CENTER_OFFSET = DETAIL_THICKNESS * 0.5;
const RIM_DETAIL_SCALE = DETAIL_THICKNESS / 0.15;
const TARGET_FACE_OFFSET = DETAIL_THICKNESS * 1.5;
const TARGET_BAR_OFFSET = TARGET_FACE_OFFSET + DETAIL_THICKNESS;
const TARGET_BAR_SPACING = 0.16;
const MAX_BOMB_PIPS = 10;
const TARGET_COLORS = [
  new THREE.Color(0x2eeeff),
  new THREE.Color(0xfff4d6),
  new THREE.Color(0xff49c8),
] as const;
const TYPE_COLORS = Object.fromEntries(
  COIN_TYPES.map((type) => [
    type,
    {
      body: new THREE.Color(COIN_SYMBOL_PALETTE[type].body),
      face: new THREE.Color(COIN_SYMBOL_PALETTE[type].face),
    },
  ]),
) as Record<CoinType, { body: THREE.Color; face: THREE.Color }>;

export function createCoinRenderer(root: THREE.Object3D, symbolResources: CoinSymbolResources): CoinRenderer {
  const bodyGeometry = new THREE.CylinderGeometry(1, 1, 1, 32);
  const rimGeometry = new THREE.TorusGeometry(0.79, 0.075, 7, 28);
  rimGeometry.rotateX(Math.PI / 2);
  const pipGeometry = new THREE.CylinderGeometry(1, 1, 1, 12);
  const emptyPipGeometry = new THREE.TorusGeometry(1, 0.28, 5, 12);
  emptyPipGeometry.rotateX(Math.PI / 2);
  const armedRingGeometry = new THREE.TorusGeometry(0.91, 0.045, 7, 32);
  armedRingGeometry.rotateX(Math.PI / 2);
  const targetHubGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.075, 16);
  const targetBarGeometry = new THREE.BoxGeometry(0.5, 0.06, 0.075);
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.34, metalness: 0.78 });
  const faceMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.27, metalness: 0.84 });
  const filledPipMaterial = new THREE.MeshStandardMaterial({ color: 0xffd29a, roughness: 0.24, metalness: 0.52 });
  const emptyPipMaterial = new THREE.MeshStandardMaterial({ color: 0x1d2226, roughness: 0.5, metalness: 0.18 });
  const armedMaterial = new THREE.MeshBasicMaterial({ color: 0xfff0d0, toneMapped: false, side: THREE.DoubleSide });
  const targetMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  let active: MeshSet | null = null;
  let capacity = 0;
  let disposed = false;
  let targetLanes = new Map<number, number>();

  const createMesh = (geometry: THREE.BufferGeometry, material: THREE.Material, size: number) => {
    const mesh = new THREE.InstancedMesh(geometry, material, size);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    root.add(mesh);
    return mesh;
  };

  function removeMeshes(meshes: MeshSet): void {
    root.remove(
      meshes.body,
      meshes.rim,
      meshes.filledPips,
      meshes.emptyPips,
      meshes.armedRing,
      meshes.targetRim,
      meshes.targetHub,
      meshes.targetBar,
    );
    meshes.body.dispose();
    meshes.rim.dispose();
    meshes.filledPips.dispose();
    meshes.emptyPips.dispose();
    meshes.armedRing.dispose();
    meshes.targetRim.dispose();
    meshes.targetHub.dispose();
    meshes.targetBar.dispose();
    for (const symbol of Object.values(meshes.symbols)) {
      for (const mesh of symbol.meshes) {
        root.remove(mesh);
        mesh.dispose();
      }
    }
  }

  function grow(requiredCoins: number): void {
    if (requiredCoins <= capacity) return;
    let next = Math.max(64, capacity || 1);
    while (next < requiredCoins) next *= 2;
    const previous = active;
    const symbols = {} as Record<CoinType, SymbolMeshSet>;
    for (const type of COIN_TYPES) {
      symbols[type] = {
        meshes: symbolResources.parts[type].map((part) => createMesh(part.geometry, part.material, next * 2)),
        count: 0,
      };
    }
    active = {
      body: createMesh(bodyGeometry, bodyMaterial, next),
      rim: createMesh(rimGeometry, faceMaterial, next * 2),
      symbols,
      filledPips: createMesh(pipGeometry, filledPipMaterial, next * MAX_BOMB_PIPS * 2),
      emptyPips: createMesh(emptyPipGeometry, emptyPipMaterial, next * MAX_BOMB_PIPS * 2),
      armedRing: createMesh(armedRingGeometry, armedMaterial, next * 2),
      targetRim: createMesh(rimGeometry, targetMaterial, next * 2),
      targetHub: createMesh(targetHubGeometry, targetMaterial, next * 2),
      targetBar: createMesh(targetBarGeometry, targetMaterial, next * 6),
    };
    capacity = next;
    if (previous) removeMeshes(previous);
  }

  const position = new THREE.Vector3();
  const facePosition = new THREE.Vector3();
  const normal = new THREE.Vector3(0, 1, 0);
  const localOffset = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const faceScale = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const bottomQuaternion = new THREE.Quaternion();
  const faceFlip = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  const bodyMatrix = new THREE.Matrix4();
  const faceMatrix = new THREE.Matrix4();

  function setFaceMatrix(
    matrix: THREE.Matrix4,
    coin: CoinView,
    offset: number,
    radialScale: number,
    thicknessScale: number,
    rotation = quaternion,
  ): void {
    facePosition.copy(position).addScaledVector(normal, offset);
    faceScale.set(coin.radius * radialScale, thicknessScale, coin.radius * radialScale);
    matrix.compose(facePosition, rotation, faceScale);
  }

  function setPipMatrix(coin: CoinView, faceOffset: number, pipIndex: number, threshold: number, bottom: boolean): void {
    const firstRow = threshold > 5 ? Math.ceil(threshold / 2) : threshold;
    const row = pipIndex >= firstRow ? 1 : 0;
    const rowStart = row === 0 ? 0 : firstRow;
    const columns = row === 0 ? firstRow : threshold - firstRow;
    const column = pipIndex - rowStart;
    localOffset.set(
      (column - (columns - 1) * 0.5) * 0.23 * coin.radius,
      0,
      (0.57 + row * 0.19) * coin.radius,
    ).applyQuaternion(quaternion);
    facePosition.copy(position).addScaledVector(normal, bottom ? -faceOffset : faceOffset).add(localOffset);
    faceScale.set(coin.radius * 0.058, DETAIL_THICKNESS, coin.radius * 0.058);
    faceMatrix.compose(facePosition, bottom ? bottomQuaternion : quaternion, faceScale);
  }

  function markTargets(targets: ReadonlyMap<number, number>): void {
    if (disposed) return;
    const nextTargets = new Map<number, number>();
    for (const [id, lane] of targets) {
      if (Number.isInteger(lane) && lane >= 0 && lane < TARGET_COLORS.length) nextTargets.set(id, lane);
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
    const { body, rim, symbols, filledPips, emptyPips, armedRing, targetRim, targetHub, targetBar } = active;
    for (const type of COIN_TYPES) symbols[type].count = 0;
    let index = 0;
    let filledPipIndex = 0;
    let emptyPipIndex = 0;
    let armedIndex = 0;
    let targetIndex = 0;
    let targetBarIndex = 0;
    const hitThreshold = Math.max(1, Math.min(MAX_BOMB_PIPS, Math.trunc(simulation.config.bomb.hitThreshold)));

    for (const coin of simulation.coins.values()) {
      position.set(coin.position.x, coin.position.y, coin.position.z);
      quaternion.set(coin.rotation.x, coin.rotation.y, coin.rotation.z, coin.rotation.w);
      bottomQuaternion.copy(quaternion).multiply(faceFlip);
      normal.set(0, 1, 0).applyQuaternion(quaternion);
      scale.set(coin.radius, coin.thickness, coin.radius);
      bodyMatrix.compose(position, quaternion, scale);
      body.setMatrixAt(index, bodyMatrix);
      const colors = TYPE_COLORS[coin.type];
      body.setColorAt(index, colors.body);
      rim.setColorAt(index * 2, colors.face);
      rim.setColorAt(index * 2 + 1, colors.face);
      const faceOffset = coin.thickness * 0.5 + DETAIL_CENTER_OFFSET;
      setFaceMatrix(faceMatrix, coin, faceOffset, 1, RIM_DETAIL_SCALE);
      rim.setMatrixAt(index * 2, faceMatrix);
      setFaceMatrix(faceMatrix, coin, -faceOffset, 1, RIM_DETAIL_SCALE, bottomQuaternion);
      rim.setMatrixAt(index * 2 + 1, faceMatrix);

      const symbolSet = symbols[coin.type];
      for (let partIndex = 0; partIndex < symbolSet.meshes.length; partIndex += 1) {
        const mesh = symbolSet.meshes[partIndex]!;
        const layer = partIndex * 0.001;
        setFaceMatrix(faceMatrix, coin, faceOffset + layer, 0.72, 1, quaternion);
        mesh.setMatrixAt(symbolSet.count * 2, faceMatrix);
        setFaceMatrix(faceMatrix, coin, -faceOffset - layer, 0.72, 1, bottomQuaternion);
        mesh.setMatrixAt(symbolSet.count * 2 + 1, faceMatrix);
      }
      symbolSet.count += 1;

      if (coin.type === "bomb") {
        const visibleHits = Math.max(0, Math.min(hitThreshold, Math.trunc(coin.bombHits)));
        for (let pip = 0; pip < hitThreshold; pip += 1) {
          for (let face = 0; face < 2; face += 1) {
            const bottom = face === 1;
            setPipMatrix(coin, faceOffset + 0.003, pip, hitThreshold, bottom);
            if (pip < visibleHits) {
              filledPips.setMatrixAt(filledPipIndex, faceMatrix);
              filledPipIndex += 1;
            } else {
              emptyPips.setMatrixAt(emptyPipIndex, faceMatrix);
              emptyPipIndex += 1;
            }
          }
        }
        if (visibleHits >= hitThreshold - 1) {
          setFaceMatrix(faceMatrix, coin, faceOffset + 0.005, 1.02, 1, quaternion);
          armedRing.setMatrixAt(armedIndex++, faceMatrix);
          setFaceMatrix(faceMatrix, coin, -faceOffset - 0.005, 1.02, 1, bottomQuaternion);
          armedRing.setMatrixAt(armedIndex++, faceMatrix);
        }
      }

      const lane = targetLanes.get(coin.id);
      if (lane !== undefined) {
        const color = TARGET_COLORS[lane]!;
        const targetFaceOffset = faceOffset + TARGET_FACE_OFFSET;
        for (let face = 0; face < 2; face += 1) {
          const bottom = face === 1;
          const offset = bottom ? -targetFaceOffset : targetFaceOffset;
          const rotation = bottom ? bottomQuaternion : quaternion;
          setFaceMatrix(faceMatrix, coin, offset, 1, RIM_DETAIL_SCALE, rotation);
          targetRim.setMatrixAt(targetIndex * 2 + face, faceMatrix);
          targetRim.setColorAt(targetIndex * 2 + face, color);
          setFaceMatrix(faceMatrix, coin, offset, 1, DETAIL_THICKNESS / 0.075, rotation);
          targetHub.setMatrixAt(targetIndex * 2 + face, faceMatrix);
          targetHub.setColorAt(targetIndex * 2 + face, color);
        }
        const barCount = lane + 1;
        for (let bar = 0; bar < barCount; bar += 1) {
          for (let face = 0; face < 2; face += 1) {
            const bottom = face === 1;
            const offset = bottom ? -(faceOffset + TARGET_BAR_OFFSET) : faceOffset + TARGET_BAR_OFFSET;
            facePosition.copy(position).addScaledVector(normal, offset);
            localOffset.set(0, 0, (bar - (barCount - 1) * 0.5) * TARGET_BAR_SPACING * coin.radius).applyQuaternion(quaternion);
            facePosition.add(localOffset);
            faceScale.set(coin.radius, DETAIL_THICKNESS / 0.06, coin.radius);
            faceMatrix.compose(facePosition, bottom ? bottomQuaternion : quaternion, faceScale);
            targetBar.setMatrixAt(targetBarIndex, faceMatrix);
            targetBar.setColorAt(targetBarIndex, color);
            targetBarIndex += 1;
          }
        }
        targetIndex += 1;
      }
      index += 1;
    }

    body.count = index;
    rim.count = index * 2;
    filledPips.count = filledPipIndex;
    emptyPips.count = emptyPipIndex;
    armedRing.count = armedIndex;
    targetRim.count = targetIndex * 2;
    targetHub.count = targetIndex * 2;
    targetBar.count = targetBarIndex;
    body.instanceMatrix.needsUpdate = true;
    rim.instanceMatrix.needsUpdate = true;
    filledPips.instanceMatrix.needsUpdate = true;
    emptyPips.instanceMatrix.needsUpdate = true;
    armedRing.instanceMatrix.needsUpdate = true;
    targetRim.instanceMatrix.needsUpdate = true;
    targetHub.instanceMatrix.needsUpdate = true;
    targetBar.instanceMatrix.needsUpdate = true;
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    if (rim.instanceColor) rim.instanceColor.needsUpdate = true;
    if (targetRim.instanceColor) targetRim.instanceColor.needsUpdate = true;
    if (targetHub.instanceColor) targetHub.instanceColor.needsUpdate = true;
    if (targetBar.instanceColor) targetBar.instanceColor.needsUpdate = true;
    for (const type of COIN_TYPES) {
      const symbol = symbols[type];
      for (const mesh of symbol.meshes) {
        mesh.count = symbol.count * 2;
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    targetLanes.clear();
    if (active) removeMeshes(active);
    bodyGeometry.dispose();
    rimGeometry.dispose();
    pipGeometry.dispose();
    emptyPipGeometry.dispose();
    armedRingGeometry.dispose();
    targetHubGeometry.dispose();
    targetBarGeometry.dispose();
    bodyMaterial.dispose();
    faceMaterial.dispose();
    filledPipMaterial.dispose();
    emptyPipMaterial.dispose();
    armedMaterial.dispose();
    targetMaterial.dispose();
  }

  return { update, markTargets, dispose };
}
