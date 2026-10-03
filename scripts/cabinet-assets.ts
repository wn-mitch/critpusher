import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getFeedTrayGeometry } from "../src/feed-geometry";
import { MACHINE_GEOMETRY } from "../src/machine-geometry";
import { DEFAULT_TUNING } from "../src/simulation/config";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_BLENDER = "/Applications/Blender.app/Contents/MacOS/Blender";
const BLEND_PATH = join(PROJECT_ROOT, "assets/cabinet.blend");
const GLB_PATH = join(PROJECT_ROOT, "src/assets/cabinet.glb");
const PYTHON_SCRIPT = join(PROJECT_ROOT, "scripts/build-cabinet.py");

const mode = process.argv[2] ?? "build";
if (mode !== "build" && mode !== "check") {
  throw new Error(`Unknown cabinet asset command: ${mode}. Expected build or check.`);
}

function executable(candidate: string): boolean {
  if (candidate.includes("/")) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  return spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0;
}

function findBlender(): string {
  const override = process.env.BLENDER_BIN;
  if (override) {
    if (!executable(override)) throw new Error(`BLENDER_BIN is not executable: ${override}`);
    return override;
  }
  if (executable("blender")) return "blender";
  if (executable(DEFAULT_BLENDER)) return DEFAULT_BLENDER;
  throw new Error(
    `Blender was not found on PATH or at ${DEFAULT_BLENDER}. Set BLENDER_BIN to the Blender executable.`,
  );
}

const tuning = DEFAULT_TUNING;
const tray = getFeedTrayGeometry(tuning.radius, tuning.thickness, tuning.dropHeight);
const shelfDepth = tuning.shelfFront - MACHINE_GEOMETRY.shelfRearZ;
const shelfCenterZ = MACHINE_GEOMETRY.shelfRearZ + shelfDepth / 2;
const trapdoorLength = tray.trapFrontZ - tray.trapRearZ;
const frontFloorLength = tray.localFrontZ - tray.trapFrontZ;
const rearFloorLength = tray.trapRearZ - tray.localRearZ;
const coverDepth = Math.max(tray.wallThickness, tray.coverFrontZ - tray.localRearZ);
const openDrop = Math.max(0.22, trapdoorLength / 2 + tray.floorThickness + 0.08);

const spec = {
  version: 1,
  coordinates: "+Y up, +Z toward collection",
  tuning: {
    radius: tuning.radius,
    thickness: tuning.thickness,
    shelfFront: tuning.shelfFront,
    dropHeight: tuning.dropHeight,
  },
  machine: MACHINE_GEOMETRY,
  shelf: {
    depth: shelfDepth,
    centerZ: shelfCenterZ,
    surfaceDepth: shelfDepth - 0.08,
    surfaceCenterZ: MACHINE_GEOMETRY.shelfRearZ + 0.04 + (shelfDepth - 0.08) / 2,
  },
  tray: {
    ...tray,
    rearFloorLength,
    trapdoorLength,
    frontFloorLength,
    coverDepth,
    rearFloorCenterZ: tray.localRearZ + rearFloorLength / 2,
    trapdoorCenterZ: (tray.trapRearZ + tray.trapFrontZ) / 2,
    frontFloorCenterZ: tray.trapFrontZ + frontFloorLength / 2,
    coverCenterZ: tray.localRearZ + coverDepth / 2,
    open: {
      trapdoorPosition: [0, tray.localBaseY - openDrop, tray.trapRearZ - trapdoorLength / 2],
      trapdoorRotationX: Math.PI / 2,
      frontFloorPosition: [0, tray.localBaseY - openDrop, tray.trapFrontZ + frontFloorLength / 2],
      frontFloorRotationX: Math.PI / 2,
      frontStopPosition: [0, tray.wallCenterY - tray.lipHeight / 2 - openDrop, tray.frontStopZ],
      frontStopRotationX: Math.PI / 2,
    },
    holdbacks: Array.from({ length: 4 }, (_, index) => {
      const z = -(index + 1) * tray.spacing + tray.previewRadius + 0.08;
      return {
        slot: index + 1,
        size: [tray.width + 0.04, 0.04, 0.05],
        position: [0, tray.wallCenterY, z],
        openPosition: [tray.width + 0.10, tray.wallCenterY, z],
      };
    }),
  },
  collection: {
    bodySize: [10.2, 0.58, 1.78],
    bodyPosition: [0, -1.25, tuning.shelfFront + 0.71],
    bedSize: [9.8, 0.1, 1.52],
    bedPosition: [0, -0.93, tuning.shelfFront + 0.68],
    rearLipSize: [10.25, 0.26, 0.18],
    rearLipPosition: [0, -0.73, tuning.shelfFront],
    frontApronSize: [10.6, 0.34, 0.28],
    frontApronPosition: [0, -1.62, tuning.shelfFront + 0.2],
    sideSize: [0.28, 0.38, 1.72],
    sideZ: tuning.shelfFront + 0.69,
  },
  shell: {
    frontZ: tuning.shelfFront + 0.75,
    rearZ: -8.1,
    postWidth: 0.72,
    postCenterX: 5.55,
    postBottom: -2.81,
    postTop: 4.85,
    baseSize: [11.25, 0.62, 9.05],
    basePosition: [0, -2.52, 0],
  },
  materials: {
    teal: "#246a68",
    tealDark: "#153f40",
    tealEdge: "#35817c",
    recess: "#211f22",
    brass: "#b58a46",
    brassBright: "#d2aa62",
    steel: "#8c9899",
    steelDark: "#465153",
    glass: "#8fb9b8",
  },
  requiredModules: [
    "cabinet_shell",
    "playfield",
    "pusher",
    "collection_tray",
    "feed_rail",
    "feed_gate",
    "feed_cover",
    "combo_bell",
  ],
  budgets: { triangles: 20_000, glbBytes: 1_000_000, tolerance: 0.01 },
};

const temporary = mkdtempSync(join(tmpdir(), "critpusher-cabinet-"));
const specPath = join(temporary, "cabinet-spec.json");
writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);

try {
  const blender = findBlender();
  const result = spawnSync(
    blender,
    [
      "--background",
      "--python",
      PYTHON_SCRIPT,
      "--",
      "--mode",
      mode,
      "--spec",
      specPath,
      "--blend",
      BLEND_PATH,
      "--glb",
      GLB_PATH,
    ],
    { cwd: PROJECT_ROOT, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Blender cabinet ${mode} failed with status ${result.status}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
