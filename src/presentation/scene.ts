import * as THREE from "three";
import { PLAYER_DROP_Z } from "../simulation/config";
import type { ChuteDrop } from "../chutes";

const WALL_HEIGHT = 4.5;
const WALL_CENTER_Y = WALL_HEIGHT / 2;
const SIDE_WALL_X = 5.2;
const REAR_WALL_Z = -4.25;
const PUSHER_WIDTH = 10.4;
const PUSHER_HEIGHT = 0.6;
const PUSHER_DEPTH = 6.4;
const PUSHER_CENTER_Y = PUSHER_HEIGHT / 2;
const PUSHER_CENTER_Z = -2.2;
const CHUTE_GEOMETRY_BASE_Y = 3.5;
const SHELF_REAR_Z = -4;

export interface CabinetScene {
  root: THREE.Group;
  pusher: THREE.Group;
  resources: {
    geometries: THREE.BufferGeometry[];
    materials: THREE.Material[];
  };
  guides: THREE.Group[];
  guideCoins: THREE.Mesh[][];
}

function box(
  root: THREE.Object3D,
  geometry: THREE.BoxGeometry,
  material: THREE.Material,
  size: [number, number, number],
  position: [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(...size);
  mesh.position.set(...position);
  root.add(mesh);
  return mesh;
}

export function createCabinet(shelfFront: number): CabinetScene {
  const root = new THREE.Group();
  root.name = "painted-arcade-cabinet";
  const shelfDepth = shelfFront - SHELF_REAR_Z;
  const shelfCenterZ = SHELF_REAR_Z + shelfDepth / 2;
  const shelfTopDepth = Math.max(0.01, shelfDepth - 0.08);
  const shelfTopCenterZ = SHELF_REAR_Z + 0.04 + shelfTopDepth / 2;
  const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  const geometries: THREE.BufferGeometry[] = [boxGeometry];
  const materials: THREE.Material[] = [];
  const makeMaterial = (params: THREE.MeshStandardMaterialParameters) => {
    const material = new THREE.MeshStandardMaterial(params);
    materials.push(material);
    return material;
  };

  const paint = makeMaterial({
    color: 0x9a3425,
    roughness: 0.52,
    metalness: 0.08,
  });
  const paintDark = makeMaterial({
    color: 0x55231e,
    roughness: 0.62,
    metalness: 0.08,
  });
  const trim = makeMaterial({
    color: 0xd39a43,
    roughness: 0.35,
    metalness: 0.52,
  });
  const interior = makeMaterial({
    color: 0x774f32,
    roughness: 0.74,
    metalness: 0.04,
  });
  const shelf = makeMaterial({
    color: 0xc98d4c,
    roughness: 0.56,
    metalness: 0.18,
  });
  const brightShelf = makeMaterial({
    color: 0xe4bb6a,
    roughness: 0.42,
    metalness: 0.22,
  });
  const steel = makeMaterial({
    color: 0x8e9891,
    roughness: 0.3,
    metalness: 0.76,
  });
  const steelDark = makeMaterial({
    color: 0x3f4948,
    roughness: 0.42,
    metalness: 0.72,
  });
  const glass = makeMaterial({
    color: 0x9ec7c3,
    roughness: 0.16,
    metalness: 0.05,
    transparent: true,
    opacity: 0.13,
    depthWrite: false,
  });

  const cabinet = new THREE.Group();
  root.add(cabinet);
  box(cabinet, boxGeometry, paint, [0.72, 4.8, 9.5], [-5.55, 1.8, 0]);
  box(cabinet, boxGeometry, paint, [0.72, 4.8, 9.5], [5.55, 1.8, 0]);
  box(cabinet, boxGeometry, paint, [11.8, 0.4, 1.35], [0, 4.28, -3.6]);
  box(cabinet, boxGeometry, paintDark, [11.25, 0.62, 9.05], [0, -2.52, 0]);
  box(
    cabinet,
    boxGeometry,
    paintDark,
    [10.4, WALL_HEIGHT, 0.4],
    [0, WALL_CENTER_Y, REAR_WALL_Z],
  );
  box(
    cabinet,
    boxGeometry,
    trim,
    [0.16, 4.15, 0.13],
    [-5.1, 1.8, shelfFront + 0.24],
  );
  box(
    cabinet,
    boxGeometry,
    trim,
    [0.16, 4.15, 0.13],
    [5.1, 1.8, shelfFront + 0.24],
  );

  const playfield = new THREE.Group();
  root.add(playfield);
  box(
    playfield,
    boxGeometry,
    shelf,
    [10, 0.2, shelfDepth],
    [0, -0.1, shelfCenterZ],
  );
  box(
    playfield,
    boxGeometry,
    brightShelf,
    [9.72, 0.004, shelfTopDepth],
    [0, 0.002, shelfTopCenterZ],
  );
  box(
    playfield,
    boxGeometry,
    glass,
    [0.4, WALL_HEIGHT, shelfDepth],
    [-SIDE_WALL_X, WALL_CENTER_Y, shelfCenterZ],
  );
  box(
    playfield,
    boxGeometry,
    glass,
    [0.4, WALL_HEIGHT, shelfDepth],
    [SIDE_WALL_X, WALL_CENTER_Y, shelfCenterZ],
  );

  const tray = new THREE.Group();
  root.add(tray);
  box(
    tray,
    boxGeometry,
    paintDark,
    [10.2, 0.58, 1.78],
    [0, -1.25, shelfFront + 0.71],
  );
  box(
    tray,
    boxGeometry,
    brightShelf,
    [9.8, 0.1, 1.52],
    [0, -0.93, shelfFront + 0.68],
  );
  box(tray, boxGeometry, trim, [10.25, 0.26, 0.18], [0, -0.73, shelfFront]);
  box(
    tray,
    boxGeometry,
    paint,
    [10.6, 0.34, 0.28],
    [0, -1.62, shelfFront + 0.2],
  );
  box(
    tray,
    boxGeometry,
    trim,
    [0.28, 0.38, 1.72],
    [-5.06, -1.26, shelfFront + 0.69],
  );
  box(
    tray,
    boxGeometry,
    trim,
    [0.28, 0.38, 1.72],
    [5.06, -1.26, shelfFront + 0.69],
  );

  const pusher = new THREE.Group();
  pusher.name = "steel-pusher";
  root.add(pusher);
  box(
    pusher,
    boxGeometry,
    steel,
    [PUSHER_WIDTH, PUSHER_HEIGHT, PUSHER_DEPTH],
    [0, PUSHER_CENTER_Y, PUSHER_CENTER_Z],
  );
  box(
    pusher,
    boxGeometry,
    steelDark,
    [PUSHER_WIDTH, 0.1, 0.06],
    [0, 0.52, 0.97],
  );
  pusher.position.z = -3;

  const chute = new THREE.Group();
  chute.name = "moving-drop-guide";
  root.add(chute);
  box(
    chute,
    boxGeometry,
    steelDark,
    [0.62, 0.16, 1.28],
    [0, 3.45, PLAYER_DROP_Z],
  );
  box(
    chute,
    boxGeometry,
    trim,
    [0.14, 0.54, 1.36],
    [-0.43, 3.27, PLAYER_DROP_Z],
  );
  box(
    chute,
    boxGeometry,
    trim,
    [0.14, 0.54, 1.36],
    [0.43, 3.27, PLAYER_DROP_Z],
  );
  box(chute, boxGeometry, steel, [0.9, 0.1, 0.2], [0, 3.72, PLAYER_DROP_Z]);
  const guideCoins: THREE.Mesh[][] = [];
  const guideGold = makeMaterial({
    color: 0xd39a43,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const guideEnemy = makeMaterial({
    color: 0xb94a3b,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const coinGeometry = new THREE.CylinderGeometry(1, 1, 1, 24);
  geometries.push(coinGeometry);
  const guides: THREE.Group[] = [chute];
  const playerCoins: THREE.Mesh[] = [];
  for (let index = 0; index < 3; index += 1) {
    const coin = new THREE.Mesh(coinGeometry, guideGold);
    coin.visible = false;
    chute.add(coin);
    playerCoins.push(coin);
  }
  guideCoins.push(playerCoins);
  for (let guideIndex = 1; guideIndex <= 4; guideIndex += 1) {
    const guide = new THREE.Group();
    guide.visible = false;
    guide.name = `enemy-drop-guide-${guideIndex}`;
    root.add(guide);
    box(
      guide,
      boxGeometry,
      steelDark,
      [0.62, 0.16, 1.28],
      [0, 3.45, PLAYER_DROP_Z],
    );
    box(
      guide,
      boxGeometry,
      paint,
      [0.14, 0.54, 1.36],
      [-0.43, 3.27, PLAYER_DROP_Z],
    );
    box(
      guide,
      boxGeometry,
      paint,
      [0.14, 0.54, 1.36],
      [0.43, 3.27, PLAYER_DROP_Z],
    );
    box(guide, boxGeometry, steel, [0.9, 0.1, 0.2], [0, 3.72, PLAYER_DROP_Z]);
    const preview: THREE.Mesh[] = [];
    for (let coinIndex = 0; coinIndex < 3; coinIndex += 1) {
      const coin = new THREE.Mesh(coinGeometry, guideEnemy);
      coin.visible = false;
      guide.add(coin);
      preview.push(coin);
    }
    guides.push(guide);
    guideCoins.push(preview);
  }
  return {
    root,
    pusher,
    guides,
    guideCoins,
    resources: { geometries, materials },
  };
}

export function updateChuteGuides(
  cabinet: CabinetScene,
  chutes: readonly ChuteDrop[],
  radius: number,
  thickness: number,
  dropHeight: number,
): void {
  const width = Math.min(0.9, radius * 2);
  for (
    let guideIndex = 0;
    guideIndex < cabinet.guides.length;
    guideIndex += 1
  ) {
    const guide = cabinet.guides[guideIndex]!;
    const drop = chutes[guideIndex];
    if (!drop) {
      guide.visible = false;
      continue;
    }
    guide.visible = true;
    guide.position.set(drop.x, dropHeight - CHUTE_GEOMETRY_BASE_Y, 0);
    guide.scale.x = width;
    const previews = cabinet.guideCoins[guideIndex]!;
    for (let coinIndex = 0; coinIndex < previews.length; coinIndex += 1) {
      const coin = previews[coinIndex]!;
      coin.visible = coinIndex < drop.count;
      coin.position.set(
        0,
        CHUTE_GEOMETRY_BASE_Y + coinIndex * (thickness + 0.02),
        PLAYER_DROP_Z,
      );
      coin.scale.set(radius / width, thickness, radius);
    }
  }
}
