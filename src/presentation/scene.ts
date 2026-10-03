import * as THREE from "three";
import { COIN_TYPES, type CoinType, type CoinView } from "../contracts";
import type { FeedTray } from "../combat/types";
import { MACHINE_GEOMETRY } from "../machine-geometry";
import {
  FEED_PREVIEW_SLOTS,
  FEED_TRAY_COS,
  FEED_TRAY_ROTATION,
  FEED_TRAY_SIN,
  getFeedTrayGeometry,
  type FeedTrayGeometry,
} from "../feed-geometry";
import type { CabinetAsset, CabinetModuleName } from "./cabinet-asset";
import { COIN_SYMBOL_PALETTE, type CoinSymbolResources } from "./coin-symbols";
import { CHUTE_OWNERSHIP_COLORS } from "./chute-ownership";

const {
  playerDropZ: PLAYER_DROP_Z,
  maxTrays: MAX_TRAYS,
} = MACHINE_GEOMETRY;
const MAX_STOCK = MAX_TRAYS * FEED_PREVIEW_SLOTS;

export interface TrayVisual {
  root: THREE.Group;
  rearFloor: THREE.Mesh;
  trapdoor: THREE.Mesh;
  trapdoorOpenReference: THREE.Mesh;
  frontFloor: THREE.Mesh;
  frontFloorOpenReference: THREE.Mesh;
  leftWall: THREE.Mesh;
  rightWall: THREE.Mesh;
  rearWall: THREE.Mesh;
  frontStop: THREE.Mesh;
  frontStopOpenReference: THREE.Mesh;
  upperStops: readonly THREE.Mesh[];
  upperStopOpenReferences: readonly THREE.Mesh[];
  cover: THREE.Mesh;
  arrow: THREE.Mesh;
  ownershipSource: FeedTray["source"] | null;
  ownershipAccents: readonly {
    mesh: THREE.Mesh;
    player: THREE.Material | THREE.Material[];
    enemy: THREE.Material | THREE.Material[];
  }[];
}
interface StockSymbolSet {
  readonly meshes: readonly THREE.InstancedMesh[];
  count: number;
}

export interface CabinetScene {
  root: THREE.Group;
  pusher: THREE.Object3D;
  resources: {
    geometries: THREE.BufferGeometry[];
    materials: THREE.Material[];
  };
  trays: TrayVisual[];
  stockBodies: THREE.InstancedMesh;
  stockRims: THREE.InstancedMesh;
  stockSymbols: Record<CoinType, StockSymbolSet>;
  /** Concatenated tray.coins order. Body/rim instance i corresponds to stockOrder[i]. */
  stockOrder: CoinView[];
  trayGeometry: FeedTrayGeometry | null;
  trayRadius: number;
  trayThickness: number;
  trayDropHeight: number;
}

function instantiateModule(asset: CabinetAsset, name: CabinetModuleName): THREE.Object3D {
  const module = asset.instantiate(name);
  module.name = name;
  return module;
}

function requireMesh(root: THREE.Object3D, name: string): THREE.Mesh {
  const object = root.getObjectByName(name);
  if (!(object instanceof THREE.Mesh)) {
    throw new Error(`Authored cabinet module \"${root.name}\" is missing mesh \"${name}\"`);
  }
  return object;
}

const rawMeshSize = new THREE.Vector3();
function fitBox(
  mesh: THREE.Mesh,
  size: readonly [number, number, number],
  position: readonly [number, number, number],
): void {
  const geometry = mesh.geometry;
  geometry.computeBoundingBox();
  geometry.boundingBox!.getSize(rawMeshSize);
  mesh.scale.set(size[0] / rawMeshSize.x, size[1] / rawMeshSize.y, size[2] / rawMeshSize.z);
  mesh.position.set(...position);
}

function instanceMesh(
  root: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  root.add(mesh);
  return mesh;
}

function configurePlayfield(playfield: THREE.Object3D, shelfFront: number): void {
  const shelfDepth = shelfFront - MACHINE_GEOMETRY.shelfRearZ;
  const shelfCenterZ = MACHINE_GEOMETRY.shelfRearZ + shelfDepth / 2;
  const surfaceDepth = Math.max(0.01, shelfDepth - 0.08);
  const surfaceCenterZ = MACHINE_GEOMETRY.shelfRearZ + 0.04 + surfaceDepth / 2;
  fitBox(
    requireMesh(playfield, "playfield_shelf"),
    [MACHINE_GEOMETRY.shelfHalfWidth * 2, MACHINE_GEOMETRY.shelfThickness, shelfDepth],
    [0, MACHINE_GEOMETRY.shelfCenterY, shelfCenterZ],
  );
  fitBox(
    requireMesh(playfield, "playfield_surface"),
    [MACHINE_GEOMETRY.shelfHalfWidth * 2 - 0.16, 0.012, surfaceDepth],
    [0, 0.006, surfaceCenterZ],
  );
  for (const [name, x] of [
    ["playfield_left_guard", -MACHINE_GEOMETRY.sideWallX],
    ["playfield_right_guard", MACHINE_GEOMETRY.sideWallX],
  ] as const) {
    fitBox(
      requireMesh(playfield, name),
      [MACHINE_GEOMETRY.sideWallThickness, MACHINE_GEOMETRY.wallHeight, shelfDepth],
      [x, MACHINE_GEOMETRY.wallCenterY, shelfCenterZ],
    );
  }
}

export function createCabinet(
  shelfFront: number,
  symbolResources: CoinSymbolResources,
  asset: CabinetAsset,
): CabinetScene {
  const root = new THREE.Group();
  root.name = "painted-arcade-cabinet";
  const shell = instantiateModule(asset, "cabinet_shell");
  const playfield = instantiateModule(asset, "playfield");
  const pusher = instantiateModule(asset, "pusher");
  const collectionTray = instantiateModule(asset, "collection_tray");
  configurePlayfield(playfield, shelfFront);
  collectionTray.position.z = shelfFront - 4;
  root.add(shell, playfield, pusher, collectionTray);

  const stockCoinGeometry = new THREE.CylinderGeometry(1, 1, 1, 24);
  const stockRimGeometry = new THREE.TorusGeometry(0.79, 0.075, 7, 28);
  stockRimGeometry.rotateX(Math.PI / 2);
  const geometries: THREE.BufferGeometry[] = [stockCoinGeometry, stockRimGeometry];
  const stockMaterial = new THREE.MeshStandardMaterial({
    color: 0xf7f4ed,
    roughness: 0.34,
    metalness: 0.7,
  });
  const stockRimMaterial = new THREE.MeshStandardMaterial({
    color: 0xf7f4ed,
    roughness: 0.28,
    metalness: 0.78,
  });
  const materials: THREE.Material[] = [stockMaterial, stockRimMaterial];
  // Asset instances share materials. Cache owned paint variants without touching
  // the originals used by brass cabinet hardware or other tray sources.
  const ownershipMaterials = new Map<THREE.Material, Record<FeedTray["source"], THREE.Material>>();
  const paintedMaterial = (original: THREE.Material, source: FeedTray["source"]): THREE.Material => {
    let variants = ownershipMaterials.get(original);
    if (!variants) {
      const paint = (owner: FeedTray["source"]): THREE.Material => {
        const material = original.clone();
        if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshBasicMaterial) {
          material.color.set(CHUTE_OWNERSHIP_COLORS[owner]);
        }
        materials.push(material);
        return material;
      };
      variants = { player: paint("player"), enemy: paint("enemy") };
      ownershipMaterials.set(original, variants);
    }
    return variants[source];
  };

  const trays: TrayVisual[] = [];
  for (let index = 0; index < MAX_TRAYS; index += 1) {
    const trayRoot = new THREE.Group();
    trayRoot.name = `feed-tray-slot-${index + 1}`;
    trayRoot.visible = false;
    const rail = instantiateModule(asset, "feed_rail");
    const gate = instantiateModule(asset, "feed_gate");
    const coverModule = instantiateModule(asset, "feed_cover");
    trayRoot.add(rail, gate, coverModule);
    const trapdoorOpenReference = requireMesh(gate, "feed_trapdoor_open_reference");
    const frontFloorOpenReference = requireMesh(rail, "feed_front_floor_open_reference");
    const frontStopOpenReference = requireMesh(gate, "feed_front_stop_open_reference");
    const upperStops = Array.from({ length: FEED_PREVIEW_SLOTS - 1 }, (_, index) =>
      requireMesh(gate, `feed_upper_stop_${index + 1}`));
    const upperStopOpenReferences = Array.from(
      { length: FEED_PREVIEW_SLOTS - 1 },
      (_, index) => requireMesh(gate, `feed_upper_stop_${index + 1}_open_reference`),
    );
    trapdoorOpenReference.visible = false;
    frontFloorOpenReference.visible = false;
    frontStopOpenReference.visible = false;
    for (const holdback of [...upperStops, ...upperStopOpenReferences]) holdback.visible = false;
    const arrow = requireMesh(rail, "feed_arrow");
    const ownershipAccents = [
      requireMesh(rail, "feed_left_rail"),
      requireMesh(rail, "feed_right_rail"),
      requireMesh(rail, "feed_rear_stop"),
      requireMesh(gate, "feed_front_stop"),
      arrow,
    ].map((mesh) => ({
      mesh,
      player: Array.isArray(mesh.material)
        ? mesh.material.map((material) => paintedMaterial(material, "player"))
        : paintedMaterial(mesh.material, "player"),
      enemy: Array.isArray(mesh.material)
        ? mesh.material.map((material) => paintedMaterial(material, "enemy"))
        : paintedMaterial(mesh.material, "enemy"),
    }));
    root.add(trayRoot);
    trays.push({
      root: trayRoot,
      rearFloor: requireMesh(rail, "feed_rear_floor"),
      trapdoor: requireMesh(gate, "feed_trapdoor"),
      trapdoorOpenReference,
      frontFloor: requireMesh(rail, "feed_front_floor"),
      frontFloorOpenReference,
      leftWall: requireMesh(rail, "feed_left_rail"),
      rightWall: requireMesh(rail, "feed_right_rail"),
      rearWall: requireMesh(rail, "feed_rear_stop"),
      frontStop: requireMesh(gate, "feed_front_stop"),
      frontStopOpenReference,
      upperStops,
      upperStopOpenReferences,
      cover: requireMesh(coverModule, "feed_cover_plate"),
      arrow,
      ownershipSource: null,
      ownershipAccents,
    });
  }

  const stockBodies = instanceMesh(root, stockCoinGeometry, stockMaterial, MAX_STOCK);
  const stockRims = instanceMesh(root, stockRimGeometry, stockRimMaterial, MAX_STOCK);
  const stockSymbols = {} as Record<CoinType, StockSymbolSet>;
  for (const type of COIN_TYPES) {
    stockSymbols[type] = {
      meshes: symbolResources.parts[type].map((part) =>
        instanceMesh(root, part.geometry, part.material, MAX_STOCK)),
      count: 0,
    };
  }

  return {
    root,
    pusher,
    trays,
    stockBodies,
    stockRims,
    stockSymbols,
    stockOrder: [],
    resources: { geometries, materials },
    trayGeometry: null,
    trayRadius: Number.NaN,
    trayThickness: Number.NaN,
    trayDropHeight: Number.NaN,
  };
}

/**
 * Contact-only cabinet for deterministic CPU visibility diagnostics. It uses
 * the shared dimensions and never substitutes for the authored runtime asset.
 */
export function createObservationCabinet(
  shelfFront: number,
  symbolResources: CoinSymbolResources,
): CabinetScene {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const opaque = new THREE.MeshBasicMaterial();
  const transparent = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.18 });
  const modules = {} as Record<CabinetModuleName, THREE.Object3D>;
  for (const name of [
    "cabinet_shell",
    "playfield",
    "pusher",
    "collection_tray",
    "feed_rail",
    "feed_gate",
    "feed_cover",
    "combo_bell",
  ] as const) {
    const module = new THREE.Group();
    module.name = name;
    modules[name] = module;
  }
  const addUnitMesh = (
    module: CabinetModuleName,
    name: string,
    material: THREE.Material = opaque,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    modules[module].add(mesh);
    return mesh;
  };
  for (const name of ["playfield_shelf", "playfield_surface"] as const)
    addUnitMesh("playfield", name);
  addUnitMesh("playfield", "playfield_left_guard", transparent);
  addUnitMesh("playfield", "playfield_right_guard", transparent);
  const pusherBody = addUnitMesh("pusher", "pusher_body");
  pusherBody.scale.set(
    MACHINE_GEOMETRY.pusherWidth,
    MACHINE_GEOMETRY.pusherHeight,
    MACHINE_GEOMETRY.pusherDepth,
  );
  pusherBody.position.set(0, MACHINE_GEOMETRY.pusherCenterY, MACHINE_GEOMETRY.pusherCenterZ);
  for (const name of [
    "feed_rear_floor",
    "feed_front_floor",
    "feed_front_floor_open_reference",
    "feed_left_rail",
    "feed_right_rail",
    "feed_rear_stop",
  ] as const)
    addUnitMesh("feed_rail", name);
  // Conservative bounds of the authored arrow, including its local Z offset.
  const arrowGeometry = new THREE.BoxGeometry(0.36, 0.024, 0.36).translate(0, 0, -0.01);
  const arrow = new THREE.Mesh(arrowGeometry, opaque);
  arrow.name = "feed_arrow";
  modules.feed_rail.add(arrow);
  for (const name of [
    "feed_trapdoor",
    "feed_trapdoor_open_reference",
    "feed_front_stop",
    "feed_front_stop_open_reference",
    "feed_upper_stop_1",
    "feed_upper_stop_1_open_reference",
    "feed_upper_stop_2",
    "feed_upper_stop_2_open_reference",
    "feed_upper_stop_3",
    "feed_upper_stop_3_open_reference",
    "feed_upper_stop_4",
    "feed_upper_stop_4_open_reference",
  ] as const)
    addUnitMesh("feed_gate", name);
  addUnitMesh("feed_cover", "feed_cover_plate", transparent);
  const contactAsset: CabinetAsset = {
    bounds: new THREE.Box3(
      new THREE.Vector3(
        -MACHINE_GEOMETRY.cameraLandscapeHalfWidth,
        MACHINE_GEOMETRY.cameraMinimumY,
        MACHINE_GEOMETRY.physicalRearWallZ,
      ),
      new THREE.Vector3(
        MACHINE_GEOMETRY.cameraLandscapeHalfWidth,
        MACHINE_GEOMETRY.cameraTopY,
        MACHINE_GEOMETRY.cameraFrontZ,
      ),
    ),
    instantiate(name) {
      return modules[name].clone(true);
    },
    dispose() {
      geometry.dispose();
      arrowGeometry.dispose();
      opaque.dispose();
      transparent.dispose();
    },
  };
  const cabinet = createCabinet(shelfFront, symbolResources, contactAsset);
  cabinet.resources.geometries.push(geometry, arrowGeometry);
  cabinet.resources.materials.push(opaque, transparent);
  return cabinet;
}
const trayQuaternion = new THREE.Quaternion(
  FEED_TRAY_ROTATION.x,
  FEED_TRAY_ROTATION.y,
  FEED_TRAY_ROTATION.z,
  FEED_TRAY_ROTATION.w,
);
const stockPosition = new THREE.Vector3();
const stockScale = new THREE.Vector3();
const stockMatrix = new THREE.Matrix4();
const stockQuaternion = new THREE.Quaternion();
const stockNormal = new THREE.Vector3(0, 1, 0);
const STOCK_COLORS = Object.fromEntries(
  COIN_TYPES.map((type) => [type, {
    body: new THREE.Color(COIN_SYMBOL_PALETTE[type].body),
    face: new THREE.Color(COIN_SYMBOL_PALETTE[type].face),
  }]),
) as Record<CoinType, { body: THREE.Color; face: THREE.Color }>;

/**
 * Applies one physical feeder frame from the concrete FeedTray gate and burst
 * state. Each moving authored part stays separately addressable on TrayVisual.
 */
export function updateFeedTrayHardwareFrame(
  visual: TrayVisual,
  geometry: FeedTrayGeometry,
  tray: FeedTray,
): void {
  const floorThickness = geometry.floorThickness;
  const trapdoorLength = geometry.trapFrontZ - geometry.trapRearZ;
  const frontFloorLength = geometry.localFrontZ - geometry.trapFrontZ;
  const trapRetracted = tray.gateOpen || tray.burst.trapRetracted;
  const frontFloorRetracted = trapRetracted;
  const openDrop = Math.max(0.22, trapdoorLength / 2 + floorThickness + 0.08);
  visual.frontFloor.rotation.x = frontFloorRetracted ? Math.PI / 2 : 0;
  fitBox(
    visual.frontFloor,
    [geometry.width, floorThickness, frontFloorLength],
    [0, geometry.localBaseY - (frontFloorRetracted ? openDrop : 0), geometry.trapFrontZ + frontFloorLength * 0.5],
  );
  visual.trapdoor.rotation.x = trapRetracted ? Math.PI / 2 : 0;
  fitBox(
    visual.trapdoor,
    [geometry.width, floorThickness, trapdoorLength],
    trapRetracted
      ? [0, geometry.localBaseY - openDrop, geometry.trapRearZ - trapdoorLength * 0.5]
      : [0, geometry.localBaseY, (geometry.trapRearZ + geometry.trapFrontZ) * 0.5],
  );
  visual.frontStop.rotation.x = trapRetracted ? Math.PI / 2 : 0;
  fitBox(
    visual.frontStop,
    [geometry.width, geometry.lipHeight, geometry.wallThickness],
    trapRetracted
      ? [0, geometry.wallCenterY - geometry.lipHeight * 0.5 - openDrop, geometry.frontStopZ]
      : [0, geometry.wallCenterY, geometry.frontStopZ],
  );
  for (let index = 0; index < visual.upperStops.length; index += 1) {
    const holdback = visual.upperStops[index]!;
    const localZ = -(index + 1) * geometry.spacing + geometry.previewRadius + 0.08;
    holdback.visible = tray.enabled;
    fitBox(
      holdback,
      [geometry.width + 0.04, 0.04, 0.05],
      tray.burst.trapRetracted
        ? [geometry.width + 0.10, geometry.wallCenterY, localZ]
        : [0, geometry.wallCenterY, localZ],
    );
  }
}
export function updateFeedTrays(
  cabinet: CabinetScene,
  trays: readonly FeedTray[],
  radius: number,
  thickness: number,
  dropHeight: number,
): void {
  if (trays.length > MAX_TRAYS) throw new RangeError(`At most ${MAX_TRAYS} feed trays can be rendered`);
  let requestedStock = 0;
  for (const tray of trays) {
    if (!tray.enabled && tray.coins.length > 0) throw new RangeError("Disabled feed trays cannot contain stock");
    requestedStock += tray.coins.length;
  }
  if (requestedStock > MAX_STOCK) throw new RangeError(`At most ${MAX_STOCK} stock coins can be rendered`);
  if (
    cabinet.trayGeometry === null ||
    cabinet.trayRadius !== radius ||
    cabinet.trayThickness !== thickness ||
    cabinet.trayDropHeight !== dropHeight
  ) {
    cabinet.trayGeometry = getFeedTrayGeometry(radius, thickness, dropHeight);
    cabinet.trayRadius = radius;
    cabinet.trayThickness = thickness;
    cabinet.trayDropHeight = dropHeight;
  }
  const geometry = cabinet.trayGeometry;

  cabinet.stockOrder.length = 0;
  for (const type of COIN_TYPES) cabinet.stockSymbols[type].count = 0;
  let stockCount = 0;

  for (let trayIndex = 0; trayIndex < cabinet.trays.length; trayIndex += 1) {
    const visual = cabinet.trays[trayIndex]!;
    const tray = trays[trayIndex];
    if (!tray) {
      visual.root.visible = false;
      continue;
    }
    visual.root.visible = true;
    visual.root.name = `feed-tray-${tray.id}`;
    if (visual.ownershipSource !== tray.source) {
      for (const accent of visual.ownershipAccents) accent.mesh.material = accent[tray.source];
      visual.ownershipSource = tray.source;
    }
    visual.root.position.set(tray.x, dropHeight, PLAYER_DROP_Z);
    visual.root.quaternion.copy(trayQuaternion);

    const floorThickness = geometry.floorThickness;
    const rearFloorLength = geometry.trapRearZ - geometry.localRearZ;
    fitBox(
      visual.rearFloor,
      [geometry.width, floorThickness, rearFloorLength],
      [0, geometry.localBaseY, geometry.localRearZ + rearFloorLength * 0.5],
    );

    const wallY = geometry.wallCenterY;
    const wallDepth = geometry.localFrontZ - geometry.localRearZ;
    const wallX = geometry.sideWallCenterX;
    fitBox(
      visual.leftWall,
      [geometry.wallThickness, geometry.lipHeight, wallDepth],
      [-wallX, wallY, geometry.localCenterZ],
    );
    fitBox(
      visual.rightWall,
      [geometry.wallThickness, geometry.lipHeight, wallDepth],
      [wallX, wallY, geometry.localCenterZ],
    );
    fitBox(
      visual.rearWall,
      [geometry.width, geometry.lipHeight, geometry.wallThickness],
      [0, wallY, geometry.localRearZ + geometry.wallThickness * 0.5],
    );

    updateFeedTrayHardwareFrame(visual, geometry, tray);

    const coverDepth = Math.max(geometry.wallThickness, geometry.coverFrontZ - geometry.localRearZ);
    fitBox(
      visual.cover,
      [geometry.width, geometry.coverThickness, coverDepth],
      [0, geometry.coverY, geometry.localRearZ + coverDepth * 0.5],
    );
    const markerLocalY = Math.max(
      geometry.localBaseY + 0.038,
      (MACHINE_GEOMETRY.pusherTop + 0.03 - dropHeight + geometry.localArrowZ * FEED_TRAY_SIN) /
        FEED_TRAY_COS,
    );
    visual.arrow.position.set(0, markerLocalY, geometry.localArrowZ);
    visual.arrow.scale.setScalar(geometry.arrowScale);
    visual.arrow.visible = tray.enabled;

    for (const coin of tray.coins) {
      cabinet.stockOrder.push(coin);
      stockPosition.set(coin.position.x, coin.position.y, coin.position.z);
      stockQuaternion.set(coin.rotation.x, coin.rotation.y, coin.rotation.z, coin.rotation.w);
      stockScale.set(coin.radius, coin.thickness, coin.radius);
      stockMatrix.compose(stockPosition, stockQuaternion, stockScale);
      cabinet.stockBodies.setMatrixAt(stockCount, stockMatrix);
      const colors = STOCK_COLORS[coin.type];
      cabinet.stockBodies.setColorAt(stockCount, colors.body);
      stockNormal.set(0, 1, 0).applyQuaternion(stockQuaternion);
      stockPosition.addScaledVector(stockNormal, coin.thickness * 0.5 + 0.003);
      stockScale.set(coin.radius, coin.radius, coin.radius);
      stockMatrix.compose(stockPosition, stockQuaternion, stockScale);
      cabinet.stockRims.setMatrixAt(stockCount, stockMatrix);
      cabinet.stockRims.setColorAt(stockCount, colors.face);
      const symbolSet = cabinet.stockSymbols[coin.type];
      for (let partIndex = 0; partIndex < symbolSet.meshes.length; partIndex += 1) {
        if (partIndex > 0) stockPosition.addScaledVector(stockNormal, 0.001);
        stockScale.setScalar(coin.radius * 0.72);
        stockMatrix.compose(stockPosition, stockQuaternion, stockScale);
        symbolSet.meshes[partIndex]!.setMatrixAt(symbolSet.count, stockMatrix);
      }
      symbolSet.count += 1;
      stockCount += 1;
    }
  }

  cabinet.stockBodies.count = stockCount;
  cabinet.stockRims.count = stockCount;
  cabinet.stockBodies.instanceMatrix.needsUpdate = true;
  cabinet.stockRims.instanceMatrix.needsUpdate = true;
  if (cabinet.stockBodies.instanceColor) cabinet.stockBodies.instanceColor.needsUpdate = true;
  if (cabinet.stockRims.instanceColor) cabinet.stockRims.instanceColor.needsUpdate = true;
  for (const type of COIN_TYPES) {
    const symbolSet = cabinet.stockSymbols[type];
    for (const mesh of symbolSet.meshes) {
      mesh.count = symbolSet.count;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }
}