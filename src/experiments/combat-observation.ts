import * as THREE from "three";
import { createChuteLayout } from "../chutes";
import type { ChuteSlot } from "../chutes";
import { BOMB_DAMAGE } from "../combat/config";
import type { CombatEffect, CombatTotals, Encounter, FeedTray } from "../combat/types";
import { COIN_TYPES, type CoinType, type CoinView, type GizmoView, type Vec3 } from "../contracts";
import { fitMachineCamera, MACHINE_CAMERA_DESKTOP } from "../presentation/camera";
import { createCoinSymbolResources } from "../presentation/coin-symbols";
import {
  createObservationCabinet,
  updateFeedTrays,
  type CabinetScene,
} from "../presentation/scene";
import { bagCounts } from "../run/purchases";
import {
  createLaneObserver,
  laneForX,
  supportClassification,
  type SupportClassification,
} from "./lanes";
import type {
  CombatCandidate,
  CombatLaneSummary,
  CombatObserver,
  CombatTypeCounts,
  ExposedCombatCoin,
  ObservedFeedTray,
  PublicCombatBatch,
} from "./solver-contracts";

const CAP_NORMAL_EPSILON = 0.99;
const CANDIDATE_COUNT = 5;
const CAP_SAMPLES = [
  [0, 0],
  [0.5, 0],
  [-0.5, 0],
  [0, 0.5],
  [0, -0.5],
] as const;

type SupportedBand = Exclude<
  SupportClassification,
  "airborne" | "falling"
>;

function roundPosition(position: Vec3): Vec3 {
  const round = (value: number) => {
    const result = Math.round(value * 100) / 100;
    return result === 0 ? 0 : result;
  };
  return { x: round(position.x), y: round(position.y), z: round(position.z) };
}

function emptyTypeCounts(): CombatTypeCounts {
  return {
    counts: Object.fromEntries(COIN_TYPES.map((type) => [type, 0])) as Record<
      CoinType,
      number
    >,
    nearThresholdBombs: 0,
  };
}

function emptyCombatLane(index: number): CombatLaneSummary {
  return {
    index,
    upper: emptyTypeCounts(),
    lowerRear: emptyTypeCounts(),
    lowerMiddle: emptyTypeCounts(),
    lowerFront: emptyTypeCounts(),
    nearEdge: emptyTypeCounts(),
  };
}

function addType(
  counts: CombatTypeCounts,
  coin: CoinView,
  nearThreshold: boolean,
): void {
  counts.counts[coin.type] += 1;
  if (coin.type === "bomb" && nearThreshold) counts.nearThresholdBombs += 1;
}

function publicEffect(effect: CombatEffect): Omit<CombatEffect, "id"> {
  return {
    type: effect.type,
    position: { ...effect.position },
    enemyDamage: effect.enemyDamage,
    swordMultiplier: effect.swordMultiplier,
    enemyHits: effect.enemyHits.map((hit) => ({ ...hit })),
    discardedDamage: effect.discardedDamage,
    playerDamage: effect.playerDamage,
    healingOffered: effect.healingOffered,
    currency: effect.currency,
    safeBomb: effect.safeBomb,
    detonated: effect.detonated,
    blastAssociated: effect.blastAssociated,
  };
}

function publicBatches(
  recent: readonly { delta: CombatTotals; effects: readonly CombatEffect[] }[],
): PublicCombatBatch[] {
  return recent.map((batch) => ({
    delta: { ...batch.delta },
    effects: batch.effects.map(publicEffect),
  }));
}


function combatCandidates(
  radius: number,
  slots: readonly ChuteSlot[],
  spacing: number,
): CombatCandidate[] {
  const tuning = { radius };
  const safeSpacing = Math.max(2 * radius + 0.02, spacing);
  const left = createChuteLayout(slots, tuning, -Number.MAX_VALUE, safeSpacing)[0]!.x;
  const right = createChuteLayout(slots, tuning, Number.MAX_VALUE, safeSpacing)[0]!.x;
  return Array.from({ length: CANDIDATE_COUNT }, (_, index) => {
    const aimX = left + ((right - left) * index) / (CANDIDATE_COUNT - 1);
    return {
      aimX,
      chutes: createChuteLayout(slots, tuning, aimX, safeSpacing).map(
        ({ id, ownerId, source, slot, enabled, x }) => ({
          id,
          ownerId,
          source,
          slot,
          enabled,
          x,
        }),
      ),
    };
  });
}

function opaqueMaterial(material: THREE.Material | THREE.Material[]): boolean {
  if (Array.isArray(material)) {
    return material.some((entry) => !entry.transparent && entry.opacity > 0);
  }
  return !material.transparent && material.opacity > 0;
}

function supportedBand(
  coin: CoinView,
  pusherFront: number,
  shelfFront: number,
): SupportedBand | null {
  const classification = supportClassification(coin, pusherFront, shelfFront);
  return classification === "airborne" || classification === "falling"
    ? null
    : classification;
}

/**
 * Projects the fixed desktop view into an intentionally conservative policy view.
 * A type is readable only when one physical cap owns at least three of five rays.
 */
export function createCombatObserver(): CombatObserver {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  const raycaster = new THREE.Raycaster();
  const laneObserver = createLaneObserver();
  const symbolResources = createCoinSymbolResources();
  const coinGeometry = new THREE.CylinderGeometry(1, 1, 1, 32);
  const coinMaterial = new THREE.MeshBasicMaterial();
  const coinMeshes: THREE.Mesh[] = [];
  const gizmoGeometry = new THREE.SphereGeometry(1, 24, 16);
  const gizmoOccluder = new THREE.Mesh(gizmoGeometry, coinMaterial);
  gizmoOccluder.visible = false;
  scene.add(gizmoOccluder);
  // The crown extends beyond the collision sphere; bound the entire authored mascot conservatively.
  const updateGizmoOccluder = (view: GizmoView) => {
    gizmoOccluder.visible = true;
    gizmoOccluder.position.set(view.position.x, view.position.y, view.position.z);
    gizmoOccluder.scale.setScalar(view.radius * 1.25);
  };
  let cabinet: CabinetScene | null = null;
  let cabinetShelfFront = Number.NaN;
  let disposed = false;

  const target = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const center = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const localSample = new THREE.Vector3();
  const projectedSample = new THREE.Vector3();
  const intersections: THREE.Intersection[] = [];
  const rayObjects: THREE.Object3D[] = [];
  const coins: CoinView[] = [];
  const readable: CoinView[] = [];
  const stockOverlays = new Set<THREE.Object3D>();

  function disposeCabinet(): void {
    if (!cabinet) return;
    scene.remove(cabinet.root);
    for (const geometry of cabinet.resources.geometries) geometry.dispose();
    for (const material of cabinet.resources.materials) material.dispose();
    cabinet = null;
  }

  function ensureCabinet(shelfFront: number): CabinetScene {
    if (cabinet && cabinetShelfFront === shelfFront) return cabinet;
    disposeCabinet();
    cabinet = createObservationCabinet(shelfFront, symbolResources);
    cabinetShelfFront = shelfFront;
    stockOverlays.clear();
    stockOverlays.add(cabinet.stockRims);
    for (const symbol of Object.values(cabinet.stockSymbols)) {
      for (const mesh of symbol.meshes) stockOverlays.add(mesh);
    }
    scene.add(cabinet.root);
    return cabinet;
  }

  function ensureCoinMeshes(count: number): void {
    while (coinMeshes.length < count) {
      const mesh = new THREE.Mesh(coinGeometry, coinMaterial);
      mesh.visible = false;
      mesh.matrixAutoUpdate = true;
      scene.add(mesh);
      coinMeshes.push(mesh);
    }
  }

  function configureCoinMeshes(coins: readonly CoinView[]): void {
    ensureCoinMeshes(coins.length);
    for (let index = 0; index < coinMeshes.length; index += 1) {
      const mesh = coinMeshes[index]!;
      const coin = coins[index];
      mesh.visible = coin !== undefined;
      if (!coin) continue;
      mesh.position.set(coin.position.x, coin.position.y, coin.position.z);
      mesh.quaternion.set(
        coin.rotation.x,
        coin.rotation.y,
        coin.rotation.z,
        coin.rotation.w,
      );
      mesh.scale.set(coin.radius, coin.thickness, coin.radius);
    }
  }

  function raycastables(): THREE.Object3D[] {
    rayObjects.length = 0;
    scene.traverseVisible((object) => {
      if (
        object instanceof THREE.Mesh &&
        opaqueMaterial(object.material) && !stockOverlays.has(object)
      ) {
        rayObjects.push(object);
      }
    });
    return rayObjects;
  }

  function capHasThreeClearRays(
    coin: CoinView,
    mesh: THREE.Mesh,
    faceSign: 1 | -1,
    objects: THREE.Object3D[],
    instanceId?: number,
  ): boolean {
    quaternion.set(
      coin.rotation.x,
      coin.rotation.y,
      coin.rotation.z,
      coin.rotation.w,
    );
    if (
      !Number.isFinite(quaternion.x) ||
      !Number.isFinite(quaternion.y) ||
      !Number.isFinite(quaternion.z) ||
      !Number.isFinite(quaternion.w) ||
      quaternion.lengthSq() < Number.EPSILON
    ) {
      return false;
    }
    quaternion.normalize();
    center.set(coin.position.x, coin.position.y, coin.position.z);
    normal.set(0, faceSign, 0).applyQuaternion(quaternion);
    target
      .copy(center)
      .addScaledVector(normal, coin.thickness * 0.5);
    direction.copy(camera.position).sub(target);
    if (normal.dot(direction) <= 0) return false;

    let clear = 0;
    for (const [x, z] of CAP_SAMPLES) {
      localSample
        .set(
          (x + 0.003) * coin.radius,
          faceSign * coin.thickness * 0.5,
          (z + 0.003) * coin.radius,
        )
        .applyQuaternion(quaternion)
        .add(center);
      projectedSample.copy(localSample).project(camera);
      if (
        Math.abs(projectedSample.x) > 1 ||
        Math.abs(projectedSample.y) > 1 ||
        Math.abs(projectedSample.z) > 1
      ) continue;
      direction.copy(localSample).sub(camera.position);
      const distance = direction.length();
      if (!(distance > 0) || !Number.isFinite(distance)) continue;
      raycaster.set(camera.position, direction.multiplyScalar(1 / distance));
      raycaster.near = 0;
      raycaster.far = distance + Math.max(coin.radius, coin.thickness) * 0.01;
      intersections.length = 0;
      const first = raycaster.intersectObjects(objects, false, intersections)[0];
      const localNormalY = first?.face?.normal.y;
      if (
        first?.object === mesh &&
        (instanceId === undefined || first.instanceId === instanceId) &&
        localNormalY !== undefined &&
        Math.abs(localNormalY) >= CAP_NORMAL_EPSILON &&
        Math.sign(localNormalY) === faceSign
      ) {
        clear += 1;
        if (clear >= 3) return true;
      }
    }
    return false;
  }

  function readableCoins(coins: readonly CoinView[], objects: THREE.Object3D[]): CoinView[] {
    readable.length = 0;
    for (let index = 0; index < coins.length; index += 1) {
      const coin = coins[index]!;
      const mesh = coinMeshes[index]!;
      if (
        capHasThreeClearRays(coin, mesh, 1, objects) ||
        capHasThreeClearRays(coin, mesh, -1, objects)
      ) {
        readable.push(coin);
      }
    }
    return readable;
  }

  function readableFeed(trays: readonly FeedTray[], objects: THREE.Object3D[]): ObservedFeedTray[] {
    let instanceId = 0;
    return trays.map((tray) => {
      const preview: (CoinType | null)[] = [];
      for (let slot = 0; slot < tray.coins.length; slot += 1) {
        const coin = tray.coins[slot]!;
        if (slot < 5) {
          preview.push(capHasThreeClearRays(coin, cabinet!.stockBodies, 1, objects, instanceId) ? coin.type : null);
        }
        instanceId += 1;
      }
      return {
        id: tray.id,
        ownerId: tray.ownerId,
        slot: tray.slot,
        enabled: tray.enabled,
        x: tray.x,
        source: tray.source,
        preview,
      };
    });
  }

  return {
    observe(encounter: Encounter) {
      if (disposed) throw new Error("Combat observer is disposed");
      const simulation = encounter.simulation;
      const snapshot = encounter.snapshot();
      const trays = encounter.preview();
      const stats = simulation.stats();
      const activeCabinet = ensureCabinet(simulation.tuning.shelfFront);
      updateFeedTrays(
        activeCabinet,
        trays,
        simulation.tuning.radius,
        simulation.tuning.thickness,
        simulation.tuning.dropHeight,
      );
      activeCabinet.stockBodies.computeBoundingSphere();
      activeCabinet.stockRims.computeBoundingSphere();
      for (const symbol of Object.values(activeCabinet.stockSymbols)) {
        for (const mesh of symbol.meshes) mesh.computeBoundingSphere();
      }
      activeCabinet.pusher.position.z = stats.pusherZ;
      fitMachineCamera(
        camera,
        MACHINE_CAMERA_DESKTOP.width,
        MACHINE_CAMERA_DESKTOP.height,
        simulation.tuning.radius,
        simulation.tuning.dropHeight,
        simulation.tuning.shelfFront,
        simulation.tuning.thickness,
      );
      camera.updateMatrixWorld(true);

      coins.length = 0;
      for (const coin of simulation.coins.values()) coins.push(coin);
      gizmoOccluder.visible = false;
      simulation.gizmos.forEach(updateGizmoOccluder);
      configureCoinMeshes(coins);
      scene.updateMatrixWorld(true);
      const objects = raycastables();
      readableCoins(coins, objects);
      const feed = readableFeed(trays, objects);
      const actualSpacing = snapshot.chuteSettings.chuteSpacing;
      const visibleIds = new Set(readable.map((coin) => coin.id));
      const board = laneObserver.observe(simulation, visibleIds);
      const threshold = snapshot.config.bomb.hitThreshold;
      const exposedCoins: ExposedCombatCoin[] = readable.map((coin) => ({
        type: coin.type,
        position: roundPosition(coin.position),
        bombHits: coin.bombHits,
        nearThreshold:
          coin.type === "bomb" && coin.bombHits >= threshold - 1,
      }));
      const lanes = Array.from({ length: 5 }, (_, index) =>
        emptyCombatLane(index),
      );
      for (const coin of readable) {
        const laneIndex = laneForX(coin.position.x);
        if (laneIndex === null) continue;
        const band = supportedBand(
          coin,
          board.pusherFront,
          board.shelfFront,
        );
        if (band === null) continue;
        const nearThreshold =
          coin.type === "bomb" && coin.bombHits >= threshold - 1;
        addType(lanes[laneIndex]![band], coin, nearThreshold);
        if (
          band !== "upper" &&
          board.shelfFront - coin.position.z <= 2 * coin.radius
        ) {
          addType(lanes[laneIndex]!.nearEdge, coin, nearThreshold);
        }
      }
      const comboWindow = snapshot.build?.combo.windowTicks ?? 0;

      return {
        visibilityModel: "three-cap-rays-v3",
        board,
        playerHp: snapshot.playerHp,
        playerMaxHp: snapshot.playerMaxHp,
        enemies: snapshot.enemies.map((enemy) => ({ ...enemy })),
        frontEnemyId: snapshot.frontEnemyId,
        waveIndex: snapshot.waveIndex,
        waveCount: snapshot.waveCount,
        livingWaveHp: snapshot.livingWaveHp,
        currency: snapshot.currency,
        ownedBuild: {
          bags: snapshot.playerChutes.map(({ id, bag }) => ({ chuteId: id, counts: bagCounts(bag) })),
          stickers: snapshot.build?.stickers ?? [],
          effectLevels: snapshot.build?.effectLevels ?? { temperedSwords: 0, restorativeBrew: 0 },
          releaseMode: snapshot.build?.releaseMode ?? "ordinary",
          detonationPolicy: snapshot.build?.detonationPolicy ?? "physical",
          coinRadius: simulation.tuning.radius, coinThickness: simulation.tuning.thickness,
          openingPopulation: simulation.tuning.density, coinWeight: simulation.tuning.coinWeight,
        },
        combo: {
          ...snapshot.combo, windowTicks: comboWindow, maxMultiplier: snapshot.build?.combo.maxMultiplier ?? 1,
          ticksRemaining: snapshot.combo.lastSwordTick === null ? 0
            : Math.max(0, comboWindow - (snapshot.tick - snapshot.combo.lastSwordTick)),
        },
        rules: {
          swordDamage: snapshot.build?.swordDamage ?? snapshot.config.swordDamage,
          skullDamage: snapshot.build?.skullDamage ?? snapshot.config.skullDamage,
          potionHealing: snapshot.build?.potionHealing ?? snapshot.config.potionHealing,
          bombDamage: snapshot.build?.bombDamage ?? BOMB_DAMAGE,
          bomb: { ...snapshot.config.bomb },
        },
        candidates: combatCandidates(
          simulation.tuning.radius,
          snapshot.chuteSlots,
          Number.isFinite(actualSpacing)
            ? actualSpacing
            : 2 * simulation.tuning.radius + 0.02,
        ),
        feed,
        exposedCoins,
        lanes,
        recentEffects: publicBatches(snapshot.recentEffects),
      };
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      laneObserver.reset();
      disposeCabinet();
      scene.remove(gizmoOccluder);
      gizmoGeometry.dispose();
      for (const mesh of coinMeshes) scene.remove(mesh);
      coinGeometry.dispose();
      coinMaterial.dispose();
      symbolResources.dispose();
    },
  };
}
