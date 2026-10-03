import * as THREE from "three";
import type { CoinEvent } from "../contracts";
import type { CombatStepResult } from "../combat/types";

export interface CollectionEffects {
  collect(events: readonly CoinEvent[], reducedMotion: boolean, combat?: CombatStepResult): void;
  update(dt: number, reducedMotion: boolean, shelfFront: number): void;
  reset(): void;
  dispose(): void;
}

const MAX_PARTICLES = 96;
const MAX_BLASTS = 16;
const SPARKS_PER_BLAST = 12;
const MAX_BLAST_SPARKS = MAX_BLASTS * SPARKS_PER_BLAST;
const BLAST_LIFE = 0.85;
const CUE_LIFE = 0.9;
const CUE_XS = [-3.15, -1.05, 1.05, 3.15] as const;

interface AmountCue {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  label: string;
  color: string;
  value: number;
  life: number;
  sign: "+" | "-";
}

export function createCollectionEffects(root: THREE.Object3D): CollectionEffects {
  const positions = new Float32Array(MAX_PARTICLES * 3);
  const velocities = new Float32Array(MAX_PARTICLES * 3);
  const lives = new Float32Array(MAX_PARTICLES);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute("position", positionAttribute);
  geometry.setDrawRange(0, 0);
  const material = new THREE.PointsMaterial({
    color: 0xf4cf79,
    size: 0.13,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  root.add(points);

  const blastSparkPositions = new Float32Array(MAX_BLAST_SPARKS * 3);
  const blastSparkVelocities = new Float32Array(MAX_BLAST_SPARKS * 3);
  const blastSparkLives = new Float32Array(MAX_BLAST_SPARKS);
  const blastSparkGeometry = new THREE.BufferGeometry();
  const blastSparkPositionAttribute = new THREE.BufferAttribute(blastSparkPositions, 3);
  blastSparkGeometry.setAttribute("position", blastSparkPositionAttribute);
  blastSparkGeometry.setDrawRange(0, 0);
  const blastSparkMaterial = new THREE.PointsMaterial({
    color: 0xffdf78,
    size: 0.19,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const blastSparks = new THREE.Points(blastSparkGeometry, blastSparkMaterial);
  blastSparks.frustumCulled = false;
  root.add(blastSparks);

  const shockwaveGeometry = new THREE.TorusGeometry(1, 0.105, 10, 48);
  shockwaveGeometry.rotateX(Math.PI / 2);
  const shockwaveMaterial = new THREE.MeshBasicMaterial({
    color: 0xff8a3d,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const shockwaves = new THREE.InstancedMesh(shockwaveGeometry, shockwaveMaterial, MAX_BLASTS);
  shockwaves.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  shockwaves.frustumCulled = false;
  shockwaves.count = 0;
  root.add(shockwaves);

  const coreGeometry = new THREE.IcosahedronGeometry(1, 1);
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff2b0,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const blastCores = new THREE.InstancedMesh(coreGeometry, coreMaterial, MAX_BLASTS);
  blastCores.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  blastCores.frustumCulled = false;
  blastCores.count = 0;
  root.add(blastCores);

  const blastPositions = Array.from({ length: MAX_BLASTS }, () => new THREE.Vector3());
  const blastLives = new Float32Array(MAX_BLASTS);
  const blastMatrix = new THREE.Matrix4();
  const blastScale = new THREE.Vector3();
  const blastQuaternion = new THREE.Quaternion();

  function makeCue(label: string, color: string, sign: "+" | "-"): AmountCue {
    const canvas = document.createElement("canvas");
    canvas.width = 256;
    canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas text rendering is unavailable");
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const spriteMaterial = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, toneMapped: false });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.visible = false;
    sprite.scale.set(2.5, 0.62, 1);
    root.add(sprite);
    return { sprite, texture, canvas, context, label, color, value: 0, life: 0, sign };
  }

  const cues = [
    makeCue("OUT", "#d8efff", "-"),
    makeCue("IN", "#ffd9cd", "-"),
    makeCue("HEAL", "#d7ffe2", "+"),
    makeCue("COIN", "#ffe29a", "+"),
  ] as const;

  function drawCue(cue: AmountCue): void {
    const { context, canvas } = cue;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(27, 18, 15, 0.9)";
    context.fillRect(2, 5, canvas.width - 4, canvas.height - 10);
    context.strokeStyle = cue.color;
    context.lineWidth = 3;
    context.strokeRect(3.5, 6.5, canvas.width - 7, canvas.height - 13);
    context.fillStyle = cue.color;
    context.font = "700 28px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(`${cue.label} ${cue.sign}${cue.value}`, canvas.width / 2, canvas.height / 2 + 1);
    cue.texture.needsUpdate = true;
  }

  function boundedValue(values: Float32Array, index: number): number {
    if (index < 0 || index >= values.length) throw new Error("Effect index out of bounds");
    const value = values[index];
    if (value === undefined) throw new Error("Effect index out of bounds");
    return value;
  }

  let count = 0;
  let blastCount = 0;
  let blastSparkCount = 0;
  let disposed = false;

  function addParticle(event: CoinEvent, variant: number): void {
    if (count >= MAX_PARTICLES) return;
    const index = count;
    const offset = index * 3;
    const seed = (event.id * 17 + variant * 31) | 0;
    positions[offset] = event.position.x;
    positions[offset + 1] = event.position.y + 0.04;
    positions[offset + 2] = event.position.z;
    velocities[offset] = ((seed % 11) - 5) * 0.18;
    velocities[offset + 1] = 1.05 + (seed % 7) * 0.13;
    velocities[offset + 2] = 0.2 + (seed % 5) * 0.08;
    lives[index] = 0.42 + (seed % 5) * 0.045;
    count += 1;
  }

  function addBlast(event: CoinEvent): void {
    let index = blastCount;
    if (blastCount < MAX_BLASTS) {
      blastCount += 1;
    } else {
      index = 0;
      for (let candidate = 1; candidate < blastCount; candidate += 1) {
        if (blastLives[candidate]! < blastLives[index]!) index = candidate;
      }
    }
    blastPositions[index]!.set(event.position.x, event.position.y, event.position.z);
    blastLives[index] = BLAST_LIFE;

    for (
      let variant = 0;
      variant < SPARKS_PER_BLAST && blastSparkCount < MAX_BLAST_SPARKS;
      variant += 1
    ) {
      const sparkIndex = blastSparkCount;
      const offset = sparkIndex * 3;
      const seed = (event.id * 29 + variant * 47) >>> 0;
      const angle =
        ((variant + (seed % SPARKS_PER_BLAST) / SPARKS_PER_BLAST) /
          SPARKS_PER_BLAST) *
        Math.PI *
        2;
      const directionX = Math.cos(angle);
      const directionZ = Math.sin(angle);
      const initialSpread = 0.16 + (seed % 3) * 0.055;
      const radialSpeed = 2.4 + (seed % 7) * 0.16;
      blastSparkPositions[offset] = event.position.x + directionX * initialSpread;
      blastSparkPositions[offset + 1] =
        event.position.y + 0.04 + ((seed >>> 4) % 3) * 0.035;
      blastSparkPositions[offset + 2] =
        event.position.z + directionZ * initialSpread;
      blastSparkVelocities[offset] = directionX * radialSpeed;
      blastSparkVelocities[offset + 1] = 1.1 + ((seed >>> 3) % 6) * 0.18;
      blastSparkVelocities[offset + 2] = directionZ * radialSpeed;
      blastSparkLives[sparkIndex] = 0.5 + ((seed >>> 6) % 5) * 0.045;
      blastSparkCount += 1;
    }
    blastSparkGeometry.setDrawRange(0, blastSparkCount);
    blastSparkPositionAttribute.needsUpdate = true;
  }

  function addCue(cue: AmountCue, amount: number): void {
    if (amount <= 0) return;
    cue.value = cue.life > 0 ? cue.value + amount : amount;
    cue.life = CUE_LIFE;
    cue.sprite.visible = true;
    drawCue(cue);
  }

  function collect(events: readonly CoinEvent[], reducedMotion: boolean, combat?: CombatStepResult): void {
    if (disposed) return;
    for (const event of events) {
      if (event.kind === "detonated") {
        addBlast(event);
      } else if (event.kind === "collected" && !reducedMotion) {
        for (let variant = 0; variant < 6; variant += 1) addParticle(event, variant);
      }
    }
    geometry.setDrawRange(0, count);
    positionAttribute.needsUpdate = true;
    if (!combat) return;
    addCue(cues[0], combat.delta.swordDamage + combat.delta.bombDamageToEnemy);
    addCue(cues[1], combat.delta.skullDamage + combat.delta.bombDamageToPlayer);
    addCue(cues[2], combat.delta.healingUsed);
    addCue(cues[3], combat.delta.currencyGained);
  }

  function updateParticles(dt: number, reducedMotion: boolean): void {
    if (reducedMotion) {
      count = 0;
      geometry.setDrawRange(0, 0);
      return;
    }
    let index = 0;
    while (index < count) {
      const life = boundedValue(lives, index) - dt;
      if (life <= 0) {
        const last = count - 1;
        if (index !== last) {
          const destination = index * 3;
          const source = last * 3;
          for (let axis = 0; axis < 3; axis += 1) {
            positions[destination + axis] = boundedValue(positions, source + axis);
            velocities[destination + axis] = boundedValue(velocities, source + axis);
          }
          lives[index] = boundedValue(lives, last);
        }
        count -= 1;
        continue;
      }
      lives[index] = life;
      const offset = index * 3;
      positions[offset] = boundedValue(positions, offset) + boundedValue(velocities, offset) * dt;
      positions[offset + 1] = boundedValue(positions, offset + 1) + boundedValue(velocities, offset + 1) * dt;
      positions[offset + 2] = boundedValue(positions, offset + 2) + boundedValue(velocities, offset + 2) * dt;
      velocities[offset + 1] = boundedValue(velocities, offset + 1) - 2.4 * dt;
      index += 1;
    }
    geometry.setDrawRange(0, count);
    positionAttribute.needsUpdate = count > 0;
  }

  function updateBlastSparks(dt: number, reducedMotion: boolean): void {
    let index = 0;
    while (index < blastSparkCount) {
      const life = boundedValue(blastSparkLives, index) - dt;
      if (life <= 0) {
        const last = blastSparkCount - 1;
        if (index !== last) {
          const destination = index * 3;
          const source = last * 3;
          for (let axis = 0; axis < 3; axis += 1) {
            blastSparkPositions[destination + axis] = boundedValue(
              blastSparkPositions,
              source + axis,
            );
            blastSparkVelocities[destination + axis] = boundedValue(
              blastSparkVelocities,
              source + axis,
            );
          }
          blastSparkLives[index] = boundedValue(blastSparkLives, last);
        }
        blastSparkCount -= 1;
        continue;
      }
      blastSparkLives[index] = life;
      if (!reducedMotion) {
        const offset = index * 3;
        blastSparkPositions[offset] =
          boundedValue(blastSparkPositions, offset) +
          boundedValue(blastSparkVelocities, offset) * dt;
        blastSparkPositions[offset + 1] =
          boundedValue(blastSparkPositions, offset + 1) +
          boundedValue(blastSparkVelocities, offset + 1) * dt;
        blastSparkPositions[offset + 2] =
          boundedValue(blastSparkPositions, offset + 2) +
          boundedValue(blastSparkVelocities, offset + 2) * dt;
        blastSparkVelocities[offset + 1] =
          boundedValue(blastSparkVelocities, offset + 1) - 3.4 * dt;
      }
      index += 1;
    }
    blastSparkGeometry.setDrawRange(0, blastSparkCount);
    blastSparkPositionAttribute.needsUpdate = blastSparkCount > 0;
  }

  function updateBlasts(dt: number, reducedMotion: boolean): void {
    let index = 0;
    while (index < blastCount) {
      blastLives[index] = boundedValue(blastLives, index) - dt;
      if (blastLives[index]! <= 0) {
        const last = blastCount - 1;
        if (index !== last) {
          blastLives[index] = boundedValue(blastLives, last);
          blastPositions[index]!.copy(blastPositions[last]!);
        }
        blastCount -= 1;
        continue;
      }
      const progress = 1 - blastLives[index]! / BLAST_LIFE;
      const shockwaveScale = reducedMotion ? 1.35 : 0.35 + progress * 2.7;
      blastScale.set(shockwaveScale, shockwaveScale, shockwaveScale);
      blastMatrix.compose(blastPositions[index]!, blastQuaternion, blastScale);
      shockwaves.setMatrixAt(index, blastMatrix);

      const coreScale = reducedMotion
        ? 0.58
        : 0.34 + Math.sin(Math.min(1, progress * 1.4) * Math.PI) * 0.62;
      blastScale.set(coreScale, coreScale, coreScale);
      blastMatrix.compose(blastPositions[index]!, blastQuaternion, blastScale);
      blastCores.setMatrixAt(index, blastMatrix);
      index += 1;
    }
    shockwaves.count = blastCount;
    blastCores.count = blastCount;
    shockwaves.instanceMatrix.needsUpdate = blastCount > 0;
    blastCores.instanceMatrix.needsUpdate = blastCount > 0;
  }

  function update(dt: number, reducedMotion: boolean, shelfFront: number): void {
    if (disposed) return;
    const safeDt = Math.min(0.05, Math.max(0, dt));
    updateParticles(safeDt, reducedMotion);
    updateBlastSparks(safeDt, reducedMotion);
    updateBlasts(safeDt, reducedMotion);
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index]!;
      if (cue.life <= 0) continue;
      cue.life = Math.max(0, cue.life - safeDt);
      cue.sprite.visible = cue.life > 0;
      cue.sprite.position.set(CUE_XS[index]!, 0.3, shelfFront + 0.64);
      cue.sprite.material.opacity = reducedMotion ? 1 : Math.min(1, cue.life * 3);
    }
  }

  function reset(): void {
    if (disposed) return;
    count = 0;
    blastCount = 0;
    blastSparkCount = 0;
    geometry.setDrawRange(0, 0);
    blastSparkGeometry.setDrawRange(0, 0);
    shockwaves.count = 0;
    blastCores.count = 0;
    for (const cue of cues) {
      cue.value = 0;
      cue.life = 0;
      cue.sprite.visible = false;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.remove(points, blastSparks, shockwaves, blastCores);
    geometry.dispose();
    material.dispose();
    blastSparkGeometry.dispose();
    blastSparkMaterial.dispose();
    shockwaves.dispose();
    shockwaveGeometry.dispose();
    shockwaveMaterial.dispose();
    blastCores.dispose();
    coreGeometry.dispose();
    coreMaterial.dispose();
    for (const cue of cues) {
      root.remove(cue.sprite);
      cue.texture.dispose();
      cue.sprite.material.dispose();
    }
  }

  return { collect, update, reset, dispose };
}
