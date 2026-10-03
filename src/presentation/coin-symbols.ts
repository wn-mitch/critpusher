import * as THREE from "three";
import { COIN_TYPES, type CoinType } from "../contracts";

export type CoinSymbolRole = "mark" | "cutout";

type SymbolCommand =
  | readonly ["M" | "L", number, number]
  | readonly ["Q", number, number, number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

interface SymbolPath {
  role: CoinSymbolRole;
  commands: readonly SymbolCommand[];
}

export interface CoinSymbolPart {
  readonly role: CoinSymbolRole;
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.MeshStandardMaterial;
}

export interface CoinSymbolResources {
  readonly parts: Readonly<Record<CoinType, readonly CoinSymbolPart[]>>;
  dispose(): void;
}

export interface CoinSymbolPalette {
  readonly body: number;
  readonly face: number;
  readonly mark: number;
  readonly cutout: number;
  readonly css: string;
}

export const COIN_SYMBOL_PALETTE: Readonly<Record<CoinType, CoinSymbolPalette>> = Object.freeze({
  gold: { body: 0xb67b32, face: 0xe1b763, mark: 0xffe7a0, cutout: 0x70441e, css: "#f0c86e" },
  diamond: { body: 0x4aaec8, face: 0x9fe8f2, mark: 0xedffff, cutout: 0x27677a, css: "#a8edf5" },
  sword: { body: 0x466c96, face: 0x7fa8d2, mark: 0xe1f0ff, cutout: 0x29445f, css: "#91b9df" },
  skull: { body: 0xb94a3b, face: 0xe06a45, mark: 0xffe8d8, cutout: 0x62291f, css: "#ec7958" },
  potion: { body: 0x397a57, face: 0x63c881, mark: 0xd8ffe4, cutout: 0x23543a, css: "#73d38e" },
  bomb: { body: 0x34383d, face: 0x62686f, mark: 0xffa64f, cutout: 0x252a2f, css: "#ee9442" },
});

const polygon = (role: CoinSymbolRole, points: readonly (readonly [number, number])[]): SymbolPath => ({
  role,
  commands: [
    ["M", points[0]![0], points[0]![1]],
    ...points.slice(1).map(([x, y]) => ["L", x, y] as const),
    ["Z"],
  ],
});

const rectangle = (role: CoinSymbolRole, x: number, y: number, width: number, height: number): SymbolPath =>
  polygon(role, [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]);

const circle = (role: CoinSymbolRole, x: number, y: number, radius: number): SymbolPath => {
  const k = radius * 0.5522847498;
  return {
    role,
    commands: [
      ["M", x + radius, y],
      ["C", x + radius, y + k, x + k, y + radius, x, y + radius],
      ["C", x - k, y + radius, x - radius, y + k, x - radius, y],
      ["C", x - radius, y - k, x - k, y - radius, x, y - radius],
      ["C", x + k, y - radius, x + radius, y - k, x + radius, y],
      ["Z"],
    ],
  };
};

const SYMBOL_PATHS: Readonly<Record<CoinType, readonly SymbolPath[]>> = Object.freeze({
  gold: [
    rectangle("mark", -4, -42, 8, 84),
    polygon("mark", [[-31, -30], [25, -30], [31, -18], [-17, -18], [-23, -8], [20, -2], [31, 15], [22, 31], [-29, 31], [-29, 19], [16, 19], [20, 11], [-22, 5], [-34, -13]]),
  ],
  diamond: [
    polygon("mark", [[0, -43], [40, -9], [31, -3], [0, -29], [-31, -3], [-40, -9]]),
    polygon("mark", [[40, -9], [8, 39], [0, 28], [29, -14]]),
    polygon("mark", [[-40, -9], [-8, 39], [0, 28], [-29, -14]]),
    polygon("mark", [[-8, 39], [8, 39], [0, 28]]),
  ],
  sword: [
    polygon("mark", [[0, -45], [10, -31], [6, 20], [0, 30], [-6, 20], [-10, -31]]),
    polygon("mark", [[-34, 16], [-6, 16], [-6, 28], [-34, 28], [-40, 22]]),
    polygon("mark", [[34, 16], [6, 16], [6, 28], [34, 28], [40, 22]]),
    rectangle("mark", -6, 27, 12, 16),
    circle("mark", 0, 44, 8),
  ],
  skull: [
    circle("mark", 0, -9, 34),
    polygon("mark", [[-25, 10], [25, 10], [25, 35], [14, 43], [-14, 43], [-25, 35]]),
    circle("cutout", -13, -10, 8),
    circle("cutout", 13, -10, 8),
    polygon("cutout", [[0, 1], [-6, 13], [6, 13]]),
    rectangle("cutout", -16, 27, 7, 16),
    rectangle("cutout", -3, 27, 6, 16),
    rectangle("cutout", 9, 27, 7, 16),
  ],
  potion: [
    rectangle("mark", -14, -43, 28, 13),
    polygon("mark", [[-10, -30], [10, -30], [12, -20], [27, -7], [31, 31], [21, 42], [-21, 42], [-31, 31], [-27, -7], [-12, -20]]),
    rectangle("cutout", -6, -13, 12, 40),
    rectangle("cutout", -20, 1, 40, 12),
  ],
  bomb: [
    circle("mark", -4, 7, 34),
    polygon("mark", [[17, -21], [25, -31], [34, -28], [27, -15]]),
    polygon("mark", [[32, -29], [42, -42], [47, -36], [38, -24]]),
    polygon("mark", [[43, -47], [48, -36], [38, -40]]),
    circle("cutout", -16, -6, 6),
  ],
});

function pathMarkup(path: SymbolPath): string {
  const d = path.commands.map((command) => command.join(" ")).join(" ");
  const className = path.role === "mark" ? "coin-symbol__mark" : "coin-symbol__cutout";
  const fill = path.role === "mark" ? "currentColor" : "var(--coin-symbol-cutout, #211713)";
  return `<path class="${className}" fill="${fill}" d="${d}"/>`;
}

/** The DOM legend and WebGL caps are generated from the same vector path table. */
export function coinSymbolMarkup(type: CoinType): string {
  return `<svg class="coin-symbol coin-symbol--${type}" viewBox="-50 -50 100 100" aria-hidden="true" focusable="false" style="color:${COIN_SYMBOL_PALETTE[type].css}">${SYMBOL_PATHS[type].map(pathMarkup).join("")}</svg>`;
}

function makeShape(path: SymbolPath): THREE.Shape {
  const shape = new THREE.Shape();
  const scale = 1 / 60;
  for (const command of path.commands) {
    switch (command[0]) {
      case "M":
        shape.moveTo(command[1] * scale, -command[2] * scale);
        break;
      case "L":
        shape.lineTo(command[1] * scale, -command[2] * scale);
        break;
      case "Q":
        shape.quadraticCurveTo(command[1] * scale, -command[2] * scale, command[3] * scale, -command[4] * scale);
        break;
      case "C":
        shape.bezierCurveTo(command[1] * scale, -command[2] * scale, command[3] * scale, -command[4] * scale, command[5] * scale, -command[6] * scale);
        break;
      case "Z":
        shape.closePath();
        break;
    }
  }
  return shape;
}

export function createCoinSymbolResources(): CoinSymbolResources {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.MeshStandardMaterial[] = [];
  const parts = {} as Record<CoinType, readonly CoinSymbolPart[]>;
  for (const type of COIN_TYPES) {
    const byRole: Record<CoinSymbolRole, THREE.Shape[]> = { mark: [], cutout: [] };
    for (const path of SYMBOL_PATHS[type]) byRole[path.role].push(makeShape(path));
    const typeParts: CoinSymbolPart[] = [];
    for (const role of ["mark", "cutout"] as const) {
      if (byRole[role].length === 0) continue;
      const geometry = new THREE.ShapeGeometry(byRole[role], 8);
      geometry.rotateX(Math.PI / 2);
      const material = new THREE.MeshStandardMaterial({
        color: COIN_SYMBOL_PALETTE[type][role],
        roughness: role === "mark" ? 0.24 : 0.42,
        metalness: role === "mark" ? 0.64 : 0.22,
        side: THREE.DoubleSide,
      });
      geometries.push(geometry);
      materials.push(material);
      typeParts.push({ role, geometry, material });
    }
    parts[type] = typeParts;
  }
  let disposed = false;
  return {
    parts,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
