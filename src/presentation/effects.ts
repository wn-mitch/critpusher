import * as THREE from "three";
import type { CollectionEvent } from "../contracts";

export interface CollectionEffects {
  collect(events: CollectionEvent[], reducedMotion: boolean): void;
  update(dt: number, reducedMotion: boolean): void;
  dispose(): void;
}

const MAX_PARTICLES = 96;

export function createCollectionEffects(
  root: THREE.Object3D,
): CollectionEffects {
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
  function boundedValue(values: Float32Array, index: number): number {
    if (index < 0 || index >= values.length) {
      throw new Error("Particle index out of bounds");
    }
    const value = values[index];
    if (value === undefined) {
      throw new Error("Particle index out of bounds");
    }
    return value;
  }

  let count = 0;
  let disposed = false;

  function addParticle(event: CollectionEvent, variant: number): void {
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

  function collect(events: CollectionEvent[], reducedMotion: boolean): void {
    if (disposed || reducedMotion) return;
    for (const event of events) {
      if (event.kind !== "collected") continue;
      for (let variant = 0; variant < 6; variant += 1)
        addParticle(event, variant);
    }
    geometry.setDrawRange(0, count);
    positionAttribute.needsUpdate = true;
  }

  function update(dt: number, reducedMotion: boolean): void {
    if (disposed) return;
    if (reducedMotion) {
      count = 0;
      geometry.setDrawRange(0, 0);
      return;
    }
    const safeDt = Math.min(0.05, Math.max(0, dt));
    let index = 0;
    while (index < count) {
      const life = boundedValue(lives, index) - safeDt;
      if (life <= 0) {
        const last = count - 1;
        if (index !== last) {
          const destination = index * 3;
          const source = last * 3;
          positions[destination] = boundedValue(positions, source);
          positions[destination + 1] = boundedValue(positions, source + 1);
          positions[destination + 2] = boundedValue(positions, source + 2);
          velocities[destination] = boundedValue(velocities, source);
          velocities[destination + 1] = boundedValue(velocities, source + 1);
          velocities[destination + 2] = boundedValue(velocities, source + 2);
          lives[index] = boundedValue(lives, last);
        }
        count -= 1;
        continue;
      }
      lives[index] = life;
      const offset = index * 3;
      positions[offset] =
        boundedValue(positions, offset) +
        boundedValue(velocities, offset) * safeDt;
      positions[offset + 1] =
        boundedValue(positions, offset + 1) +
        boundedValue(velocities, offset + 1) * safeDt;
      positions[offset + 2] =
        boundedValue(positions, offset + 2) +
        boundedValue(velocities, offset + 2) * safeDt;
      velocities[offset + 1] =
        boundedValue(velocities, offset + 1) - 2.4 * safeDt;
      index += 1;
    }
    geometry.setDrawRange(0, count);
    positionAttribute.needsUpdate = count > 0;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    root.remove(points);
    geometry.dispose();
    material.dispose();
  }

  return { collect, update, dispose };
}
